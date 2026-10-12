/**
 * T5b on live PostgreSQL (PGlite): with `generate({ lowLock: true })`, a
 * change that builds an index on, or adds a foreign key to, a table that
 * already holds rows is published as
 * states whose commits each do one low-lock thing, and an interruption of any
 * of them leaves a state the marker names or one unfinished single-step
 * attempt that `resolve` settles either way.
 *
 * Realistic scale: a fifteen-field `accounts` table holding 100,000 rows. Each
 * scenario has its own schema in one database, and reads the statement stream
 * PGlite receives: every statement reaches `execProtocolStream`, where a Parse
 * or simple Query message carries its text.
 */

import type { Schema } from "@client/types";
import { createClient } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { beforeAll, describe, expect, it } from "vitest";

const ROWS = 100_000;
const BEGIN = /^BEGIN\b/;
const END = /^(COMMIT|ROLLBACK)\b/;
const BUILD = /^CREATE (UNIQUE )?INDEX/;
const CONCURRENT_BUILD = /^CREATE (UNIQUE )?INDEX CONCURRENTLY /;
const ADD_KEY = /ADD CONSTRAINT "accounts_orgId_fkey" FOREIGN KEY/;
const VALIDATE = /VALIDATE CONSTRAINT "accounts_orgId_fkey"$/;
const NICKNAME = /ADD COLUMN "nickname"/;
const NOT_VALID = / NOT VALID$/;

const fields = () => ({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string(),
  status: s.enum(["trial", "active", "churned"]).default("trial"),
  balance: s.int().default(0),
  score: s.number().nullable(),
  settings: s.json().nullable(),
  country: s.string().default("FR"),
  age: s.int().nullable(),
  verified: s.boolean().default(false),
  notes: s.string().nullable(),
  orgId: s.string().nullable(),
  deletedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});

/**
 * `orgs` and `accounts`; `linked` adds the account → org key (and the index
 * on `orgId` the relation declares), `indexed` an index on `country`
 * (`"unique"` on `country, name`), `nickname` one more column. `.index` needs
 * a model of one fixed shape, so an indexed `accounts` always has `nickname`,
 * and the key unless the index is unique.
 */
function schemaWith(
  options: {
    linked?: boolean;
    indexed?: boolean | "unique";
    nickname?: boolean;
  } = {}
): Schema {
  const org = s
    .model({
      id: s.string().id(),
      name: s.string(),
      ...(options.linked ? { accounts: s.toMany(() => account) } : {}),
    })
    .map("orgs");
  const relation = () =>
    s
      .toOne(() => org)
      .fields("orgId")
      .references("id");
  const nickname = s.string().nullable();
  const model = s.model({
    ...fields(),
    ...(options.nickname ? { nickname } : {}),
    ...(options.linked ? { org: relation() } : {}),
  });
  const account = (() => {
    if (options.indexed === "unique") {
      return s
        .model({ ...fields(), nickname })
        .index(["country", "name"], { unique: true });
    }
    if (options.indexed) {
      return s
        .model({ ...fields(), nickname, org: relation() })
        .index(["country"]);
    }
    return model;
  })().map("accounts");
  return { org, account };
}

const database: PGlite = openTestPGlite();
const decoder = new TextDecoder();
let namespaces = 0;

beforeAll(() => database.waitReady);

/** Every statement `command` sends, whitespace-collapsed, in order. */
async function record(command: () => Promise<unknown>) {
  const send = database.execProtocolStream;
  const statements: string[] = [];
  database.execProtocolStream = (message, options) => {
    if (message[0] === 0x50 || message[0] === 0x51) {
      const start = message[0] === 0x50 ? message.indexOf(0, 5) + 1 : 5;
      const text = decoder.decode(
        message.subarray(start, message.indexOf(0, start))
      );
      statements.push(text.replace(/\s+/g, " ").trim());
    }
    return send.call(database, message, options);
  };
  let failure: unknown;
  try {
    await command();
  } catch (error) {
    failure = error;
  } finally {
    database.execProtocolStream = send;
  }
  return { statements, failure };
}

/** The transaction each statement runs in, or null in autocommit. */
function transactionOf(statements: readonly string[]) {
  let current: number | null = null;
  let count = 0;
  return statements.map((statement) => {
    if (BEGIN.test(statement)) {
      count += 1;
      current = count;
    }
    const inside = current;
    if (END.test(statement)) current = null;
    return inside;
  });
}

