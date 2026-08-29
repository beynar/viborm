/**
 * Pinned migration sessions, lock proofs, destructive containment, and the
 * artifact execution-safety classifier.
 *
 * These are the falsifiers for §3.5, §5.3, §6.1 and §6.2. The claim under test
 * is physical, not textual: ONE connection acquires the lock, makes every
 * decision, executes every statement, and releases the lock — and when either
 * proof fails, that connection is destroyed rather than returned to a pool
 * holding a lock nobody owns.
 *
 * The rendering and control-flow halves are provider-free; the containment half
 * runs on PGlite, which is PostgreSQL, so `RESTRICT`, cross-schema dependants
 * and real transactional rollback behave as the server does.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@client/client";
import type { QueryExecutionContext } from "@drivers/driver";
import { NeonHTTPDriver } from "@drivers/neon-http";
import { PGliteDriver, type PGliteDriverOptions } from "@drivers/pglite";
import { PlanetScaleDriver } from "@drivers/planetscale";
import { readCleanupFailures } from "@drivers/shared";
import type { QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { VibORMErrorCode } from "@errors";
import { apply, down, pending, reset, squash, status } from "@migrations";
import { MigrationContext } from "@migrations/context";
import { getMigrationDriver } from "@migrations/drivers";
import {
  mysqlLockAnswer,
  mysqlMigrationLockName,
} from "@migrations/drivers/mysql/pinned-session";
import { introspect as introspectClient, push } from "@migrations/push";
import {
  assertArtifactExecutionSafe,
  needsEnumAdditionCommitBoundary,
  readExecutableStatements,
} from "@migrations/statement-safety";
import type { MigrationEntry, MigrationJournal } from "@migrations/types";
import { materializeDroppedTableForeignKeys } from "@migrations/utils";
import { s } from "@schema";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MemoryStorage,
  mysqlEstateDriver,
  pgEstateDriver,
  type RecordingDriver,
  sqliteEstateDriver,
} from "./_estate";

/** Refusal texts these controls pin, hoisted so no matcher builds one per call. */
const EXECUTION_BOUNDARY = /cannot execute inside the boundary/;
const ADVISORY_LOCK_STATE = /advisory-lock state/;
const TRANSACTION_BOUND = /transaction-bound/;
const UNPROVEN_RELEASE = /did not confirm the release/;
/** PGlite's own refusal, which is why two-phase commit has no live leg here. */
const PREPARED_TRANSACTIONS_DISABLED = /prepared transactions are disabled/;

/**
 * The sentence the shipped contract may not contain: manual SQL CANNOT end the
 * transaction, free the lock, or reframe the boundary.
 *
 * It is false, and the live control at the end of this file executes the
 * counter-example. A lexical scanner reads a dollar-quoted body as data —
 * which it must, or every ordinary `CREATE FUNCTION` is refused — and the
 * server RUNS that same body, so a trusted author reaches
 * `pg_advisory_unlock_all()` through `DO $$ … $$`, through a pre-existing
 * safe-named function, and through dynamic SQL. Every place a reader takes the
 * classifier's contract from has to say what the refusals actually buy.
 */
const CONFINEMENT_CLAIM =
  /cannot[^.]*?\b(?:terminate|reframe|end|release|free)\b[^.]*?\b(?:boundary|lock|scope)\b/i;

/** The honest scope those same places must state instead. */
const HONEST_SCOPE = /not a sandbox/i;

/** Every shipped text a reader takes the classifier's contract from. */
const CONTRACT_TEXTS = [
  "src/migrations/statement-safety.ts",
  "src/migrations/AGENTS.md",
  "docs/content/docs/drivers/namespaces.mdx",
];

// =============================================================================
// FIXTURES
// =============================================================================

const schema = {
  user: s.model({
    id: s.string().id(),
    email: s.string().unique(),
  }),
};

function clientFor(driver: RecordingDriver) {
  return { $driver: driver, $schema: schema };
}

function entry(idx: number, name: string): MigrationEntry {
  return {
    idx,
    version: "20240101000000",
    name,
    when: 1,
    checksum: `checksum-${name}`,
    mode: "generated",
    rollback: { kind: "automatic" },
  };
}

function journalFor(
  dialect: "postgresql" | "mysql",
  entries: MigrationEntry[] = []
): MigrationJournal {
  return {
    version: "3",
    target:
      dialect === "postgresql"
        ? { dialect: "postgresql", namespace: "alpha" }
        : { dialect: "mysql" },
    entries,
  };
}

async function seed(
  storage: MemoryStorage,
  journal: MigrationJournal
): Promise<void> {
  await storage.writeJournal(journal);
  storage.writes.length = 0;
  storage.reads.length = 0;
}

/**
 * The strict-mode answer every MySQL fixture owes the pinned session.
 *
 * `pinned-session.ts` PROVES the session's `sql_mode` before any DDL runs
 * (plan 3.3: a non-strict MySQL turns an out-of-range DECIMAL into a warning
 * and stores the clamped value), so a fixture that answers nothing is a server
 * that reports no strict mode — which the owner correctly refuses. Answering it
 * in one place keeps the fixtures modelling a real server rather than each
 * restating the proof.
 */
const STRICT_SESSION_MODE = "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION";

function sessionModeAnswer(sql: string): unknown[] | undefined {
  return sql.includes("@@SESSION.sql_mode")
    ? [{ sql_mode: STRICT_SESSION_MODE, server_version: "8.4.0" }]
    : undefined;
}

/** Answers the MySQL database proof so an admitted command reaches its point. */
function respondWithDatabase(namespace: string) {
  return (sql: string) =>
    sessionModeAnswer(sql) ??
    (sql.includes("SCHEMATA") ? [{ SCHEMA_NAME: namespace }] : []);
}

/** Answers the PostgreSQL schema proof, for the same reason. */
function respondWithSchema() {
  return (sql: string) =>
    sql.includes("pg_namespace") ? [{ present: 1 }] : [];
}

/**
 * A MySQL fixture that also REMEMBERS what apply() tracked.
 *
 * `apply()` rereads authoritative tracking state before every entry, so a
 * fixture that always answers "nothing applied" reports the entry it just
 * committed as still pending — which is exactly the condition the loop's own
 * guard refuses.
 */
function respondWithTracking(namespace: string) {
  const applied: Array<{ name: string; checksum: string; applied_at: number }> =
    [];
  return (sql: string, params: unknown[]) => {
    const mode = sessionModeAnswer(sql);
    if (mode) {
      return mode;
    }
    if (sql.includes("SCHEMATA")) {
      return [{ SCHEMA_NAME: namespace }];
    }
    return trackingAnswer(sql, params, applied);
  };
}

/** The same, answering PostgreSQL's schema proof instead. */
function respondWithSchemaTracking() {
  const applied: Array<{ name: string; checksum: string; applied_at: number }> =
    [];
  return (sql: string, params: unknown[]) => {
    if (sql.includes("pg_namespace")) {
      return [{ present: 1 }];
    }
    return trackingAnswer(sql, params, applied);
  };
}

/** The tracking half both fixtures share. */
function trackingAnswer(
  sql: string,
  params: unknown[],
  applied: Array<{ name: string; checksum: string; applied_at: number }>
): unknown[] {
  if (sql.startsWith("INSERT INTO")) {
    applied.push({
      name: String(params[0]),
      checksum: String(params[1]),
      applied_at: 1,
    });
    return [];
  }
  if (sql.includes("SELECT name, checksum, applied_at")) {
    return applied;
  }
  return [];
}

// =============================================================================
// ONE PHYSICAL PRODUCER — §3.5
// =============================================================================

