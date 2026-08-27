/**
 * Read-only applied state.
 *
 * `status()`, `pending()` and every dry decision used to reach applied state
 * through a read that CREATED the tracking table, and swallowed every failure
 * as "nothing applied". Both are gone: one reader, no write, and only the exact
 * missing-tracking-table condition means empty.
 */

import { createClient } from "@client/client";
import { QueryError } from "@errors";
import { apply, generate, pending, status } from "@migrations";
import { MigrationContext } from "@migrations/context";
import type { MigrationClient } from "@migrations/push";
import type { MigrationJournal, MigrationTarget } from "@migrations/types";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  mysqlEstateDriver,
  pgEstateDriver,
  type RecordingDriver,
  sqliteEstateDriver,
} from "./_estate";

const schema = {
  user: s.model({
    id: s.string().id(),
    email: s.string().unique(),
  }),
};

const ALPHA: MigrationTarget = { dialect: "postgresql", namespace: "alpha" };

function clientFor(driver: RecordingDriver): MigrationClient {
  return { $driver: driver, $schema: schema };
}

async function estateWithOneEntry(storage: MemoryStorage): Promise<void> {
  const journal: MigrationJournal = {
    version: "3",
    target: ALPHA,
    entries: [
      {
        idx: 0,
        version: "20240101000000",
        name: "init",
        when: 1,
        checksum: "checksum-init",
        mode: "generated",
        rollback: { kind: "automatic" },
      },
    ],
  };
  await storage.writeJournal(journal);
}

/**
 * A normalized provider failure, in the only shape a translation ever sees.
 *
 * VibORM redacts provider message text when it normalizes a driver error, so
 * `meta.providerCode` — the SQLSTATE — is the single surviving provider detail
 * (`src/errors/diagnostics.ts`).
 */
function providerFailure(providerCode: string): QueryError {
  return new QueryError("Underlying error details redacted", {
    meta: { providerCode },
  });
}

/**
 * The same thing on the MySQL family's own channels.
 *
 * MySQL's identity does NOT survive on `providerCode`: mysql2 reports
 * `code: "ER_NO_SUCH_TABLE"`, which is not on the safe-metadata code allowlist
 * and is dropped. What survives is the errno and the SQLSTATE. Verified live
 * against MySQL 8 — a `SELECT` on an absent table normalizes to exactly
 * `{ driver, operation, providerErrno: 1146, providerSqlState: "42S02" }`.
 */
function mysqlProviderFailure(meta: {
  providerErrno?: number;
  providerSqlState?: string;
}): QueryError {
  return new QueryError("Underlying error details redacted", { meta });
}

/**
 * A PostgreSQL estate whose schema exists.
 *
 * The applied-state reader proves the namespace before it reads, so a driver
 * that answers nothing at all now refuses at the proof and never reaches the
 * question these tests are about. Answering the proof — and only the proof —
 * is what puts the SELECT back in front of them.
 */
function respondToNamespaceProof(sql: string): unknown[] | Error {
  return sql.includes("pg_namespace") ? [{ present: 1 }] : [];
}

describe("status/pending are SELECT-only", () => {
  it("never creates the tracking table", async () => {
    const driver = pgEstateDriver("alpha");
    const storage = new MemoryStorage();
    await estateWithOneEntry(storage);
    driver.respond = respondToNamespaceProof;

    await status(clientFor(driver), { storageDriver: storage });
    await pending(clientFor(driver), { storageDriver: storage });

    const executed = driver.statements.join("\n");
    expect(executed).toContain("SELECT name, checksum, applied_at");
    expect(executed).not.toContain("CREATE TABLE");
  });

  it("surfaces a tracking failure instead of reporting an empty estate", async () => {
    const driver = pgEstateDriver("alpha");
    const storage = new MemoryStorage();
    await estateWithOneEntry(storage);
    // A permission failure is not a missing table, and the base translation
    // refuses to call anything a missing table. The namespace proof passes, so
    // the failure under test is the tracking SELECT's own.
    driver.respond = (sql) =>
      sql.includes("pg_namespace")
        ? [{ present: 1 }]
        : new Error("permission denied for relation");

    // The previous behavior resolved to `[]` here — a permissions failure
    // reported as "no migrations applied". The provider error is normalized on
    // the way out, so the falsifier is that it FAILS at all rather than
    // answering with an estate.
    await expect(
      status(clientFor(driver), { storageDriver: storage })
    ).rejects.toThrow();
  });
});