/** A fresh schema holding `orgs` (50 rows) and 100,000 `accounts`. */
async function seeded(orgIdOf = "'org-' || (1 + g % 50)") {
  namespaces += 1;
  const namespace = `t5b_${namespaces}`;
  await database.exec(`CREATE SCHEMA "${namespace}"`);
  const storage = new MemoryEstateStorage();
  const migrationsFor = (options: Parameters<typeof schemaWith>[0]) =>
    createMigrationClient(
      createClient({
        client: database,
        schema: schemaWith(options),
        namespace,
      }),
      { storage }
    );
  const first = migrationsFor({});
  await first.generate({ name: "v1" });
  await first.apply();
  await database.exec(
    `INSERT INTO "${namespace}"."orgs" ("id", "name") SELECT 'org-' || g, 'Org ' || g FROM generate_series(1, 50) g;
     INSERT INTO "${namespace}"."accounts" ("id", "email", "name", "settings", "orgId", "updatedAt")
     SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || (g % ${ROWS / 2}), '{"plan":"pro"}'::jsonb, ${orgIdOf}, now()
     FROM generate_series(1, ${ROWS}) g;
     ANALYZE "${namespace}"."accounts";`
  );
  const names = async () =>
    new Map(
      (await first.list()).map(({ stateId, name }) => [stateId, name] as const)
    );
  const markerName = async () =>
    (await names()).get((await first.status()).marker?.stateId ?? "");
  const query = async <T>(text: string) =>
    (await database.query<T>(text.replaceAll("$ns", namespace))).rows;
  return { namespace, migrationsFor, names, markerName, query };
}