describe("the pinned migration session is one physical producer", () => {
  it.each([
    "8.0.15",
    "10.11.9-MariaDB",
    undefined,
  ])("refuses MySQL version %s when enforced CHECK support is not proven", async (serverVersion) => {
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    driver.respond = (statement) =>
      statement.includes("@@SESSION.sql_mode")
        ? [
            {
              sql_mode: STRICT_SESSION_MODE,
              server_version: serverVersion,
            },
          ]
        : statement.includes("SCHEMATA")
          ? [{ SCHEMA_NAME: "alpha" }]
          : [];
    const ctx = new MigrationContext(clientFor(driver), {
      storageDriver: new MemoryStorage(),
    });

    await expect(
      ctx.withLockedSession(() => Promise.resolve())
    ).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      message: expect.stringContaining("8.0.16"),
      meta: { type: "unenforced-check-constraints" },
    });
  });

  it("admits MySQL 8.0.16, the first version that enforces CHECK", async () => {
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    driver.respond = (statement) =>
      statement.includes("@@SESSION.sql_mode")
        ? [{ sql_mode: STRICT_SESSION_MODE, server_version: "8.0.16" }]
        : statement.includes("SCHEMATA")
          ? [{ SCHEMA_NAME: "alpha" }]
          : [];
    const ctx = new MigrationContext(clientFor(driver), {
      storageDriver: new MemoryStorage(),
    });

    await expect(
      ctx.withLockedSession(() => Promise.resolve("ran"))
    ).resolves.toBe("ran");
  });

  it("refuses a strict-mode substring before the protected body", async () => {
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    driver.respond = (statement) =>
      statement.includes("@@SESSION.sql_mode")
        ? [
            {
              sql_mode: "NOT_STRICT_TRANS_TABLES",
              server_version: "8.4.0",
            },
          ]
        : statement.includes("SCHEMATA")
          ? [{ SCHEMA_NAME: "alpha" }]
          : [];
    const ctx = new MigrationContext(clientFor(driver), {
      storageDriver: new MemoryStorage(),
    });
    const protectedBody = vi.fn(() => Promise.resolve("ran"));

    await expect(ctx.withLockedSession(protectedBody)).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      meta: { type: "non-strict-sql-mode" },
    });
    expect(protectedBody).not.toHaveBeenCalled();
  });

  it("admits a trimmed exact STRICT_ALL_TABLES token", async () => {
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    driver.respond = (statement) =>
      statement.includes("@@SESSION.sql_mode")
        ? [
            {
              sql_mode: "NO_ENGINE_SUBSTITUTION, STRICT_ALL_TABLES ",
              server_version: "8.4.0",
            },
          ]
        : statement.includes("SCHEMATA")
          ? [{ SCHEMA_NAME: "alpha" }]
          : [];
    const ctx = new MigrationContext(clientFor(driver), {
      storageDriver: new MemoryStorage(),
    });

    await expect(
      ctx.withLockedSession(() => Promise.resolve("ran"))
    ).resolves.toBe("ran");
  });

  it("runs the lock, the reads and the unlock on the SAME producer", async () => {
    const driver = pgEstateDriver("alpha");
    driver.respond = respondWithSchema();
    const storage = new MemoryStorage();
    await seed(storage, journalFor("postgresql", [entry(0, "init")]));

    await down(clientFor(driver), { storageDriver: storage, steps: 1 });

    // The estate probe outside the lock runs on the base client; everything
    // from the acquisition onward runs on the reserved session.
    const lockIndex = driver.statements.findIndex((sql) =>
      sql.includes("pg_advisory_lock")
    );
    const unlockIndex = driver.statements.findIndex((sql) =>
      sql.includes("pg_advisory_unlock")
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(unlockIndex).toBeGreaterThan(lockIndex);

    const pinned = driver.producers.slice(lockIndex, unlockIndex + 1);
    expect(pinned.length).toBeGreaterThan(1);
    expect(new Set(pinned).size).toBe(1);
    // …and it is NOT the producer an ordinary statement would use.
    await driver._executeRaw("SELECT 1");
    expect(pinned[0]).not.toBe(driver.producers.at(-1));
    expect(driver.sessions).toEqual(["reserve", "release"]);
  });

  it("forwards the EXACT attestation to the pinned view and its transactions", async () => {
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    driver.respond = respondWithDatabase("alpha");
    const storage = new MemoryStorage();
    await seed(storage, journalFor("mysql"));

    const seen: Array<string | undefined> = [];
    const ctx = new MigrationContext(clientFor(driver), {
      storageDriver: storage,
    });
    await ctx.withLockedSession(async (locked) => {
      seen.push(locked.driver.migrationNamespaceAttestation);
      await locked.transaction((txCtx) => {
        seen.push(txCtx.driver.migrationNamespaceAttestation);
        return Promise.resolve();
      });
    });

    // N12: the pinned execution view is the last place the attestation had to
    // be forwarded, and it forwards the base fact rather than deriving one.
    expect(seen).toEqual(["non-redirecting", "non-redirecting"]);
    expect(driver.migrationNamespaceAttestation).toBe("non-redirecting");
  });

  it("destroys the producer when the protected body throws", async () => {
    const driver = pgEstateDriver("alpha");
    // The namespace proof runs on the producer as soon as the lock is held, so
    // a fixture that answers nothing refuses there and the body under test
    // never runs at all.
    driver.respond = respondWithSchema();
    const storage = new MemoryStorage();
    const ctx = new MigrationContext(clientFor(driver), {
      storageDriver: storage,
    });

    await expect(
      ctx.withLockedSession(() => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom");

    // The unlock is still attempted — the lock must not outlive the command —
    // and the producer is discarded rather than released, because a session
    // that failed mid-flight carries unknown state.
    expect(
      driver.statements.some((sql) => sql.includes("pg_advisory_unlock"))
    ).toBe(true);
    expect(driver.sessions).toEqual(["reserve", "destroy"]);
  });

  it("refuses to select a live target outside a pinned session", async () => {
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    const ctx = new MigrationContext(clientFor(driver), {
      storageDriver: new MemoryStorage(),
    });

    await expect(ctx.reassertMigrationTarget()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    expect(driver.statements).toEqual([]);
  });

  it("releases the lock when the post-acquisition proof fails", async () => {
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    // The database proof answers no rows: the configured database is not there.
    driver.respond = () => [];
    const ctx = new MigrationContext(clientFor(driver), {
      storageDriver: new MemoryStorage(),
    });

    await expect(
      ctx.withLockedSession(() => Promise.resolve(1))
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_INVALID_STATE });

    // §3.5's "unlocks through the same producer in `finally`" covers the proof
    // and the selection too: they run with the lock HELD, so a failure there
    // must not walk out of the session leaving a named lock behind.
    expect(driver.statements.some((sql) => sql.includes("GET_LOCK"))).toBe(
      true
    );
    expect(driver.statements.some((sql) => sql.includes("RELEASE_LOCK"))).toBe(
      true
    );
    // …and nothing was selected: the refusal precedes the first `USE`.
    expect(driver.statements.some((sql) => sql.startsWith("USE "))).toBe(false);
    expect(driver.sessions).toEqual(["reserve", "destroy"]);
  });

  it("refuses to reserve a SECOND session through a pinned view", async () => {
    const driver = pgEstateDriver("alpha");
    const capabilities: boolean[] = [];

    await driver._withPinnedSession(async (pinned) => {
      capabilities.push(pinned._canPinSession());
      // A nested reservation would take another connection — one that then
      // waits forever for the advisory lock this one holds. The view answers
      // the capability question honestly instead, so the refusal is typed and
      // immediate rather than a deadlock.
      await expect(
        pinned._withPinnedSession(() => Promise.resolve(1))
      ).rejects.toMatchObject({
        code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      });
    });

    expect(capabilities).toEqual([false]);
    // The driver itself is unchanged: only the view withdrew the hook.
    expect(driver._canPinSession()).toBe(true);
    expect(driver.sessions).toEqual(["reserve", "release"]);
  });
});

// =============================================================================
// COMMAND-LOCAL CATALOG SPELLING — §5.2
// =============================================================================

describe("a MySQL command renders from the spelling the server answered", () => {
  it("selects, tracks and inventories the server's own database name", async () => {
    // `lower_case_table_names` is why the proof accepts one case-folded match;
    // the server still answers to exactly one spelling, and it is this one.
    const driver = mysqlEstateDriver({ namespace: "Alpha", attested: true });
    driver.respond = respondWithDatabase("alpha");
    const ctx = new MigrationContext(clientFor(driver), {
      storageDriver: new MemoryStorage(),
    });

    const seen = await ctx.withLockedSession(async (locked) => {
      await locked.ensureTrackingTable();
      return {
        namespace: locked.migrationDriver.namespace,
        inventory: locked.migrationDriver.generateInventoryTables(),
      };
    });

    expect(seen.namespace).toBe("alpha");
    // The inventory decides what a reset DROPS, so binding the configured
    // spelling there reports an existing database as empty.
    expect(seen.inventory.params).toEqual(["alpha"]);
    expect(driver.statements).toContain("USE `alpha`");
    expect(
      driver.statements.some((sql) =>
        sql.includes("`alpha`.`_viborm_migrations`")
      )
    ).toBe(true);
    // The configured spelling reached the server only as BOUND catalog data,
    // never as an identifier a statement rendered.
    expect(driver.statements.some((sql) => sql.includes("Alpha"))).toBe(false);
    // …and the caller's own bound driver is untouched: the projection is
    // command-local and disappears with the session that resolved it.
    expect(ctx.migrationDriver.namespace).toBe("Alpha");
  });

  it("push renders its DDL and inventory from the resolved spelling", async () => {
    // push() owns no migration storage and reaches the producer directly, so
    // its locked bodies must consume the command view themselves — closing
    // over the outer bound driver would render the configured spelling.
    const driver = mysqlEstateDriver({ namespace: "Alpha", attested: true });
    driver.respond = respondWithDatabase("alpha");

    const result = await push(clientFor(driver), { force: true });

    expect(result.applied).toBe(true);
    expect(
      driver.statements.some(
        (sql) => sql.startsWith("CREATE TABLE") && sql.includes("`alpha`.")
      )
    ).toBe(true);
    expect(driver.statements.some((sql) => sql.includes("Alpha"))).toBe(false);
  });

  it("force-reset clears and rebuilds under the resolved spelling", async () => {
    const driver = mysqlEstateDriver({ namespace: "Alpha", attested: true });
    driver.respond = respondWithDatabase("alpha");

    const result = await push(clientFor(driver), {
      force: true,
      forceReset: true,
    });

    expect(result.applied).toBe(true);
    // The clear's inventory and the rebuild's DDL both name the server's own
    // spelling; the configured one reaches the server only as bound data.
    expect(
      driver.statements.some(
        (sql) => sql.startsWith("CREATE TABLE") && sql.includes("`alpha`.")
      )
    ).toBe(true);
    expect(driver.statements.some((sql) => sql.includes("Alpha"))).toBe(false);
  });

  it("keeps the lock identity the acquiring driver named", async () => {
    const driver = mysqlEstateDriver({ namespace: "Alpha", attested: true });
    driver.respond = respondWithDatabase("alpha");
    const ctx = new MigrationContext(clientFor(driver), {
      storageDriver: new MemoryStorage(),
    });

    await ctx.withLockedSession(() => Promise.resolve(1));

    // Both spellings hash to ONE conservative lowercase lock name, and the
    // release names the same one the acquisition did — a release that named a
    // different lock would strand the one actually held.
    const name = mysqlMigrationLockName("Alpha");
    expect(mysqlMigrationLockName("alpha")).toBe(name);
    const locks = driver.statements.filter((sql) => sql.includes(name));
    expect(locks).toHaveLength(2);
    expect(driver.sessions).toEqual(["reserve", "release"]);
  });
});

// =============================================================================
// LOCK PROOFS — §3.5's exact arms
// =============================================================================

describe("PostgreSQL lock proofs", () => {
  const pg = getMigrationDriver(pgEstateDriver("alpha"));

  it("proves acquisition from the answered row and nothing else", () => {
    // `pg_advisory_lock` returns void and BLOCKS, so answering at all is the
    // proof; no answer means the statement did not run.
    expect(pg.provesLockAcquired([{ acquired: "" }])).toBe(true);
    expect(pg.provesLockAcquired([])).toBe(false);
    expect(pg.provesLockAcquired([{ acquired: "" }, { acquired: "" }])).toBe(
      false
    );
  });

  it("accepts exactly one boolean true as a release", () => {
    expect(pg.provesLockReleased([{ released: true }])).toBe(true);
    // `false` means this session never held the lock — the exact case that
    // strands one on another connection.
    expect(pg.provesLockReleased([{ released: false }])).toBe(false);
    expect(pg.provesLockReleased([{ released: "t" }])).toBe(false);
    expect(pg.provesLockReleased([{}])).toBe(false);
    expect(pg.provesLockReleased([])).toBe(false);
    expect(pg.provesLockReleased([null])).toBe(false);
  });

  it("fails the command when acquisition is not proven, before any work", async () => {
    const driver = pgEstateDriver("alpha");
    driver.lockAnswers.acquire = [];
    const storage = new MemoryStorage();
    await seed(storage, journalFor("postgresql", [entry(0, "init")]));

    await expect(
      down(clientFor(driver), { storageDriver: storage, steps: 1 })
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_LOCK_FAILED });

    // Only the lock statement ran on the producer: no journal reread, no
    // applied-state read, no artifact read.
    expect(
      driver.statements.filter((sql) => sql.includes("pg_advisory_lock"))
    ).toHaveLength(1);
    // Only the pre-admission probe read storage; the authoritative reread
    // never happened, because the lock was never proven.
    expect(storage.reads).toEqual(["meta/_journal.json"]);
    expect(storage.writes).toEqual([]);
    expect(driver.sessions).toEqual(["reserve", "destroy"]);
  });

  it("surfaces an unproven release and discards the producer", async () => {
    const driver = pgEstateDriver("alpha");
    // The schema proof is answered so the body reaches its clean end: the
    // failure under test is the RELEASE's, and nothing before it.
    driver.respond = respondWithSchema();
    driver.lockAnswers.release = [{ released: false }];
    const storage = new MemoryStorage();
    const ctx = new MigrationContext(clientFor(driver), {
      storageDriver: storage,
    });

    await expect(
      ctx.withLockedSession(() => Promise.resolve(1))
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_LOCK_FAILED });
    expect(driver.sessions).toEqual(["reserve", "destroy"]);
  });
});

