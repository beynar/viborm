/**
 * S7 on live PostgreSQL (PGlite): an interrupted `CREATE INDEX CONCURRENTLY`.
 *
 * The interruption is real, never a catalog edit: a stepwise manual transition
 * builds a UNIQUE index CONCURRENTLY over 10,000 rows that hold duplicates, so
 * PostgreSQL fails the build and leaves the index behind with
 * `indisvalid = false`. Before 1.2.0 that one index made every command throw
 * V8001, because authenticating the control tables introspected — and refused —
 * every managed table. Now the control plane stays readable, `status()` names
 * the index, the commands that compare live schema refuse with V11023 naming
 * it, and `resolve()` repairs it towards the outcome it proves.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { s } from "@schema";
import { sql } from "@sql";
import { indexExistsProbe } from "@src/migrations/catalog-probes";
import { getMigrationDriver } from "@src/migrations/drivers";
import type { AnyModel } from "@src/schema/model";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./_estate";

const ROWS = 10_000;
const CONSTRAINT = "accounts_country_name_key";
const UNIQUE_INDEX = "accounts_country_name_idx";

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
  lastSeenAt: s.dateTime().nullable(),
  deletedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});

const origin = { account: s.model(fields()).map("accounts") };

const trustedRead = (text: string) => ({
  kind: "trusted-read" as const,
  query: sql.raw(text),
  equals: true,
});

function migrationsFor(
  driver: AnyDriver,
  schema: Record<string, AnyModel>,
  storage: MemoryStorage
) {
  return createMigrationClient(createClient({ driver, schema }), { storage });
}

/** Every name twice, so a unique build over (country, name) fails. */
async function seedDuplicates(driver: AnyDriver) {
  await driver._executeRaw(
    `INSERT INTO "accounts" ("id", "email", "name", "settings", "updatedAt")
     SELECT 'acct-' || g, 'user' || g || '@example.com', 'name-' || (g % ${ROWS / 2}), '{"plan":"pro"}'::jsonb, now()
     FROM generate_series(1, ${ROWS}) g`
  );
}

async function invalidIndexes(driver: AnyDriver) {
  const result = await driver._executeRaw<{ name: string }>(
    "SELECT c.relname AS name FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid WHERE NOT i.indisvalid ORDER BY 1"
  );
  return result.rows.map((row) => row.name);
}

/**
 * v1 applied, then a v2 whose one manual stepwise transition builds the index
 * CONCURRENTLY first. Applying v2 fails inside that dispatch; the failure is
 * returned for the test to assert.
 */
async function interruptedBuild(
  target: Record<string, AnyModel>,
  up: readonly string[],
  destinationCheck: string
) {
  const driver = createInMemoryPGliteDriver();
  const storage = new MemoryStorage();
  const first = migrationsFor(driver, origin, storage);
  const root = await first.generate({ name: "v1" });
  await first.apply();
  await seedDuplicates(driver);
  const second = migrationsFor(driver, target, storage);
  await second.generate({
    name: "v2",
    manualMigration: {
      transitions: [
        {
          from: root.stateId,
          execution: "stepwise",
          originChecks: [
            trustedRead(
              `SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname IN ('${CONSTRAINT}', '${UNIQUE_INDEX}')) AS ok`
            ),
          ],
          up: up.map((text) => sql.raw(text)),
          rollback: { kind: "irreversible", reason: "test transition" },
        },
      ],
      destinationChecks: [trustedRead(destinationCheck)],
    },
  });
  const interrupted = await second.apply().then(
    () => undefined,
    (failure: unknown) => failure
  );
  return { driver, migrations: second, interrupted };
}