describe("read-only tracking ledgers, per dialect", () => {
  it("distinguishes an absent tracking table with one exact sqlite_schema read", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema, driver });
    const storage = new MemoryStorage();

    try {
      await generate(client, { storageDriver: storage, name: "init" });

      // No tracking table exists yet: the probe answers, the SELECT never runs,
      // and nothing is created.
      const before = await status(client, { storageDriver: storage });
      expect(before.map((entry) => entry.applied)).toEqual([false]);
      await expect(
        driver._executeRaw("SELECT 1 FROM _viborm_migrations")
      ).rejects.toThrow();

      // After an admitted effectful apply, the same reader reports it applied.
      await apply(client, { storageDriver: storage });
      const after = await status(client, { storageDriver: storage });
      expect(after.map((entry) => entry.applied)).toEqual([true]);
    } finally {
      await driver.disconnect();
    }
  });

  it("reads the configured tracking name through a bound parameter", () => {
    const context = new MigrationContext(clientFor(sqliteEstateDriver()), {
      storageDriver: new MemoryStorage(),
      tableName: "custom_tracking",
    });
    expect(
      context.migrationDriver.generateTrackingTableProbe("custom_tracking")
    ).toEqual({
      sql: "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
      params: ["custom_tracking"],
    });
  });

  it("gives PostgreSQL no positive probe — it translates SQLSTATE 42P01 only", () => {
    const context = new MigrationContext(clientFor(pgEstateDriver("alpha")), {
      storageDriver: new MemoryStorage(),
    });
    const { migrationDriver } = context;
    expect(
      migrationDriver.generateTrackingTableProbe("_viborm_migrations")
    ).toBeNull();

    // The landed translation reads `meta.providerCode` and nothing else:
    // VibORM redacts provider message text when it normalizes an error, so the
    // failing relation's NAME is structurally unreachable and exactness comes
    // from the statement instead (plan §14, ruling N25).
    expect(
      migrationDriver.isMissingTrackingTable(
        providerFailure("42P01"),
        "_viborm_migrations"
      )
    ).toBe(true);

    // A neighbouring SQLSTATE is not a missing table, and neither is a failure
    // that carries no provider code at all: both surface rather than being
    // read as an empty estate.
    expect(
      migrationDriver.isMissingTrackingTable(
        providerFailure("42501"),
        "_viborm_migrations"
      )
    ).toBe(false);
    expect(
      migrationDriver.isMissingTrackingTable(
        new Error("relation does not exist"),
        "_viborm_migrations"
      )
    ).toBe(false);
  });

  it("gives MySQL no positive probe either — it translates 1146 and 42S02 only", () => {
    const context = new MigrationContext(
      clientFor(mysqlEstateDriver({ namespace: "billing", attested: true })),
      { storageDriver: new MemoryStorage() }
    );
    const { migrationDriver } = context;
    expect(
      migrationDriver.generateTrackingTableProbe("_viborm_migrations")
    ).toBeNull();

    // The shape a live mysql2 failure actually normalizes to.
    expect(
      migrationDriver.isMissingTrackingTable(
        mysqlProviderFailure({
          providerErrno: 1146,
          providerSqlState: "42S02",
        }),
        "_viborm_migrations"
      )
    ).toBe(true);

    // Neither channel subsumes the other, so each resolves on its own: a
    // transport that reports the errno without a SQLSTATE, and one that reports
    // the SQLSTATE without a numeric errno, both mean the same missing table.
    expect(
      migrationDriver.isMissingTrackingTable(
        mysqlProviderFailure({ providerErrno: 1146 }),
        "_viborm_migrations"
      )
    ).toBe(true);
    expect(
      migrationDriver.isMissingTrackingTable(
        mysqlProviderFailure({ providerSqlState: "42S02" }),
        "_viborm_migrations"
      )
    ).toBe(true);

    // The hazard the base class names: a too-broad mapping reports a
    // permissions or transport failure as "no migrations applied". 1045 is
    // access-denied, and an error carrying no provider evidence at all proves
    // nothing — both surface as themselves rather than as an empty estate.
    expect(
      migrationDriver.isMissingTrackingTable(
        mysqlProviderFailure({
          providerErrno: 1045,
          providerSqlState: "28000",
        }),
        "_viborm_migrations"
      )
    ).toBe(false);
    expect(
      migrationDriver.isMissingTrackingTable(
        new Error("Table 'billing._viborm_migrations' doesn't exist"),
        "_viborm_migrations"
      )
    ).toBe(false);
  });
});