describe("MySQL GET_LOCK arms", () => {
  const mysql = getMigrationDriver(
    mysqlEstateDriver({ namespace: "alpha", attested: true })
  );

  it("accepts only a parsed numeric 1", () => {
    // The whole point of the arm: `0` is a TIMEOUT and `NULL` is an ERROR, and
    // the previous owner discarded the result and ran the protected work on
    // both.
    expect(mysqlLockAnswer([{ acquired: 1 }], "acquired")).toBe(true);
    expect(mysqlLockAnswer([{ acquired: "1" }], "acquired")).toBe(true);
    expect(mysqlLockAnswer([{ acquired: 0 }], "acquired")).toBe(false);
    expect(mysqlLockAnswer([{ acquired: null }], "acquired")).toBe(false);
    expect(mysqlLockAnswer([{ acquired: "yes" }], "acquired")).toBe(false);
    expect(mysqlLockAnswer([{}], "acquired")).toBe(false);
    expect(mysqlLockAnswer([], "acquired")).toBe(false);
    expect(
      mysqlLockAnswer([{ acquired: 1 }, { acquired: 1 }], "acquired")
    ).toBe(false);
    expect(mysqlLockAnswer([{ released: 1 }], "released")).toBe(true);
    expect(mysqlLockAnswer([{ released: 0 }], "released")).toBe(false);
  });

  it("reads the driver's own answers through the same two seams", () => {
    expect(mysql.provesLockAcquired([{ acquired: 1 }])).toBe(true);
    expect(mysql.provesLockAcquired([{ acquired: 0 }])).toBe(false);
    expect(mysql.provesLockReleased([{ released: 1 }])).toBe(true);
    expect(mysql.provesLockReleased([{ released: null }])).toBe(false);
  });

  it.each([
    ["a timeout", [{ acquired: 0 }]],
    ["a NULL error", [{ acquired: null }]],
    ["a missing row", []],
    ["a malformed answer", [{ acquired: "later" }]],
  ])("refuses the command on %s and destroys the connection", async (_label, answer) => {
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    driver.respond = respondWithDatabase("alpha");
    driver.lockAnswers.acquire = answer;
    const storage = new MemoryStorage();
    await seed(storage, journalFor("mysql", [entry(0, "init")]));

    await expect(
      down(clientFor(driver), { storageDriver: storage, steps: 1 })
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_LOCK_FAILED });
    expect(driver.sessions).toEqual(["reserve", "destroy"]);
    // The target was never selected: a lock that was not proven protects
    // nothing, so no session state is set either.
    expect(driver.statements.some((sql) => sql.startsWith("USE"))).toBe(false);
  });
});

describe("the MySQL lock name is scoped to the database", () => {
  it("derives distinct bounded names per database", () => {
    const alpha = mysqlMigrationLockName("alpha");
    const beta = mysqlMigrationLockName("beta");
    expect(alpha).not.toBe(beta);
    expect(alpha.length).toBeLessThanOrEqual(64);
    expect(alpha).toContain("alpha");
  });

  it("collapses case variants onto ONE identity", () => {
    // Under `lower_case_table_names=1` two spellings ARE one database. Letting
    // them take different lock names would let two migration commands run
    // against it concurrently.
    expect(mysqlMigrationLockName("Billing")).toBe(
      mysqlMigrationLockName("billing")
    );
    expect(mysqlMigrationLockName("BILLING")).toBe(
      mysqlMigrationLockName("billing")
    );
  });

  it("stays inside MySQL's 64-character limit and still separates long names", () => {
    const long = "a".repeat(120);
    const other = `${"a".repeat(119)}b`;
    expect(mysqlMigrationLockName(long).length).toBeLessThanOrEqual(64);
    // Truncation alone would collide; the hash is computed over the WHOLE name.
    expect(mysqlMigrationLockName(long)).not.toBe(
      mysqlMigrationLockName(other)
    );
  });
});

// =============================================================================
// SESSION-CAPABILITY ADMISSION — Neon HTTP and PlanetScale
// =============================================================================

describe("a transport with no interactive session is refused", () => {
  const neonDriver = () =>
    new NeonHTTPDriver({
      databaseUrl: "postgresql://user:pw@example.neon.tech/db",
      namespace: "alpha",
    });

  it("declares no pinned-session capability", () => {
    expect(neonDriver()._canPinSession()).toBe(false);
    expect(new PGliteDriver()._canPinSession()).toBe(true);
  });

  it.each([
    ["apply()", (c: never, s: MemoryStorage) => apply(c, { storageDriver: s })],
    ["down()", (c: never, s: MemoryStorage) => down(c, { storageDriver: s })],
    ["reset()", (c: never, s: MemoryStorage) => reset(c, { storageDriver: s })],
    [
      "squash()",
      (c: never, s: MemoryStorage) =>
        squash(c, { storageDriver: s, name: "x" }),
    ],
  ])("refuses %s with DRIVER_NOT_SUPPORTED before any provider call", async (_label, run) => {
    const driver = neonDriver();
    const storage = new MemoryStorage();
    await seed(storage, journalFor("postgresql", [entry(0, "init")]));
    const client = { $driver: driver, $schema: schema };

    await expect(run(client as never, storage)).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });
    // The refusal is pre-provider AND pre-storage-write: only the estate
    // probe read the journal.
    expect(storage.writes).toEqual([]);
  });

  it("refuses a non-dry push and admits the dry run", async () => {
    const client = createClient({ schema, driver: neonDriver() });

    await expect(push(client, { force: true })).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });

    // The read-only half stays available: a dry run makes a point-in-time
    // report and holds no lock, so it never needed a session. It fails at the
    // network instead of at admission.
    await expect(
      push(client, { force: true, dryRun: true })
    ).rejects.not.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });
  });

  it("leaves storage-only and read-only paths alone", async () => {
    const driver = neonDriver();
    const storage = new MemoryStorage();
    const client = { $driver: driver, $schema: schema };

    // An absent journal is the documented storage-only return: no session, no
    // admission, no provider call.
    expect(await status(client as never, { storageDriver: storage })).toEqual(
      []
    );
    expect(await pending(client as never, { storageDriver: storage })).toEqual(
      []
    );
    expect(await apply(client as never, { storageDriver: storage })).toEqual({
      applied: [],
      pending: [],
    });
  });
});

// =============================================================================
// PLANETSCALE — every effectful and dry-live verb, §10
// =============================================================================

/**
 * §10's letter: PlanetScale refuses every effectful push/migration verb "even
 * with an explicit namespace and a session-capable fixture", because the reason
 * is VTGate schema routing, not connection identity. So the ATTESTATION arm has
 * to fire, and it has to fire on every verb — including the dry `down`/`reset`/
 * `squash` decisions, which read live state a caller confirms against and are
 * admitted as `effectful` for exactly that reason.
 *
 * One parameterized block over the verbs, not one guard per verb: the refusal
 * has a single owner (`admitLiveMigrationCapability`), and what the matrix
 * proves is that every verb REACHES it before touching the provider. The
 * `meta.command` assertion is what makes that specific — a case can only pass
 * by going through the owner naming its own verb.
 */
describe("PlanetScale refuses every effectful and dry-live verb", () => {
  const planetscaleDriver = () =>
    new PlanetScaleDriver({
      databaseUrl: "mysql://user:pw@example.psdb.cloud/alpha",
      namespace: "alpha",
    });

  const verbs: ReadonlyArray<{
    readonly label: string;
    readonly command: string;
    readonly run: (client: never, storage: MemoryStorage) => Promise<unknown>;
  }> = [
    {
      label: "apply()",
      command: "apply()",
      run: (c, storageDriver) => apply(c, { storageDriver }),
    },
    {
      label: "down()",
      command: "down()",
      run: (c, storageDriver) => down(c, { storageDriver }),
    },
    {
      label: "down({ dryRun })",
      command: "down()",
      run: (c, storageDriver) => down(c, { storageDriver, dryRun: true }),
    },
    {
      label: "reset()",
      command: "reset()",
      run: (c, storageDriver) => reset(c, { storageDriver }),
    },
    {
      label: "reset({ dryRun })",
      command: "reset()",
      run: (c, storageDriver) => reset(c, { storageDriver, dryRun: true }),
    },
    {
      label: "squash()",
      command: "squash()",
      run: (c, storageDriver) => squash(c, { storageDriver, name: "s" }),
    },
    {
      label: "squash({ dryRun })",
      command: "squash()",
      run: (c, storageDriver) =>
        squash(c, { storageDriver, name: "s", dryRun: true }),
    },
    {
      label: "push()",
      command: "push()",
      run: (c) => push(c, { force: true }),
    },
    {
      label: "push({ forceReset })",
      command: "push({ forceReset: true })",
      run: (c) => push(c, { force: true, forceReset: true }),
    },
  ];

  it.each(
    verbs
  )("refuses $label on the attestation, before any provider statement", async (verb) => {
    const driver = planetscaleDriver();
    // The spy is the "before any provider work" assertion: every live read
    // and every DDL statement in the migration layer goes through this one
    // method, and it throws rather than calling through so a leaked call
    // cannot reach the network and cannot pass quietly.
    const executed = vi.spyOn(driver, "_executeRaw").mockImplementation(() => {
      throw new Error("the refusal did not precede provider work");
    });
    const storage = new MemoryStorage();
    await seed(storage, journalFor("mysql", [entry(0, "init")]));
    const client = createClient({ schema, driver });

    await expect(verb.run(client as never, storage)).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      // The message is the attestation refusal, not the session one.
      message: expect.stringContaining("non-redirecting"),
      meta: { command: verb.command, driver: "planetscale" },
    });
    expect(executed).not.toHaveBeenCalled();
    expect(storage.writes).toEqual([]);
  });

  it("has no attestation to give, and refuses a session-capable twin alike", async () => {
    // Half one: the shipped driver exposes the fact as absent, and there is no
    // option that could supply it — that is WHY every row above refuses.
    expect(planetscaleDriver().migrationNamespaceAttestation).toBeUndefined();

    // Half two: §10's "session-capable fixture". A MySQL driver that DOES
    // reserve a session (`RecordingDriver` implements the hook) and carries an
    // explicit namespace is refused on the same attestation, so the refusal
    // above is not session capability wearing another name.
    const capable = mysqlEstateDriver({ namespace: "alpha" });
    expect(capable._canPinSession()).toBe(true);
    const storage = new MemoryStorage();
    await seed(storage, journalFor("mysql", [entry(0, "init")]));

    await expect(
      down(clientFor(capable) as never, { storageDriver: storage })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      message: expect.stringContaining("non-redirecting"),
    });
    expect(capable.statements).toEqual([]);
    expect(capable.sessions).toEqual([]);
  });
});

// =============================================================================
// ARTIFACT EXECUTION SAFETY — N15's one classifier
// =============================================================================