describe("a generated index and foreign key on a 100,000-row table", () => {
  it("are published as states that each commit one low-lock step", async () => {
    const { migrationsFor, names, query } = await seeded();
    // The planner's estimate the default largeTableRows (1,000,000) refuses
    // a blocking change above: none of these steps is one.
    await query(
      `UPDATE pg_catalog.pg_class SET reltuples = 20000000 WHERE oid = '"$ns"."accounts"'::regclass`
    );
    const migrations = migrationsFor({
      linked: true,
      indexed: true,
      nickname: true,
    });
    const generated = await migrations.generate({ name: "v2", lowLock: true });
    expect([...(await names()).values()].sort()).toEqual([
      "v1",
      "v2",
      "v2 (step 1 of 5)",
      "v2 (step 2 of 5)",
      "v2 (step 3 of 5)",
      "v2 (step 4 of 5)",
    ]);
    expect((await migrations.status()).pending.at(-1)).toBe(generated.stateId);

    const { statements, failure } = await record(() => migrations.apply());
    expect(failure).toBeUndefined();
    const inside = transactionOf(statements);
    const at = (pattern: RegExp) =>
      statements.findIndex((statement) => pattern.test(statement));
    // Every index build runs CONCURRENTLY, outside any transaction.
    const builds = statements.flatMap((statement, index) =>
      BUILD.test(statement) ? [{ statement, inside: inside[index] }] : []
    );
    expect(builds).toHaveLength(2);
    for (const build of builds) {
      expect(build.statement).toMatch(CONCURRENT_BUILD);
      expect(build.inside).toBeNull();
    }
    // The key is added NOT VALID, and validated by a commit of its own.
    const add = at(ADD_KEY);
    const validate = at(VALIDATE);
    expect(statements[add]).toMatch(NOT_VALID);
    expect(inside[add]).not.toBeNull();
    expect(validate).toBeGreaterThan(add);
    expect(inside[validate]).not.toBeNull();
    expect(inside[validate]).not.toBe(inside[add]);
    // The plain column change keeps its transaction, before the first build.
    expect(inside[at(NICKNAME)]).not.toBeNull();
    expect(at(NICKNAME)).toBeLessThan(at(CONCURRENT_BUILD));

    expect((await migrations.status()).marker?.stateId).toBe(generated.stateId);
    expect(
      await query<{ valid: boolean }>(
        `SELECT bool_and(x.indisvalid) AS valid FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class t ON t.oid = x.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = '$ns'`
      )
    ).toEqual([{ valid: true }]);
    expect(
      await query(
        `SELECT convalidated FROM pg_catalog.pg_constraint WHERE conname = 'accounts_orgId_fkey' AND connamespace = '$ns'::regnamespace`
      )
    ).toEqual([{ convalidated: true }]);
    await expect(migrations.verify()).resolves.toMatchObject({ ok: true });
  });

  it("an interrupted index build resolves either way, and apply resumes", async () => {
    const { migrationsFor, names, markerName, query } = await seeded();
    // Every name appears twice, so the unique build fails half-way through.
    const migrations = migrationsFor({ indexed: "unique", nickname: true });
    await migrations.generate({ name: "v2", lowLock: true });
    expect([...(await names()).values()].sort()).toEqual([
      "v1",
      "v2",
      "v2 (step 1 of 2)",
    ]);
    await expect(migrations.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
    });
    // The column committed with its own state; the build left an INVALID index.
    expect(await markerName()).toBe("v2 (step 1 of 2)");
    expect(await migrations.status()).toMatchObject({
      unfinished: true,
      invalidIndexes: [
        { table: "accounts", index: "accounts_country_name_idx" },
      ],
    });

    await expect(
      migrations.resolve({ outcome: "rolled-back" })
    ).resolves.toEqual({ outcome: "rolled-back" });
    expect(await migrations.status()).toMatchObject({ unfinished: false });
    expect(await markerName()).toBe("v2 (step 1 of 2)");
    expect(
      await query(
        `SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'accounts_country_name_idx' AND relnamespace = '$ns'::regnamespace`
      )
    ).toEqual([]);

    // Interrupted again, then completed once the data allows it.
    await expect(migrations.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
    });
    await query(`UPDATE "$ns"."accounts" SET "name" = "id"`);
    await expect(migrations.resolve({ outcome: "complete" })).resolves.toEqual({
      outcome: "complete",
    });
    expect(await markerName()).toBe("v2");
    expect(await migrations.status()).toMatchObject({ unfinished: false });
    expect(await migrations.status()).not.toHaveProperty("invalidIndexes");
    await expect(migrations.verify()).resolves.toMatchObject({ ok: true });

    // And the rolled-back path: down to the column, then apply rebuilds.
    await expect(migrations.down({ steps: 1 })).resolves.toMatchObject({
      preview: false,
    });
    expect(await markerName()).toBe("v2 (step 1 of 2)");
    await expect(migrations.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    expect(await markerName()).toBe("v2");
  });

  it("a failed validation rolls back alone, and apply resumes from the marker", async () => {
    // One account in a thousand names an org that does not exist.
    const { migrationsFor, markerName, query } = await seeded(
      "CASE WHEN g % 1000 = 0 THEN 'org-gone' ELSE 'org-' || (1 + g % 50) END"
    );
    const migrations = migrationsFor({ linked: true });
    await migrations.generate({ name: "v2", lowLock: true });
    const convalidated = () =>
      query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_catalog.pg_constraint WHERE conname = 'accounts_orgId_fkey' AND connamespace = '$ns'::regnamespace`
      );

    await expect(migrations.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      meta: { providerSqlState: "23503" },
    });
    // Nothing is left unfinished: the key stands NOT VALID, which its state
    // declares, and the failed validation is on record.
    expect(await markerName()).toBe("v2 (step 2 of 3)");
    expect(await migrations.status()).toMatchObject({
      unfinished: false,
      lastFailure: { kind: "failed" },
    });
    expect(await convalidated()).toEqual([{ convalidated: false }]);

    await query(
      `UPDATE "$ns"."accounts" SET "orgId" = NULL WHERE "orgId" = 'org-gone'`
    );
    await expect(migrations.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    expect(await markerName()).toBe("v2");
    expect(await convalidated()).toEqual([{ convalidated: true }]);

    // Undoing the validation is nothing; undoing the addition drops the key.
    await migrations.down({ steps: 1 });
    expect(await markerName()).toBe("v2 (step 2 of 3)");
    expect(await convalidated()).toEqual([{ convalidated: true }]);
    await migrations.down({ steps: 1 });
    expect(await convalidated()).toEqual([]);
  });

  it("push, which has no history to split a key into, refuses it and names the step form", async () => {
    namespaces += 1;
    const namespace = `t5b_${namespaces}`;
    await database.exec(`CREATE SCHEMA "${namespace}"`);
    const live = (linked: boolean) =>
      createMigrationClient(
        createClient({
          client: database,
          schema: schemaWith({ linked }),
          namespace,
        }),
        { limits: { largeTableRows: ROWS / 2 } }
      );
    await live(false).push();
    await database.exec(
      `INSERT INTO "${namespace}"."accounts" ("id", "email", "name", "updatedAt")
       SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || g, now() FROM generate_series(1, ${ROWS}) g;
       ANALYZE "${namespace}"."accounts";`
    );
    await expect(live(true).push({ dryRun: true })).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { operation: "FOREIGN KEY validation" },
      message: expect.stringContaining(
        "Or add the constraint NOT VALID and validate it (VALIDATE CONSTRAINT) in a later migration: neither step blocks writes. generate({ lowLock: true }) does this for foreign keys."
      ),
    });
  });
});
