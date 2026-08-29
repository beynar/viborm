/**
 * The decimal-list container is written by the RUNTIME and read by the
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

import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import {
  mysqlDecimalListMarker,
  readMysqlDecimalListMarker,
} from "@src/migrations/decimal";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { ddlContext } from "@tests/unit/migrations/_estate";
import {
  canonicalizeDecimal,
  encodeDecimalListContainer,
} from "@validation/primitives/decimal-codec";
import { describe, expect, it } from "vitest";

const TABLE = "dec_list_agreement";

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

describe("MySQL: the marker recovers the descriptor the runtime encodes against", () => {
  it("emits the marker for a decimal list and only for one", () => {
    const ddl = mysqlMigrationDriver.generateDDL(
      {
        type: "alterColumn",
        tableName: "ledger",
        columnName: "samples",
        from: {
          name: "samples",
          type: "JSON",
          nullable: false,
          decimal: { precision: 10, scale: 2 },
        },
        to: {
          name: "samples",
          type: "JSON",
          nullable: false,
          decimal: { precision: 16, scale: 2 },
        },
      },
      ddlContext("artifact")
    );

    expect(ddl).toContain(
      `COMMENT '${mysqlDecimalListMarker({ precision: 16, scale: 2 })}'`
    );
    expect(
      readMysqlDecimalListMarker(
        mysqlDecimalListMarker({ precision: 16, scale: 2 })
      )
    ).toEqual({ precision: 16, scale: 2 });
  });

  it("recovers a domain the runtime encodes the same container at", () => {
    // The whole point of the marker: introspection has nothing else to read a
    // JSON column's scale from, and the scale is what turns `"120"` into 1.2.
    const recovered = readMysqlDecimalListMarker(
      mysqlDecimalListMarker({ precision: 18, scale: 4 })
    );
    expect(recovered).toBeDefined();
    expect(encodeDecimalListContainer(MEMBERS, recovered?.scale ?? 0)).toBe(
      encodeDecimalListContainer(MEMBERS, 4)
    );
  });

  it("reads nothing from a comment that is not the exact marker", () => {
    const real = mysqlDecimalListMarker({ precision: 16, scale: 2 });
    for (const impostor of [
      "",
      "viborm",
      `${real} `,
      ` ${real}`,
      real.replace("16", "17").slice(0, -1),
      real.toUpperCase(),
    ]) {
      expect(readMysqlDecimalListMarker(impostor)).toBeUndefined();
    }
  });

  it("declares the coefficient vocabulary its marker implies", () => {
    // A JSON column cannot hold an exact decimal, so the runtime spells the
    // members as coefficients — and the marker is what says at which scale.
    expect(new MySQLAdapter().result.decimalListRepresentation).toBe(
      "coefficient"
    );
  });
});

describe("PostgreSQL: the array typmod is the descriptor", () => {
  it("stores the members as column values, with no container between them", async () => {
    const database = new PGlite();
    const driver = new PGliteDriver({ client: database });
    const client = createClient({ schema: listLedger(16, 2), driver });
    await push(client, { force: true });

    await client.ledger.create({ data: { id: "a", samples: MEMBERS } });

    const stored = await driver._executeRaw<{ format_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = '${TABLE}' AND a.attname = 'samples'`
    );
    expect(stored.rows[0]?.format_type).toBe("numeric(16,2)[]");

    const members = await driver._executeRaw<{ samples: unknown }>(
      `SELECT "samples" FROM "${TABLE}" WHERE "id" = 'a'`
    );
    // Every member is its own exact value, not a document to parse.
    expect(members.rows[0]?.samples).toEqual([
      "1.20",
      "-0.03",
      "90071992547409.93",
    ]);

    await client.$disconnect();
  });
});