describe("the artifact execution-safety classifier", () => {
  it("reads only EXECUTABLE words, grouped per statement", () => {
    expect(
      readExecutableStatements("SELECT 1 -- COMMIT", "postgresql")
    ).toEqual([["SELECT"]]);
    expect(readExecutableStatements("/* COMMIT */ SELECT 1", "mysql")).toEqual([
      ["SELECT"],
    ]);
    expect(
      readExecutableStatements("INSERT INTO t VALUES ('COMMIT')", "postgresql")
    ).toEqual([["INSERT", "INTO", "T", "VALUES"]]);
    expect(
      readExecutableStatements('CREATE TABLE "commit" (id INT)', "postgresql")
    ).toEqual([["CREATE", "TABLE", "ID", "INT"]]);
    // The grouping is the load-bearing part: VibORM's artifact parser splits on
    // its own breakpoint marker, so one parsed chunk routinely holds several
    // statements and only the SECOND one here is transaction control.
    expect(
      readExecutableStatements(
        'CREATE TABLE "t" (id INT);\nCOMMIT;',
        "postgresql"
      )
    ).toEqual([["CREATE", "TABLE", "ID", "INT"], ["COMMIT"]]);
    // A dollar-quoted body is a STRING, not statements — refusing an ordinary
    // `CREATE FUNCTION` would be the classifier's worst failure mode.
    expect(
      readExecutableStatements(
        "CREATE FUNCTION f() RETURNS void AS $$ BEGIN COMMIT; END $$ LANGUAGE plpgsql",
        "postgresql"
      )
    ).toEqual([
      [
        "CREATE",
        "FUNCTION",
        "F",
        "RETURNS",
        "VOID",
        "AS",
        "LANGUAGE",
        "PLPGSQL",
      ],
    ]);
  });

  it("reads each dialect's OWN comment and string grammar", () => {
    // MySQL's `#` line comment. PostgreSQL has none, so the same text there is
    // an operator followed by executable words.
    expect(readExecutableStatements("# COMMIT\nSELECT 1", "mysql")).toEqual([
      ["SELECT"],
    ]);
    expect(
      readExecutableStatements("# COMMIT\nSELECT 1", "postgresql")
    ).toEqual([["COMMIT", "SELECT"]]);
    // MySQL executable comments are not comments at all: the server RUNS them.
    expect(
      readExecutableStatements("/*!50000 DO RELEASE_LOCK('k') */", "mysql")
    ).toEqual([["DO", "RELEASE_LOCK"]]);
    expect(
      readExecutableStatements("/*!50000 DO RELEASE_LOCK('k') */", "postgresql")
    ).toEqual([]);
    // MySQL's backslash escape keeps `'a\'b'` ONE literal, so the `COMMIT`
    // after it is a statement rather than string content.
    expect(
      readExecutableStatements(
        "INSERT INTO t VALUES ('a\\'b'); COMMIT;",
        "mysql"
      )
    ).toEqual([["INSERT", "INTO", "T", "VALUES"], ["COMMIT"]]);
    // PostgreSQL's plain strings are standard-conforming: the same bytes close
    // at the backslash-quote, and `b'…'` is what follows.
    expect(
      readExecutableStatements(
        "INSERT INTO t VALUES (E'a\\'b'); COMMIT;",
        "postgresql"
      )
    ).toEqual([["INSERT", "INTO", "T", "VALUES"], ["COMMIT"]]);
    // PostgreSQL nests block comments; MySQL stops at the first close, which is
    // where its server stops too.
    expect(
      readExecutableStatements(
        "/* outer /* inner */ COMMIT; */ CREATE TABLE t (id INT)",
        "postgresql"
      )
    ).toEqual([["CREATE", "TABLE", "T", "ID", "INT"]]);
    // MySQL's `--` needs whitespace after it; without any, this is arithmetic
    // over a REAL function call.
    expect(
      readExecutableStatements("SELECT 1--RELEASE_LOCK('k')", "mysql")
    ).toEqual([["SELECT", "RELEASE_LOCK"]]);
    expect(
      readExecutableStatements("SELECT 1--RELEASE_LOCK('k')", "postgresql")
    ).toEqual([["SELECT"]]);
  });

  it.each([
    // The four artifacts the review admitted end to end, one per hole. The
    // first one released VibORM's own migration lock mid-command on MySQL 8.4.
    {
      dialect: "mysql" as const,
      sql: "/*!50000 DO RELEASE_LOCK('viborm_migration_prlock_55a49a70') */",
      hole: "a MySQL executable comment",
    },
    {
      dialect: "mysql" as const,
      sql: "# don't drop this\nSELECT RELEASE_LOCK('viborm_migration_app_1234abcd');",
      hole: "an apostrophe inside a # comment",
    },
    {
      dialect: "mysql" as const,
      sql: "INSERT INTO t (v) VALUES ('a\\'b'); COMMIT;",
      hole: "a MySQL backslash escape",
    },
    {
      dialect: "postgresql" as const,
      sql: "INSERT INTO t (v) VALUES (E'a\\'b'); COMMIT;",
      hole: "a PostgreSQL escape string",
    },
  ])("refuses through $hole", ({ dialect, sql }) => {
    expect(() => assertArtifactExecutionSafe([sql], dialect, "m")).toThrow(
      EXECUTION_BOUNDARY
    );
  });

  it("admits a PostgreSQL artifact that is entirely a nested comment", () => {
    // The refusal's mirror image: `/* outer /* inner */ COMMIT; */` is one
    // comment on PostgreSQL, and stopping at the first close refused a
    // perfectly valid artifact over a `COMMIT` the server never sees.
    expect(() =>
      assertArtifactExecutionSafe(
        ["/* outer /* inner */ COMMIT; */ CREATE TABLE t (id INT)"],
        "postgresql",
        "m"
      )
    ).not.toThrow();
  });

  it.each([
    "BEGIN",
    "START TRANSACTION",
    "COMMIT",
    "END",
    "ROLLBACK",
    "ABORT",
    "SAVEPOINT s1",
    "RELEASE SAVEPOINT s1",
    // Two-phase commit closes the same boundary from the other side. Both of
    // these already lead with a refused word; `PREPARE TRANSACTION` is the one
    // spelling of the family that does not, which is the case below.
    "COMMIT PREPARED 'g1'",
    "ROLLBACK PREPARED 'g1'",
  ])("refuses the PostgreSQL transaction control %s", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "postgresql", "m")
    ).toThrow(EXECUTION_BOUNDARY);
  });

  it.each([
    "PREPARE TRANSACTION 'g1'",
    "prepare transaction 'g1'",
    "PREPARE\n  TRANSACTION 'g1'",
    "PREPARE /* two-phase */ TRANSACTION 'g1'",
    "CREATE TABLE \"t\" (id INT);\nPREPARE TRANSACTION 'g1';",
  ])("refuses the two-word boundary command %s", (statement) => {
    // `PREPARE TRANSACTION` ENDS the transaction the entry runs inside: it
    // detaches it from the session and leaves it for a later `COMMIT
    // PREPARED`, so on a server with `max_prepared_transactions > 0` the
    // artifact's DDL is stranded while the tracking write that records it
    // lands in the autocommit that follows.
    expect(() =>
      assertArtifactExecutionSafe([statement], "postgresql", "m")
    ).toThrow(EXECUTION_BOUNDARY);
  });

  it.each([
    // The control: an ordinary prepared statement is not transaction control at
    // all, and it leads with the same word. Only the SECOND word separates
    // them, which is why the refusal above is on the phrase.
    "PREPARE plan (int) AS SELECT $1",
    "PREPARE transaction_plan AS SELECT 1",
    "EXECUTE plan(1)",
    "DEALLOCATE plan",
    'CREATE TABLE "prepare_transaction" (id INT)',
  ])("keeps the ordinary prepared statement %s valid", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "postgresql", "m")
    ).not.toThrow();
  });

  it.each(CONTRACT_TEXTS)("states the honest scope in %s", (relative) => {
    // Not a behavior test and deliberately so: the defect was the CLAIM. The
    // mechanism refuses what it always refused, and what changed is that no
    // shipped text tells a reader the refusals are confinement.
    const text = readFileSync(join(REPOSITORY_ROOT, relative), "utf8");
    expect(text).not.toMatch(CONFINEMENT_CLAIM);
    expect(text).toMatch(HONEST_SCOPE);
  });

  it.each([
    "SELECT pg_advisory_lock(1)",
    "SELECT pg_advisory_unlock(1)",
    "SELECT pg_advisory_unlock_all()",
    "SELECT pg_advisory_lock_shared(1)",
    "SELECT pg_advisory_xact_lock(1)",
    "SELECT pg_try_advisory_lock(1)",
    "SELECT coalesce(pg_advisory_unlock(1), false)",
  ])("refuses the PostgreSQL advisory call %s", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "postgresql", "m")
    ).toThrow(ADVISORY_LOCK_STATE);
  });

  it.each([
    // The hole: the scanner skips quoted identifiers because a quoted name is a
    // NAME — but PostgreSQL runs `pg_catalog."pg_advisory_unlock_all"()`, which
    // frees the lock excluding every other migration command.
    'SELECT pg_catalog."pg_advisory_unlock_all"()',
    'SELECT "pg_advisory_unlock_all"()',
    // A call takes whitespace, and a comment, between its name and its `(`.
    'SELECT "pg_advisory_unlock_all" ()',
    'SELECT pg_catalog."pg_advisory_unlock_all"/* wait */()',
    'SELECT "pg_advisory_unlock"(1)',
    'SELECT "pg_advisory_xact_lock"(1)',
    'SELECT coalesce("pg_advisory_unlock"(1), false)',
    'CREATE TABLE t AS SELECT "pg_advisory_unlock_all"()',
  ])("refuses the CALLED quoted advisory identifier %s", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "postgresql", "m")
    ).toThrow(ADVISORY_LOCK_STATE);
  });

  it.each([
    // A quoted identifier that is NAMED rather than called stays valid, `(`
    // after it or not: these are tables, columns, literals and comments.
    'CREATE TABLE "pg_advisory_unlock_all" (id INT)',
    'CREATE TABLE IF NOT EXISTS "pg_advisory_unlock_all" (id INT)',
    'CREATE TABLE t ("pg_advisory_unlock_all" VARCHAR(10))',
    'CREATE FUNCTION "pg_advisory_unlock_all"() RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql',
    'INSERT INTO t ("pg_advisory_unlock_all") VALUES (1)',
    'SELECT "pg_advisory_unlock_all" FROM t',
    `INSERT INTO t (note) VALUES ('SELECT pg_catalog."pg_advisory_unlock_all"()')`,
    '-- SELECT pg_catalog."pg_advisory_unlock_all"()',
    // A quoted identifier is case-SENSITIVE: this one names a function
    // PostgreSQL does not have, so it is not the family's spelling at all.
    'SELECT "PG_ADVISORY_UNLOCK_ALL"()',
  ])("keeps the quoted NAME %s valid", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "postgresql", "m")
    ).not.toThrow();
  });

  it.each([
    // The defect, on the arm that never asked what the word was DOING: a bare
    // `PG_ADVISORY*` spelling was refused wherever it appeared. Every statement
    // here is valid PostgreSQL that calls nothing.
    "CREATE TABLE pg_advisory_notes (id int)",
    "CREATE TABLE t (pg_advisory_note int)",
    // The same conflation in every other position a name sits in: a column with
    // a default, an index name, an added column, a projection, an insert list.
    "CREATE TABLE t (id INT, pg_advisory_note INT DEFAULT 0)",
    "CREATE INDEX pg_advisory_note_idx ON t (id)",
    "ALTER TABLE t ADD COLUMN pg_advisory_note INT",
    "SELECT pg_advisory_note FROM pg_advisory_notes",
    "INSERT INTO t (pg_advisory_note) VALUES (1)",
    // A qualified definition names its object THROUGH the chain: the word that
    // governs `pg_advisory_notes` is the `TABLE` in front of `alpha`, not the
    // qualifier between them.
    "CREATE TABLE alpha.pg_advisory_notes (id int)",
  ])("keeps the PostgreSQL advisory WORD %s valid", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "postgresql", "m")
    ).not.toThrow();
  });

  it("refuses a quoted call that punctuation separates from a name keyword", () => {
    // The mirror of the same conflation, on the quoted arm: the object-name
    // exemption read the previous WORD with no regard for what sat between
    // them, so a comma away from a column named `view` this call was admitted.
    // `view` is an ordinary unreserved column name in PostgreSQL.
    expect(
      readExecutableStatements(
        'SELECT view, "pg_advisory_unlock"(1)',
        "postgresql"
      )
    ).toEqual([["SELECT", "VIEW", "pg_advisory_unlock"]]);
    expect(() =>
      assertArtifactExecutionSafe(
        ['SELECT view, "pg_advisory_unlock"(1)'],
        "postgresql",
        "m"
      )
    ).toThrow(ADVISORY_LOCK_STATE);
  });

  it("reads a called quoted identifier, and a named one not at all", () => {
    expect(
      readExecutableStatements(
        'SELECT pg_catalog."pg_advisory_unlock_all"()',
        "postgresql"
      )
    ).toEqual([["SELECT", "PG_CATALOG", "pg_advisory_unlock_all"]]);
    expect(
      readExecutableStatements(
        'CREATE TABLE "pg_advisory_unlock_all" (id INT)',
        "postgresql"
      )
    ).toEqual([["CREATE", "TABLE", "ID", "INT"]]);
    // MySQL's `"` is a string quote, not an identifier quote, so the same bytes
    // are data there — and a backtick-quoted name is not a callable built-in.
    expect(
      readExecutableStatements('SELECT "pg_advisory_unlock_all"()', "mysql")
    ).toEqual([["SELECT"]]);
  });

  it.each([
    "START TRANSACTION",
    "COMMIT",
    "ROLLBACK",
    "XA START 'x'",
    "SET autocommit = 0",
    "SET @@autocommit = 0",
    // The system variable under its scope qualifier: `@@session.autocommit` is
    // the same setting the bare spelling names, and the sigil folds to it.
    "SET @@session.autocommit = 0",
    "LOCK TABLES t WRITE",
    "UNLOCK TABLES",
    "SELECT GET_LOCK('x', 1)",
    "SELECT RELEASE_LOCK('x')",
    "SELECT RELEASE_ALL_LOCKS()",
    "SELECT IS_FREE_LOCK('x')",
    "SELECT IS_USED_LOCK('x')",
  ])("refuses the MySQL control %s", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "mysql", "m")
    ).toThrow(EXECUTION_BOUNDARY);
  });

  it.each([
    // The MySQL half of the same defect: the named-lock family was matched as a
    // WORD, so a table, a column, an index and a projection carrying one of
    // those names were all refused although none of them calls anything.
    "CREATE TABLE get_lock (id int)",
    "CREATE TABLE t (release_lock int)",
    "CREATE TABLE t (id INT, get_lock INT DEFAULT 0)",
    "CREATE INDEX release_lock ON t (id)",
    "ALTER TABLE t ADD COLUMN is_free_lock INT",
    "SELECT release_lock FROM get_lock",
    "INSERT INTO t (get_lock) VALUES (1)",
  ])("keeps the MySQL lock WORD %s valid", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "mysql", "m")
    ).not.toThrow();
  });

  it.each([
    // A `@name` user variable is neither the system variable of the same
    // spelling nor a call to anything: the sigil is part of the NAME. Stripping
    // it read `SET @autocommit = 0` as the commit-boundary change refused
    // above, and `@release_lock` as MySQL's built-in.
    "SET @autocommit = 0",
    "SET @get_lock = 1, @release_lock = 2",
    "SELECT @release_lock",
    "SELECT @release_lock := 1",
  ])("keeps the MySQL user variable %s valid", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "mysql", "m")
    ).not.toThrow();
  });

  it("reads a variable sigil as part of the name it belongs to", () => {
    // `@@autocommit` and `autocommit` name the same setting, so the system
    // sigil folds away and both reach the refusal. One `@` does not fold:
    // nothing on the server reads that name.
    expect(readExecutableStatements("SET @@autocommit = 0", "mysql")).toEqual([
      ["SET", "AUTOCOMMIT"],
    ]);
    expect(readExecutableStatements("SET @autocommit = 0", "mysql")).toEqual([
      ["SET", "@AUTOCOMMIT"],
    ]);
    // PostgreSQL has no variable sigil at all — `@` is an operator character
    // there — so joining it to the word behind it would hide a real call.
    expect(
      readExecutableStatements("SELECT @pg_advisory_unlock(1)", "postgresql")
    ).toEqual([["SELECT", "PG_ADVISORY_UNLOCK"]]);
    expect(() =>
      assertArtifactExecutionSafe(
        ["SELECT @pg_advisory_unlock(1)"],
        "postgresql",
        "m"
      )
    ).toThrow(ADVISORY_LOCK_STATE);
  });

  it("leaves string and comment mentions valid", () => {
    const valid = [
      "INSERT INTO audit (note) VALUES ('COMMIT the change')",
      "-- ROLLBACK is not needed here",
      "/* pg_advisory_unlock(1) */ SELECT 1",
      "INSERT INTO log (note) VALUES ('GET_LOCK is a MySQL function')",
    ];
    expect(() =>
      assertArtifactExecutionSafe(valid, "postgresql", "m")
    ).not.toThrow();
    expect(() =>
      assertArtifactExecutionSafe(valid, "mysql", "m")
    ).not.toThrow();
  });

  it("keeps a manual MySQL USE valid — the executor reasserts the target", () => {
    // §3.5's exact letter. The next artifact re-selects the configured target
    // on the pinned session, so a manual `USE` cannot redirect it; refusing it
    // would break author-owned SQL for no gain.
    expect(() =>
      assertArtifactExecutionSafe(
        ["USE `beta`", "INSERT INTO t VALUES (1)"],
        "mysql",
        "m"
      )
    ).not.toThrow();
  });

  it("classifies nothing on SQLite", () => {
    expect(() =>
      assertArtifactExecutionSafe(["COMMIT"], "sqlite", "m")
    ).not.toThrow();
  });

  it("detects a generated enum-addition commit boundary", () => {
    expect(
      needsEnumAdditionCommitBoundary([
        `ALTER TYPE "billing"."state" ADD VALUE 'archived'`,
      ])
    ).toBe(true);
    expect(
      needsEnumAdditionCommitBoundary([
        "INSERT INTO t (note) VALUES ('ALTER TYPE x ADD VALUE y')",
      ])
    ).toBe(false);
    expect(needsEnumAdditionCommitBoundary(['CREATE TABLE "t" (id INT)'])).toBe(
      false
    );
  });

  it.each([
    { control: "COMMIT", tail: "COMMIT;" },
    { control: "PREPARE TRANSACTION", tail: "PREPARE TRANSACTION 'g1';" },
  ])("refuses a manual $control artifact before apply() runs any of it", async ({
    tail,
  }) => {
    const driver = pgEstateDriver("alpha");
    driver.respond = respondWithSchema();
    const storage = new MemoryStorage();
    const journalEntry = entry(0, "init");
    await seed(storage, journalFor("postgresql", [journalEntry]));
    await storage.writeMigration(
      journalEntry,
      `CREATE TABLE "alpha"."t" (id INT);\n${tail}\n`
    );
    storage.writes.length = 0;

    await expect(
      apply(clientFor(driver), { storageDriver: storage })
    ).rejects.toThrow(EXECUTION_BOUNDARY);

    // The artifact's own DDL never ran and no tracking row was written: the
    // refusal is a preflight. (The tracking TABLE is created first — that is
    // the admitted effectful write every apply makes before reading state.)
    expect(driver.statements.some((sql) => sql.includes('"alpha"."t"'))).toBe(
      false
    );
    expect(driver.statements.some((sql) => sql.includes("INSERT INTO"))).toBe(
      false
    );
  });
});

