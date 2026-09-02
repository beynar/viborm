/**
 * Live provider proof that the decimal-list container is written by the RUNTIME and read by the
 * MIGRATION layer, and the two have to agree byte for byte.
 *
 * They are separate owners of one physical fact. The query engine writes the
 * container through the codec (`encodeDecimalListContainer`, spelled by the
 * adapter's array parameter); the migration layer validates it with a CHECK, a
 * marker or a typmod, and rewrites its members inside SQL when the descriptor
 * moves. Neither can see the other's spelling, so an agreement that holds only
 * by construction is one refactor away from a container that stores fine and
 * converts to the sentinel.
 *
 * Three claims, one per provider family:
 *
 *  - SQLite — a container written by the CLIENT satisfies the reserved CHECK,
 *    the conversion expression rewrites the very bytes the client wrote, and
 *    what the conversion writes back is byte-identical to what the client would
 *    have written for the new domain;
 *  - MySQL — the deterministic column-comment marker recovers exactly the
 *    descriptor the runtime encodes against, and only that marker does; and
 *  - PostgreSQL — the array typmod is the descriptor, so the runtime's members
 *    are the column's own values with no container in between.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import {
  canonicalizeDecimal,
  encodeDecimalListContainer,
} from "@validation/primitives/decimal-codec";
import { describe, expect, it } from "vitest";

const TABLE = "dec_list_agreement";

/**
 * The PostgreSQL leg answers from the worker's ONE PGlite through this suite's
 * own private schema. The family is given no models: the push below is the
 * thing under test, so it still creates the table itself — inside
 * `family.namespace`, which every raw statement here has to name because raw
 * SQL is sent verbatim.
 */
const getFamily = usePGliteSchemaFamily({});

const listLedger = (precision: number, scale: number) => ({
  ledger: s
    .model({
      id: s.string().id(),
      samples: s.decimal({ precision, scale }).array(),
    })
    .map(TABLE),
});

/** The logical members every leg below round-trips. */
const MEMBERS = ["1.2", "-0.03", "90071992547409.93"];

async function storedContainer(driver: {
  _executeRaw: <T>(sql: string) => Promise<{ rows: T[] }>;
}): Promise<unknown> {
  const rows = await driver._executeRaw<{ samples: unknown }>(
    `SELECT "samples" FROM "${TABLE}" WHERE "id" = 'a'`
  );
  return rows.rows[0]?.samples;
}

/**
 * The members the CONVERSION leg uses.
 *
 * Smaller than {@link MEMBERS} for a reason SQLite states itself: a scale
 * increase multiplies every coefficient, and `precision + scale <= 18` has to
 * hold on BOTH sides of the change, so a member whose coefficient already needs
 * sixteen digits has no wider domain to move into on this provider.
 */
const CONVERTIBLE = ["1.2", "-0.03"];

describe("SQLite: the runtime container is the one the migration layer reads", () => {
  it("writes exactly the bytes the codec spells", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: listLedger(16, 2), driver });
    await push(client, { force: true });

    await client.ledger.create({ data: { id: "a", samples: MEMBERS } });

    // The client's own bytes ARE the codec's container. The reserved CHECK
    // proves only that the column holds a JSON array, so the spelling — a
    // coefficient STRING per member, including one past 2^53 — is asserted
    // outright rather than inferred from the INSERT succeeding.
    expect(await storedContainer(driver)).toBe(
      encodeDecimalListContainer(MEMBERS, 2)
    );

    await client.$disconnect();
  });

  it("hands the conversion bytes its member grammar accepts", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: listLedger(10, 2), driver });
    await push(client, { force: true });
    await client.ledger.create({ data: { id: "a", samples: CONVERTIBLE } });

    // A scale increase multiplies every member, so a spelling the SQL grammar
    // refused would route the whole column to the sentinel and fail the push.
    const widened = createClient({ schema: listLedger(12, 4), driver });
    await push(widened, { force: true });

    // What the conversion wrote back is byte-identical to what the client would
    // write for the NEW domain — `json_group_array` of text members against
    // `JSON.stringify` of the same members.
    expect(await storedContainer(driver)).toBe(
      encodeDecimalListContainer(CONVERTIBLE, 4)
    );

    // And the runtime reads it back as the same logical list.
    const found = await widened.ledger.findUnique({ where: { id: "a" } });
    expect(found?.samples.map((member) => canonicalizeDecimal(member))).toEqual(
      CONVERTIBLE
    );

    await widened.$disconnect();
  });

  it("refuses a container the runtime never wrote, rather than converting it", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: listLedger(10, 2), driver });
    await push(client, { force: true });

    // A JSON numeric token: valid JSON, a valid array, and NOT the coefficient
    // grammar. The CHECK admits it (it proves the container's shape, not its
    // members) and the conversion is what refuses it.
    await driver._executeRaw(
      `INSERT INTO "${TABLE}" ("id","samples") VALUES ('a', '[120]')`
    );

    const widened = createClient({ schema: listLedger(12, 4), driver });
    await expect(push(widened, { force: true })).rejects.toThrow();

    // The estate survives the refusal untouched.
    expect(await storedContainer(driver)).toBe("[120]");
    await widened.$disconnect();
  });
});

describe("PostgreSQL: the array typmod is the descriptor", () => {
  it("stores the members as column values, with no container between them", async () => {
    const family = getFamily();
    const driver = new PGliteDriver({
      client: family.database,
      namespace: family.namespace,
    });
    const client = createClient({ schema: listLedger(16, 2), driver });
    await push(client, { force: true });

    await client.ledger.create({ data: { id: "a", samples: MEMBERS } });

    // The catalog spans every schema in the shared database, so the suite's own
    // namespace is part of the identity of the column being read.
    const stored = await driver._executeRaw<{ format_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${family.namespace}'
          AND c.relname = '${TABLE}' AND a.attname = 'samples'`
    );
    expect(stored.rows[0]?.format_type).toBe("numeric(16,2)[]");

    const members = await driver._executeRaw<{ samples: unknown }>(
      `SELECT "samples" FROM "${family.namespace}"."${TABLE}" WHERE "id" = 'a'`
    );
    // Every member is its own exact value, not a document to parse.
    expect(members.rows[0]?.samples).toEqual([
      "1.20",
      "-0.03",
      "90071992547409.93",
    ]);

    // The shared family owns the database; disconnecting releases only this
    // driver.
    await client.$disconnect();
  });
});