describe("an interrupted CREATE INDEX CONCURRENTLY", () => {
  it("keeps status and log readable, refuses with V11023, and resolve drops the remnant", async () => {
    const { driver, migrations, interrupted } = await interruptedBuild(
      {
        account: s.model(fields()).unique(["country", "name"]).map("accounts"),
      },
      [
        `CREATE UNIQUE INDEX CONCURRENTLY "${CONSTRAINT}" ON "public"."accounts" ("country", "name")`,
        `ALTER TABLE "public"."accounts" ADD CONSTRAINT "${CONSTRAINT}" UNIQUE USING INDEX "${CONSTRAINT}"`,
      ],
      `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = '${CONSTRAINT}') AS ok`
    );
    try {
      expect(interrupted).toMatchObject({
        code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
      });
      expect(await invalidIndexes(driver)).toEqual([CONSTRAINT]);

      const status = await migrations.status();
      expect(status).toMatchObject({
        control: "present",
        unfinished: true,
        invalidIndexes: [{ table: "accounts", index: CONSTRAINT }],
      });
      expect((await migrations.log()).map((event) => event.kind)).toContain(
        "started"
      );

      const named = {
        code: VibORMErrorCode.MIGRATION_INVALID_INDEX,
        message: expect.stringContaining(`accounts.${CONSTRAINT}" is INVALID`),
        meta: { table: "accounts", indexName: CONSTRAINT },
      };
      await expect(migrations.verify()).rejects.toMatchObject(named);
      await expect(migrations.push({ dryRun: true })).rejects.toMatchObject(
        named
      );

      // A valid index of that name is what the destination needs; an invalid
      // one is not "present" to a generated postcondition, and is not absent.
      const pg = getMigrationDriver(driver);
      for (const exists of [true, false]) {
        const probe = indexExistsProbe(pg, "accounts", CONSTRAINT, exists);
        const result = await driver._executeRaw<{ exists: boolean }>(
          probe.sql,
          probe.parameters.map((parameter) =>
            parameter.kind === "string" ? parameter.value : null
          )
        );
        expect(result.rows[0]?.exists).toBe(!exists);
      }

      // An invalid index the attempt never named — another session's build —
      // is not resolve's to drop: the proof refuses on it, naming it.
      const STRANGER = "accounts_name_idx";
      await expect(
        driver._executeRaw(
          `CREATE UNIQUE INDEX CONCURRENTLY "${STRANGER}" ON "accounts" ("name")`
        )
      ).rejects.toThrow();
      await expect(
        migrations.resolve({ outcome: "rolled-back" })
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_INDEX,
        meta: { table: "accounts", indexName: STRANGER },
      });
      expect(await invalidIndexes(driver)).toEqual([STRANGER]);
      await driver._executeRaw(`DROP INDEX CONCURRENTLY "${STRANGER}"`);

      await expect(
        migrations.resolve({ outcome: "rolled-back" })
      ).resolves.toEqual({ outcome: "rolled-back" });
      expect(await invalidIndexes(driver)).toEqual([]);
      const after = await migrations.status();
      expect(after.unfinished).toBe(false);
      expect(after).not.toHaveProperty("invalidIndexes");
      // The data the build failed on is untouched.
      const rows = await driver._executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM "accounts"`
      );
      expect(rows.rows[0]?.n).toBe(ROWS);
    } finally {
      await driver.disconnect();
    }
  });

  it("rebuilds an index the destination declares once the data allows it", async () => {
    const { driver, migrations, interrupted } = await interruptedBuild(
      {
        account: s
          .model(fields())
          .index(["country", "name"], { name: UNIQUE_INDEX, unique: true })
          .map("accounts"),
      },
      [
        `CREATE UNIQUE INDEX CONCURRENTLY "${UNIQUE_INDEX}" ON "public"."accounts" ("country", "name")`,
      ],
      `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid WHERE c.relname = '${UNIQUE_INDEX}' AND i.indisvalid) AS ok`
    );
    try {
      expect(interrupted).toMatchObject({
        code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
      });
      expect(await invalidIndexes(driver)).toEqual([UNIQUE_INDEX]);
      // The operator removes the duplicates the build failed on.
      await driver._executeRaw(
        `DELETE FROM "accounts" WHERE "id" IN (SELECT 'acct-' || g FROM generate_series(${ROWS / 2 + 1}, ${ROWS}) g)`
      );
      await expect(
        migrations.resolve({ outcome: "complete" })
      ).resolves.toEqual({ outcome: "complete" });
      expect(await invalidIndexes(driver)).toEqual([]);
      const status = await migrations.status();
      expect(status).toMatchObject({ unfinished: false, pending: [] });
      await expect(migrations.verify()).resolves.toEqual({ ok: true });
    } finally {
      await driver.disconnect();
    }
  });
});

describe("control-table authentication reads only the control tables", () => {
  it("keeps status and log working beside an index no declaration can represent", async () => {
    const driver = createInMemorySQLite3Driver();
    try {
      const storage = new MemoryStorage();
      const sqliteOrigin = {
        account: s
          .model({ id: s.string().id(), email: s.string() })
          .map("accounts"),
      };
      const migrations = migrationsFor(driver, sqliteOrigin, storage);
      await migrations.generate({ name: "v1" });
      await migrations.apply();
      await driver._executeRaw(
        `CREATE INDEX "accounts_lower_email" ON "accounts" (lower("email"))`
      );
      await expect(migrations.status()).resolves.toMatchObject({
        control: "present",
        pending: [],
        unfinished: false,
      });
      expect((await migrations.log()).map((event) => event.kind)).toContain(
        "applied"
      );
      // Commands that compare the live schema still refuse it.
      await expect(migrations.verify()).rejects.toMatchObject({
        code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      });
    } finally {
      await driver.disconnect();
    }
  });
});