// =============================================================================
// MYSQL TARGET SELECTION — §5.3's validated target for relative artifacts
// =============================================================================

describe("the pinned MySQL session selects its target for every artifact", () => {
  it("reasserts the configured database before EVERY relative artifact", async () => {
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    driver.respond = respondWithTracking("alpha");
    const storage = new MemoryStorage();
    const first = entry(0, "manual-use");
    const second = entry(1, "create-table");
    await seed(storage, journalFor("mysql", [first, second]));
    // A MANUAL artifact is allowed to issue its own `USE` (§3.5): the executor
    // re-selects the target before the next one, so it cannot redirect it.
    await storage.writeMigration(first, "USE `beta`");
    await storage.writeMigration(second, "CREATE TABLE `t` (id INT)");

    await apply(clientFor(driver), { storageDriver: storage });

    const selections = driver.statements.filter((sql) =>
      sql.startsWith("USE ")
    );
    // Once when the lock was taken, once before each of the two artifacts, and
    // — between them — the manual artifact's OWN `USE beta`. That third entry
    // is the whole point: the target is reasserted before every artifact, never
    // only once for the session.
    expect(selections).toEqual([
      "USE `alpha`",
      "USE `alpha`",
      "USE `beta`;",
      "USE `alpha`",
    ]);
    // The generated artifact runs AFTER a re-selection, so the manual `USE
    // beta` cannot carry it into another database.
    const createIndex = driver.statements.findIndex((sql) =>
      sql.includes("CREATE TABLE `t`")
    );
    const beforeCreate = driver.statements
      .slice(0, createIndex)
      .filter((sql) => sql.startsWith("USE "));
    expect(beforeCreate.at(-1)).toBe("USE `alpha`");
  });

  it("executes MySQL artifacts sequentially, in no transaction at all", async () => {
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    driver.respond = respondWithTracking("alpha");
    const storage = new MemoryStorage();
    const only = entry(0, "two-statements");
    await seed(storage, journalFor("mysql", [only]));
    await storage.writeMigration(only, "CREATE TABLE `a` (id INT)");

    await apply(clientFor(driver), { storageDriver: storage });

    // MySQL commits DDL implicitly, so a transaction around it would
    // manufacture an atomicity that does not exist — and the generic batch
    // dispatch opens one.
    expect(driver.statements).not.toContain("<begin>");
    // Nor does the entry owner open one itself. On a pinned producer that is a
    // LITERAL `BEGIN`, and the observed stream was `BEGIN` → `CREATE TABLE`
    // (which commits, and the `BEGIN` with it) → the tracking `INSERT`, now in
    // autocommit → a `COMMIT` with nothing left to commit.
    expect(driver.statements).not.toContain("BEGIN");
    expect(driver.statements).not.toContain("COMMIT");
    // The tracking row still lands only AFTER its artifact completed.
    const created = driver.statements.findIndex((sql) =>
      sql.includes("CREATE TABLE `a`")
    );
    const tracked = driver.statements.findIndex((sql) =>
      sql.startsWith("INSERT INTO")
    );
    expect(created).toBeGreaterThanOrEqual(0);
    expect(tracked).toBeGreaterThan(created);
  });

  it("keeps the PostgreSQL entry transaction, which is real there", async () => {
    // The control: PostgreSQL DDL is transactional, so its entry owner still
    // commits the artifact and its tracking row together.
    const driver = pgEstateDriver("alpha");
    driver.respond = respondWithSchemaTracking();
    const storage = new MemoryStorage();
    const only = entry(0, "one-table");
    await seed(storage, journalFor("postgresql", [only]));
    await storage.writeMigration(only, 'CREATE TABLE "alpha"."a" (id INT)');

    await apply(clientFor(driver), { storageDriver: storage });

    expect(driver.statements).toContain("BEGIN");
    expect(driver.statements).toContain("COMMIT");
  });

  it("proves the PostgreSQL schema BEFORE the tracking table it would create", async () => {
    const driver = pgEstateDriver("ghost");
    // The schema proof answers no rows: nothing created this schema.
    driver.respond = () => [];
    const storage = new MemoryStorage();
    await storage.writeJournal({
      version: "3",
      target: { dialect: "postgresql", namespace: "ghost" },
      entries: [],
    });
    storage.writes.length = 0;

    await expect(
      apply(clientFor(driver), { storageDriver: storage })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { namespace: "ghost" },
    });

    // §10's letter: a configured-but-absent namespace fails after only its
    // read-only catalog proof and BEFORE DDL. The tracking table is DDL, and it
    // used to be the first statement inside the lock — so the estate answered
    // with a raw provider failure from `CREATE TABLE "ghost"."_viborm_
    // migrations"` instead of the designed refusal.
    expect(driver.statements.some((sql) => sql.includes("CREATE TABLE"))).toBe(
      false
    );
    expect(storage.writes).toEqual([]);
    // The lock was taken and given back: the proof is the first thing after it.
    expect(driver.sessions).toEqual(["reserve", "destroy"]);
  });
});

// =============================================================================
// DROPPED-TABLE FOREIGN KEYS — §6.1's one operation-preparation stage
// =============================================================================

describe("dropped-table foreign keys are materialized once", () => {
  const pg = getMigrationDriver(pgEstateDriver("alpha"));
  const sqlite = getMigrationDriver(sqliteEstateDriver());

  const fk = (name: string, from: string, to: string) => ({
    name,
    columns: [`${to}_id`],
    referencedTable: to,
    referencedColumns: ["id"],
    onDelete: "cascade" as const,
    onUpdate: "cascade" as const,
    __from: from,
  });

  const table = (name: string, foreignKeys: ReturnType<typeof fk>[]) => ({
    name,
    columns: [],
    indexes: [],
    foreignKeys,
    uniqueConstraints: [],
  });

  it.each([
    [
      "parent-first",
      [
        table("parent", []),
        table("child", [fk("child_parent", "child", "parent")]),
      ],
    ],
    [
      "child-first",
      [
        table("child", [fk("child_parent", "child", "parent")]),
        table("parent", []),
      ],
    ],
    [
      "cyclic",
      [table("a", [fk("a_b", "a", "b")]), table("b", [fk("b_a", "b", "a")])],
    ],
  ])("materializes the drops for a %s removal", (_label, tables) => {
    const drops = tables.map((t) => ({
      type: "dropTable" as const,
      tableName: t.name,
    }));
    const prepared = materializeDroppedTableForeignKeys(
      [...drops],
      { tables },
      pg
    );
    const emitted = prepared
      .filter((op) => op.type === "dropForeignKey")
      .map((op) => op.fkName)
      .sort();
    const expected = tables
      .flatMap((t) => t.foreignKeys.map((k) => k.name))
      .sort();
    expect(emitted).toEqual(expected);
    // Once, not twice: an already-planned drop is not duplicated.
    const twice = materializeDroppedTableForeignKeys(prepared, { tables }, pg);
    expect(twice.filter((op) => op.type === "dropForeignKey")).toHaveLength(
      expected.length
    );
  });

  it("leaves inline-foreign-key dialects byte-identical", () => {
    // SQLite and LibSQL hold foreign keys inline and rebuild tables; an
    // explicit `ALTER TABLE ... DROP CONSTRAINT` is not a statement they emit.
    const tables = [
      table("child", [fk("child_parent", "child", "parent")]),
      table("parent", []),
    ];
    const drops = tables.map((t) => ({
      type: "dropTable" as const,
      tableName: t.name,
    }));
    expect(
      materializeDroppedTableForeignKeys([...drops], { tables }, sqlite)
    ).toEqual(drops);
  });
});

// =============================================================================
// SUPPLIED CONNECTION STATE — §5.3
// =============================================================================

describe("MySQL2 never changes a caller's connection state", () => {
  it("ends a pool it created and leaves a supplied pool alone", async () => {
    const { MySQL2Driver } = await import("@drivers/mysql2");
    let suppliedEnded = false;
    const suppliedPool = {
      end: () => {
        suppliedEnded = true;
        return Promise.resolve();
      },
      getConnection: () => Promise.reject(new Error("not used")),
      query: () => Promise.reject(new Error("not used")),
      execute: () => Promise.reject(new Error("not used")),
    };

    const supplied = new MySQL2Driver({
      pool: suppliedPool as never,
      namespace: "alpha",
    });
    await supplied._disconnect();
    // A supplied pool belongs to the caller, who may be sharing it with other
    // clients. `$disconnect()` used to end it regardless.
    expect(suppliedEnded).toBe(false);

    const owned = new MySQL2Driver({
      databaseUrl: "mysql://root:pw@127.0.0.1:1/alpha",
    });
    await owned._connect();
    let ownedEnded = false;
    const ownedPool: unknown = Reflect.get(owned, "client");
    if (ownedPool && typeof ownedPool === "object") {
      const realEnd: unknown = Reflect.get(ownedPool, "end");
      Object.defineProperty(ownedPool, "end", {
        configurable: true,
        value: (...args: unknown[]) => {
          ownedEnded = true;
          return typeof realEnd === "function"
            ? Reflect.apply(realEnd, ownedPool, args)
            : Promise.resolve();
        },
      });
    }
    await owned._disconnect();
    expect(ownedEnded).toBe(true);
  });

  it("pg ends a pool it created and leaves a supplied pool alone", async () => {
    const { PgDriver } = await import("@drivers/pg");
    let suppliedEnded = false;
    const suppliedPool = {
      end: () => {
        suppliedEnded = true;
        return Promise.resolve();
      },
      query: () => Promise.reject(new Error("not used")),
      connect: () => Promise.reject(new Error("not used")),
    };

    // Two schema-scoped estates over one pg.Pool is the documented sharing
    // shape, so disconnecting one estate must not tear down the sibling's
    // transport.
    const supplied = new PgDriver({
      pool: suppliedPool as never,
      namespace: "alpha",
    });
    await supplied._disconnect();
    expect(suppliedEnded).toBe(false);

    const owned = new PgDriver({
      options: { host: "127.0.0.1", port: 1 },
    });
    await owned._connect();
    let ownedEnded = false;
    const ownedPool: unknown = Reflect.get(owned, "client");
    if (ownedPool && typeof ownedPool === "object") {
      Object.defineProperty(ownedPool, "end", {
        configurable: true,
        value: () => {
          ownedEnded = true;
          return Promise.resolve();
        },
      });
    }
    await owned._disconnect();
    expect(ownedEnded).toBe(true);
  });
});

// =============================================================================
// MID-RESET FAILURE — §6.2 and §6.3's injected statement N
// =============================================================================

/**
 * MySQL commits DDL as it runs, so a reset that fails partway CANNOT be undone.
 * §6.3 asks the error to report the last known committed statement, make no
 * rollback claim, and leave the portable estate byte-identical; §10 adds that it
 * must expose no stale applied rows and restore no unproven tracking row.
 *
 * The fault is injected at the unit level because that is the only place a
 * specific statement can be made to fail on demand: a live MySQL container
 * offers no seam for "fail the SECOND drop and nothing else".
 */
describe("a MySQL reset that fails mid-flight reports what it committed", () => {
  const TRACKING_TABLE = "_viborm_migrations";
  const INIT = entry(0, "init");

  async function mysqlResetEstate(): Promise<{
    driver: RecordingDriver;
    storage: MemoryStorage;
  }> {
    const driver = mysqlEstateDriver({
      namespace: "alpha",
      attested: true,
    });
    const storage = new MemoryStorage();
    await storage.writeJournal(journalFor("mysql", [INIT]));
    await storage.writeMigration(INIT, "CREATE TABLE `ns_posts` (`id` INT);");
    storage.writes.length = 0;
    storage.reads.length = 0;
    return { driver, storage };
  }

  /**
   * Answers the catalog and fails exactly one statement.
   *
   * The inventory read (`TABLE_NAME AS name`) decides MEMBERSHIP and the
   * introspection read decides the GRAPH; answering the graph empty keeps the
   * drop order equal to the inventory order, so "statement N" is a fixed,
   * nameable position rather than something the fixture has to guess.
   */
  function respondForReset(fails: (sql: string) => boolean) {
    return (sql: string): unknown[] | Error => {
      const mode = sessionModeAnswer(sql);
      if (mode) {
        return mode;
      }
      if (sql.includes("SCHEMATA")) {
        return [{ SCHEMA_NAME: "alpha" }];
      }
      if (fails(sql)) {
        return new Error("lost connection to the server during query");
      }
      if (sql.includes("TABLE_NAME AS name")) {
        return [
          { name: TRACKING_TABLE },
          { name: "ns_orgs" },
          { name: "ns_posts" },
        ];
      }
      return [];
    };
  }

  it("names the last committed statement and claims no rollback", async () => {
    const { driver, storage } = await mysqlResetEstate();
    // Statement N is the SECOND table drop. The first drop, and the tracking
    // clear before it, have already committed and cannot be taken back.
    driver.respond = respondForReset((sql) => sql.includes("ns_posts`"));

    const failure = await reset(clientFor(driver) as never, {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      // The boundary, exactly: the drop BEFORE the one that failed.
      message: expect.stringContaining(
        "The last statement that completed was: DROP TABLE IF EXISTS `alpha`.`ns_orgs`"
      ),
    });
    const message = failure instanceof Error ? failure.message : "";
    // Makes no rollback claim — it states the opposite, which is the truth —
    // and refuses to characterize the statement that failed.
    expect(message).toContain("NOTHING was rolled back");
    expect(message).toContain(
      "makes no claim about whether the statement that failed took effect"
    );
    // The provider's own failure survives underneath the report rather than
    // being replaced by it.
    expect(failure).toMatchObject({
      originalCause: expect.objectContaining({
        code: VibORMErrorCode.QUERY_FAILED,
      }),
    });

    // The portable estate is byte-identical: no journal, snapshot or artifact
    // write on the failure path.
    expect(storage.writes).toEqual([]);
    // No stale applied rows: the tracking clear committed BEFORE the first
    // drop, and nothing re-inserted a row for history whose objects are gone.
    const clear = `DELETE FROM \`alpha\`.\`${TRACKING_TABLE}\``;
    expect(driver.statements).toContain(clear);
    expect(driver.statements.indexOf(clear)).toBeLessThan(
      driver.statements.indexOf("DROP TABLE IF EXISTS `alpha`.`ns_orgs`")
    );
    expect(driver.statements.filter((sql) => sql.startsWith("INSERT"))).toEqual(
      []
    );
  });

  it("restores no tracking row for an artifact that did not complete", async () => {
    const { driver, storage } = await mysqlResetEstate();
    // The teardown succeeds in full; the REPLAY is what fails, which is the
    // other side of the same honesty rule: a row may be restored only after
    // the artifact it describes has completed.
    driver.respond = respondForReset((sql) => sql.startsWith("CREATE TABLE"));

    const failure = await reset(clientFor(driver) as never, {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    // The clear and the replay are ONE sequential program, so the report spans
    // both. It used to stop at the teardown: a reset that dropped the estate
    // and then failed to rebuild it surfaced only "a CREATE TABLE failed",
    // with nothing saying the database was now empty and nothing rolled back.
    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      message: expect.stringContaining(
        "The last statement that completed was: USE `alpha`"
      ),
      originalCause: expect.objectContaining({
        code: VibORMErrorCode.QUERY_FAILED,
      }),
    });
    expect(failure instanceof Error ? failure.message : "").toContain(
      "NOTHING was rolled back"
    );

    expect(driver.statements).toContain(
      "DROP TABLE IF EXISTS `alpha`.`ns_orgs`"
    );
    expect(driver.statements.filter((sql) => sql.startsWith("INSERT"))).toEqual(
      []
    );
    expect(storage.writes).toEqual([]);
  });

  it("leaves a PostgreSQL reset failure unwrapped — its transaction is the answer", async () => {
    // Disjointness: the boundary report belongs to the dialect that cannot roll
    // back. On PostgreSQL the caller's one transaction restores the schema, so
    // a report describing "what was committed" would describe state that no
    // longer exists — the provider's own cause is the whole truth there.
    const driver = pgEstateDriver("alpha");
    const storage = new MemoryStorage();
    await storage.writeJournal(journalFor("postgresql", [INIT]));
    await storage.writeMigration(INIT, "CREATE TABLE ns_posts (id INT);");
    storage.writes.length = 0;
    driver.respond = (sql: string): unknown[] | Error => {
      if (sql.includes("AS present")) {
        return [{ present: 1 }];
      }
      if (sql.startsWith("DROP TABLE")) {
        return new Error("lost connection to the server during query");
      }
      if (sql.includes("tablename AS name")) {
        return [{ name: "ns_orgs" }];
      }
      return [];
    };

    const failure = await reset(clientFor(driver) as never, {
      storageDriver: storage,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: VibORMErrorCode.QUERY_FAILED });
    expect(failure instanceof Error ? failure.message : "").not.toContain(
      "NOTHING was rolled back"
    );
    expect(storage.writes).toEqual([]);
  });

  it("survives a release that fails on the SAME dying connection", async () => {
    const { driver, storage } = await mysqlResetEstate();
    // The realistic compound case: the DDL and the `RELEASE_LOCK` fail on one
    // socket. A `finally` that throws replaced the reset's own failure with the
    // cleanup's, so the caller was told the LOCK failed after a reset that had
    // already cleared tracking and dropped part of the estate.
    driver.respond = respondForReset((sql) => sql.includes("ns_posts`"));
    driver.lockAnswers.release = new Error("ECONNRESET: connection is closed");

    const failure = await reset(clientFor(driver) as never, {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      message: expect.stringContaining(
        "The last statement that completed was: DROP TABLE IF EXISTS `alpha`.`ns_orgs`"
      ),
    });
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("NOTHING was rolled back");
    // The reset's own report is UNTOUCHED — the cleanup failure is carried
    // beside it rather than written into it.
    expect(message).not.toContain("lock");
    expect(readCleanupFailures(failure)).toMatchObject([
      { code: VibORMErrorCode.MIGRATION_LOCK_FAILED },
    ]);
    // The producer is still condemned rather than pooled.
    expect(driver.sessions).toEqual(["reserve", "destroy"]);
    expect(storage.writes).toEqual([]);
    // The OTHER half of the rule — a release refusal after a CLEAN body still
    // surfaces as the failure — is already this suite's "surfaces an unproven
    // release and discards the producer", which goes red the moment this catch
    // arm is applied to the success path too.
  });
});

// =============================================================================
// CLEANUP FAILURE INTEGRITY — the ONE combination rule, at the lock's release
// =============================================================================

/**
 * A release failure is CLEANUP. It may never replace, rewrite, or destroy the
 * failure the command is already reporting — and the act of recording it may
 * not throw, whatever the primary failure is made of.
 *
 * The two shapes here are the ones that turned a recorded note into a lost
 * cause: an Error the caller froze, and an Error whose `message` is an accessor
 * that refuses writes. Both are ordinary hardened-error practice, and both made
 * VibORM report a `TypeError` from its own cleanup instead of the migration
 * failure that produced it.
 */
describe("a release failure never damages the failure it follows", () => {
  async function lockedFailure(primary: unknown): Promise<unknown> {
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    driver.respond = respondWithDatabase("alpha");
    driver.lockAnswers.release = new Error("ECONNRESET: connection is closed");
    const ctx = new MigrationContext(clientFor(driver), {
      storageDriver: new MemoryStorage(),
    });
    return await ctx
      .withLockedSession(() => Promise.reject(primary))
      .then(
        () => new Error("the locked session was expected to fail"),
        (error: unknown) => error
      );
  }

  it("leaves a FROZEN primary error exactly as it was thrown", async () => {
    const primary = Object.freeze(new Error("the estate half-dropped"));

    const thrown = await lockedFailure(primary);

    expect(thrown).toBe(primary);
    expect(primary.message).toBe("the estate half-dropped");
    expect(Object.isFrozen(primary)).toBe(true);
    // The cleanup is not lost either: it is carried beside the cause.
    expect(readCleanupFailures(thrown)).toMatchObject([
      { code: VibORMErrorCode.MIGRATION_LOCK_FAILED },
    ]);
  });

  it("leaves a primary whose message REFUSES writes exactly as it was", async () => {
    const primary = new Error("placeholder");
    Object.defineProperty(primary, "message", {
      configurable: true,
      get: () => "the estate half-dropped",
      set: () => {
        throw new Error("this error's message is not writable");
      },
    });

    const thrown = await lockedFailure(primary);

    expect(thrown).toBe(primary);
    expect(primary.message).toBe("the estate half-dropped");
    expect(readCleanupFailures(thrown)).toMatchObject([
      { code: VibORMErrorCode.MIGRATION_LOCK_FAILED },
    ]);
  });

  it("keeps a non-Error primary reachable rather than dropping the cleanup", async () => {
    const thrown = await lockedFailure("the estate half-dropped");

    // A string carries nothing, so the thrown value becomes the one shape that
    // keeps both — with the body's own failure still first in it.
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(
      thrown instanceof AggregateError ? thrown.errors[0] : undefined
    ).toBe("the estate half-dropped");
    expect(readCleanupFailures(thrown)).toMatchObject([
      { code: VibORMErrorCode.MIGRATION_LOCK_FAILED },
    ]);
  });
});

// =============================================================================
// DESTRUCTIVE CONTAINMENT — §6.1 and §6.2 on a real PostgreSQL
// =============================================================================

const estateSchema = (() => {
  const member = s
    .model({
      id: s.string().id(),
      orgId: s.string(),
      org: s
        .toOne(() => org)
        .fields("orgId")
        .references("id"),
    })
    .map("ns_members");
  const org = s
    .model({
      id: s.string().id(),
      name: s.string(),
      members: s.toMany(() => member),
    })
    .map("ns_orgs");
  return { org, member };
})();

describe("reset contains itself inside the configured schema", () => {
  let database: PGlite;

  const clientFor2 = (namespace: string) =>
    createClient({
      schema: estateSchema,
      driver: new PGliteDriver({ client: database, namespace }),
    });

  beforeAll(async () => {
    database = new PGlite();
    await database.exec('CREATE SCHEMA "estate"');
    await database.exec('CREATE SCHEMA "sibling"');
    // Sentinels with the SAME names, in `public` and a sibling schema: a
    // statement that lost its qualification finds one and destroys it.
    await database.exec(
      'CREATE TABLE "ns_orgs" ("id" TEXT PRIMARY KEY, "sentinel" TEXT)'
    );
    await database.exec(
      'CREATE TABLE "sibling"."ns_orgs" ("id" TEXT PRIMARY KEY, "sentinel" TEXT)'
    );
    await push(clientFor2("estate"), { force: true });
  });

  afterAll(async () => {
    await database?.close();
  });

  async function tablesIn(namespace: string): Promise<string[]> {
    const rows = await database.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [namespace]
    );
    return rows.rows.map((row) => row.table_name);
  }

  it("force-reset clears ONLY the configured schema and touches no storage", async () => {
    expect(await tablesIn("estate")).toEqual(["ns_members", "ns_orgs"]);

    const storage = new MemoryStorage();
    // Push is given no storage owner at all; this proves the harness would
    // have seen a call if one existed.
    await push(clientFor2("estate"), { force: true, forceReset: true });

    expect(storage.reads).toEqual([]);
    expect(storage.writes).toEqual([]);
    // Rebuilt in place, and both sentinels survive byte-for-byte.
    expect(await tablesIn("estate")).toEqual(["ns_members", "ns_orgs"]);
    expect(await tablesIn("public")).toEqual(["ns_orgs"]);
    expect(await tablesIn("sibling")).toEqual(["ns_orgs"]);
    const sentinel = await database.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'sibling' AND table_name = 'ns_orgs' ORDER BY column_name"
    );
    expect(sentinel.rows.map((row) => row.column_name)).toEqual([
      "id",
      "sentinel",
    ]);
  });

  it("drops a CYCLIC foreign-key graph without CASCADE", async () => {
    // A real cycle: `ns_members` references `ns_orgs` and now `ns_orgs`
    // references `ns_members` back. There is NO table order that satisfies
    // `RESTRICT`, and the differ emits no `dropForeignKey` when both endpoints
    // disappear — so §6.1's materialized key drops are the only thing that lets
    // this clear at all. `CASCADE` used to hide it, at the price of dropping
    // dependants in other schemas.
    await database.exec(
      'ALTER TABLE "estate"."ns_orgs" ADD COLUMN "lead_id" TEXT REFERENCES "estate"."ns_members"("id")'
    );

    await push(clientFor2("estate"), { force: true, forceReset: true });

    expect(await tablesIn("estate")).toEqual(["ns_members", "ns_orgs"]);
    // Rebuilt from the DECLARED schema, so the hand-added cycle column is gone.
    const columns = await database.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'estate' AND table_name = 'ns_orgs' ORDER BY column_name"
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain("lead_id");
  });

  it("aborts the whole clear when an external dependant blocks a RESTRICT drop", async () => {
    // A dependant the inventory does not represent: a view in `public` over an
    // estate table. `CASCADE` would have silently dropped it.
    await database.exec(
      'CREATE VIEW "public"."ns_orgs_view" AS SELECT id FROM "estate"."ns_orgs"'
    );
    try {
      await expect(
        push(clientFor2("estate"), { force: true, forceReset: true })
      ).rejects.toThrow();
      // The transaction rolled back: the estate is exactly as it was.
      expect(await tablesIn("estate")).toEqual(["ns_members", "ns_orgs"]);
      expect(await tablesIn("public")).toEqual(["ns_orgs", "ns_orgs_view"]);
    } finally {
      await database.exec('DROP VIEW "public"."ns_orgs_view"');
    }
  });

  it("proves the namespace before a dry-run reset publishes an inventory", async () => {
    const storage = new MemoryStorage();
    await seed(storage, {
      version: "3",
      target: { dialect: "postgresql", namespace: "missing_estate" },
      entries: [],
    });
    const client = createClient({
      schema: estateSchema,
      driver: new PGliteDriver({
        client: database,
        namespace: "missing_estate",
      }),
    });

    // D deviation 3: the dry run published an UNPROVEN inventory, so a schema
    // that does not exist reported "nothing to drop" instead of refusing.
    await expect(
      reset(client, { storageDriver: storage, dryRun: true })
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_INVALID_STATE });
  });

  it("keeps a locked session for an ordinary push and its introspection", async () => {
    const driver = new PGliteDriver({ client: database, namespace: "estate" });
    const client = createClient({ schema: estateSchema, driver });
    const before = await introspectClient(client);
    expect(before.tables.map((t) => t.name).sort()).toEqual([
      "ns_members",
      "ns_orgs",
    ]);
    // Converges: the second push under the lock plans nothing.
    expect((await push(client, { force: true })).operations).toEqual([]);
  });
});

// =============================================================================
// COMMAND-WIDE LEASE — one shared connection, two concurrent commands
// =============================================================================

/** One resolvable promise, for a seam a test opens by hand. */
function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, resolve: open };
}

/**
 * One timeline shared by every driver in a lease falsifier: which driver ran
 * which statement, in issue order, plus the seam that stops one command dead
 * once it has proven its migration lock.
 *
 * The mutable state lives in this object rather than in a field a driver
 * reassigns: every statement runs through the pinned VIEW, an `Object.create`
 * over the driver, so a write to `this.paused` would land on the view and be
 * invisible here, while a write THROUGH this object is shared by construction.
 */
interface PinnedCommandProbe {
  readonly order: Array<{ readonly tag: string; readonly sql: string }>;
  /** Resolves once the paused command has proven its lock and stopped there. */
  readonly reached: ReturnType<typeof deferred>;
  /** The test opens this to let that command continue. */
  readonly resume: ReturnType<typeof deferred>;
  paused: boolean;
}

function commandProbe(): PinnedCommandProbe {
  return {
    order: [],
    reached: deferred(),
    resume: deferred(),
    paused: false,
  };
}

/** Every statement one tagged driver of a probe ran, in issue order. */
function ranBy(probe: PinnedCommandProbe, tag: string): string[] {
  return probe.order.filter((step) => step.tag === tag).map((step) => step.sql);
}

/** What a lock statement is, for a log that only cares about the boundaries. */
function lockMark(sql: string): string[] {
  if (sql.startsWith("SELECT pg_advisory_lock(")) return ["acquire"];
  if (sql.startsWith("SELECT pg_advisory_unlock(")) return ["release"];
  return [];
}

/**
 * A PGlite driver that records every statement on a shared probe and can STOP
 * its command dead the moment it has proven its migration lock.
 *
 * The pause is taken after `_executeRaw` RESOLVES, so it holds no statement and
 * no queue job — deliberately. A lease that only serialized each statement
 * would leave this exact seam open, and the claim under test is that no other
 * command can get in BETWEEN the paused command's statements either.
 */
class GatedPGliteDriver extends PGliteDriver {
  /** The timeline this driver writes to; shared with its siblings. */
  private readonly probe: PinnedCommandProbe;
  /** Which driver a recorded statement belongs to. */
  private readonly tag: string;
  /** Whether THIS driver is the one that stops after proving its lock. */
  private readonly pauses: boolean;

  constructor(
    options: PGliteDriverOptions,
    probe: PinnedCommandProbe,
    tag: string,
    pauses: boolean
  ) {
    super(options);
    this.probe = probe;
    this.tag = tag;
    this.pauses = pauses;
  }

  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.probe.order.push({ tag: this.tag, sql });
    return super.execute<T>(client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.probe.order.push({ tag: this.tag, sql });
    return super.executeRaw<T>(client, sql, params, context);
  }

  override async _executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const result = await super._executeRaw<T>(sql, params, context);
    if (
      this.pauses &&
      !this.probe.paused &&
      sql.startsWith("SELECT pg_advisory_lock(")
    ) {
      this.probe.paused = true;
      this.probe.reached.resolve();
      await this.probe.resume.promise;
    }
    return result;
  }
}

describe("one shared connection leases the whole pinned session", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec('CREATE SCHEMA "lease"');
    await push(
      createClient({
        schema: estateSchema,
        driver: new PGliteDriver({ client: database, namespace: "lease" }),
      }),
      { force: true }
    );
  });

  afterAll(async () => {
    await database?.close();
  });

  it("admits no second command between one command's lock and its unlock", async () => {
    const probe = commandProbe();
    const driver = new GatedPGliteDriver(
      { client: database, namespace: "lease" },
      probe,
      "one",
      true
    );
    const client = createClient({ schema: estateSchema, driver });

    const first = push(client, { force: true });
    await probe.reached.promise;
    // The first command holds the lock and is doing nothing else.
    const held = ranBy(probe, "one");
    expect(lockMark(held.at(-1) ?? "")).toEqual(["acquire"]);

    const second = push(client, { force: true });
    // A PostgreSQL session advisory lock is REENTRANT and PGlite is ONE
    // session, so the lock itself stops nobody here: without a command-wide
    // lease the second command re-acquires it and introspects and executes
    // inside the first command's session. 300ms is far more than its first
    // statement needs.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ranBy(probe, "one")).toEqual(held);

    probe.resume.resolve();
    await Promise.all([first, second]);

    // Two contiguous sessions, never nested.
    expect(ranBy(probe, "one").flatMap(lockMark)).toEqual([
      "acquire",
      "release",
      "acquire",
      "release",
    ]);
  });

  it("admits no second DRIVER over the same physical client either", async () => {
    const probe = commandProbe();
    // Two drivers, ONE supplied PGlite. Each owns its own connection queue, so
    // the queue lease cannot see the other command at all — and the advisory
    // lock is reentrant on the single session both of them are using, so it
    // admits the second command instead of excluding it. The whole pinned
    // command has to be arbitrated by the PHYSICAL client both drivers hold.
    const first = new GatedPGliteDriver(
      { client: database, namespace: "lease" },
      probe,
      "first",
      true
    );
    const second = new GatedPGliteDriver(
      { client: database, namespace: "lease" },
      probe,
      "second",
      false
    );

    const firstPush = push(
      createClient({ schema: estateSchema, driver: first }),
      { force: true }
    );
    await probe.reached.promise;
    const held = [...probe.order];
    expect(lockMark(held.at(-1)?.sql ?? "")).toEqual(["acquire"]);

    const secondPush = push(
      createClient({ schema: estateSchema, driver: second }),
      { force: true }
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Nothing at all from the second driver: it has not acquired, not read and
    // not executed while the first command holds its lock.
    expect(ranBy(probe, "second")).toEqual([]);
    expect(probe.order).toEqual(held);

    probe.resume.resolve();
    await Promise.all([firstPush, secondPush]);

    // Two contiguous sessions, never nested, and every statement of the first
    // command precedes every statement of the second.
    expect(probe.order.flatMap((step) => lockMark(step.sql))).toEqual([
      "acquire",
      "release",
      "acquire",
      "release",
    ]);
    const tags = probe.order.map((step) => step.tag);
    expect(tags.lastIndexOf("first")).toBeLessThan(tags.indexOf("second"));
  });

  it("keeps independent PGlite clients independent", async () => {
    // The lease is keyed on the PHYSICAL client, so two drivers over two
    // databases still run their pinned commands at the same time. Serializing
    // them would make one estate's migration wait on an unrelated one's.
    const other = new PGlite();
    try {
      const alone = new PGliteDriver({ client: other, namespace: "public" });
      const entered: string[] = [];
      const held = deferred();

      const busy = new PGliteDriver({ client: database, namespace: "lease" });
      const first = busy._withPinnedSession(async () => {
        entered.push("busy");
        await held.promise;
      });
      const second = alone._withPinnedSession(() => {
        entered.push("alone");
        return Promise.resolve();
      });

      await second;
      expect(entered).toEqual(["busy", "alone"]);
      held.resolve();
      await first;
    } finally {
      await other.close();
    }
  });

  it("refuses a pinned session while the one connection is transaction-bound", async () => {
    // The lease is taken on the SAME queue a top-level transaction leases, so
    // a command that reached for the originating driver from inside a
    // transaction callback would wait forever for its own holder. This is the
    // refusal that already covers every other operation on that driver, taken
    // at the lease instead of at the first statement.
    const driver = new PGliteDriver({ client: database, namespace: "lease" });

    await expect(
      driver.withTransaction(() =>
        driver._withPinnedSession(() => Promise.resolve("unreachable"))
      )
    ).rejects.toThrow(TRANSACTION_BOUND);
  });

  it("leases nothing on a driver that reserves a connection of its own", async () => {
    // pg, postgres.js, Bun SQL and MySQL2 each take a DEDICATED connection out
    // of their pool, so their sessions are already physically apart and the
    // queue question never arises. Serializing them here would be a
    // regression: two migration commands on a pool are arbitrated by the real
    // session lock, not by this driver's connection queue.
    const driver = pgEstateDriver("alpha");
    const entered: string[] = [];
    const held = deferred();

    const first = driver._withPinnedSession(async () => {
      entered.push("first");
      await held.promise;
    });
    const second = driver._withPinnedSession(() => {
      entered.push("second");
      return Promise.resolve();
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(entered).toEqual(["first", "second"]);

    held.resolve();
    await Promise.all([first, second]);
  });
});

// =============================================================================
// THE TRUSTED-AUTHOR ESCAPE — executed, on a real PostgreSQL
// =============================================================================

/**
 * One admitted artifact, taking VibORM's migration lock away from it.
 *
 * Every statement is its own breakpoint segment because that is what an
 * artifact file is, and it lets the census bracket the `DO` block exactly: how
 * many advisory locks this session held immediately before it, and how many
 * immediately after. The `DO` body is a STRING to the classifier and a
 * statement to the server, which is the whole escape in one line.
 */
const LOCK_CENSUS_ARTIFACT = [
  'CREATE TABLE "escape"."lock_census" ("before" INT, "after" INT)',
  `INSERT INTO "escape"."lock_census" ("before") VALUES ((SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory'))`,
  "DO $$ BEGIN PERFORM pg_advisory_unlock_all(); END $$",
  `UPDATE "escape"."lock_census" SET "after" = (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory')`,
].join("\n--> statement-breakpoint\n");

describe("manual SQL is trusted authority, and the scanner is not a sandbox", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec('CREATE SCHEMA "escape"');
  });

  afterAll(async () => {
    await database?.close();
  });

  it("frees the migration lock from inside an ADMITTED artifact", async () => {
    // A bystander's advisory lock, so the census counts two holders while the
    // command runs: this one and the migration lock `apply()` is about to take.
    await database.query("SELECT pg_advisory_lock(42)");

    const storage = new MemoryStorage();
    const manual: MigrationEntry = {
      ...entry(0, "manual_escape"),
      mode: "manual",
      rollback: { kind: "manual" },
    };
    await seed(storage, {
      version: "3",
      target: { dialect: "postgresql", namespace: "escape" },
      entries: [manual],
    });
    await storage.writeMigration(manual, LOCK_CENSUS_ARTIFACT);
    const client = createClient({
      schema,
      driver: new PGliteDriver({ client: database, namespace: "escape" }),
    });

    // The classifier admits it — no `EXECUTION_BOUNDARY` refusal — and the
    // command fails at the far end instead, when the lock it acquired is no
    // longer there to release. That failure is VibORM's whole answer to this
    // artifact: detection at the release proof, with the session discarded, not
    // prevention.
    await expect(apply(client, { storageDriver: storage })).rejects.toThrow(
      UNPROVEN_RELEASE
    );

    // The counter-example, executed: two advisory locks held one statement
    // before the `DO` block, none held one statement after it.
    const census = await database.query<{ before: number; after: number }>(
      'SELECT "before", "after" FROM "escape"."lock_census"'
    );
    expect(census.rows).toEqual([{ before: 2, after: 0 }]);

    // The bystander's lock went with it. `pg_advisory_unlock` answers `false`
    // for a lock this session does not hold, which is this session's own
    // report that the artifact took it.
    const bystander = await database.query<{ released: boolean }>(
      "SELECT pg_advisory_unlock(42) AS released"
    );
    expect(bystander.rows).toEqual([{ released: false }]);

    // And the artifact is RECORDED as applied: its DDL and its tracking row
    // committed together in the entry transaction, outside the lock that was
    // supposed to be excluding every other migration command by then.
    const tracked = await database.query<{ name: string }>(
      'SELECT name FROM "escape"."_viborm_migrations"'
    );
    expect(tracked.rows).toEqual([{ name: "manual_escape" }]);
  });

  it("has no live PREPARE TRANSACTION leg here, and this is why", async () => {
    // PGlite ships `max_prepared_transactions = 0`, so the two-word boundary
    // command cannot reach an estate on this substrate at all and the refusal
    // above is proven at the classifier alone. The setting is pinned rather
    // than described: if a later PGlite enables prepared transactions, this
    // fails and the live leg becomes writable.
    const setting = await database.query<{ max_prepared_transactions: string }>(
      "SHOW max_prepared_transactions"
    );
    expect(setting.rows).toEqual([{ max_prepared_transactions: "0" }]);

    await expect(
      database.exec("BEGIN; PREPARE TRANSACTION 'g1';")
    ).rejects.toThrow(PREPARED_TRANSACTIONS_DISABLED);
  });
});
