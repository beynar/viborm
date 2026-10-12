import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { applyV1 } from "@src/migrations/apply-v1";
import { canonicalizeJsonText } from "@src/migrations/canonical-json";
import { createMigrationClient } from "@src/migrations/client";
import { CONTROL_TABLES, createControlTableSQL } from "@src/migrations/control";
import { getMigrationDriver } from "@src/migrations/drivers";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  encodeDispatchIdentity,
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeStateManifest,
  encodeTransitionHash,
  eventIdFor,
} from "@src/migrations/v1-parse";
import type {
  LedgerEventV1,
  MigrationDispatchV1,
  MigrationParameterV1,
  MigrationParentTransitionV1,
} from "@src/migrations/v1-types";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  mysqlEstateDriver,
  type RecordingDriver,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

const ROW_WRITE = /^\s*(INSERT|UPDATE)\b/i;
const BEGIN = /^BEGIN/i;
const COMMIT = /^COMMIT/i;

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});

const indexedUser = s
  .model({
    id: s.string().id(),
    email: s.string(),
  })
  .index(["email"]);

function liveClient() {
  return createClient({
    schema: { user },
    driver: createInMemorySQLite3Driver(),
  });
}

describe("migration v1 apply", () => {
  test("dry-run authenticates the path and writes nothing", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientFor(sqliteEstateDriver());
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    const preview = await migrations.apply({ dryRun: true });
    expect(preview.outcome).toBe("preview");
    expect(preview.path).toHaveLength(1);
    expect(preview.statements.length).toBeGreaterThan(0);
    const status = await migrations.status();
    expect(status.control).toBe("absent");
  });

  test("apply executes the authenticated path and a second apply is a no-op", async () => {
    const storage = new MemoryEstateStorage();
    const client = liveClient();
    const migrations = createMigrationClient(client, { storage });
    const generated = await migrations.generate({ name: "init" });
    const applied = await migrations.apply();
    expect(applied.outcome).toBe("applied");
    expect(applied.path).toEqual([generated.stateId]);
    await expect(migrations.apply({ dryRun: true })).resolves.toEqual({
      outcome: "noop",
      path: [],
      statements: [],
    });
    const again = await migrations.apply();
    expect(again.outcome).toBe("noop");
    const verified = await migrations.verify();
    expect(verified.ok).toBe(true);
    await client.$disconnect();
  });

  test("a transactional group runs its DDL, then moves the marker once, then records every arrival, before one COMMIT", async () => {
    const executed: string[] = [];
    const db = new Database(":memory:", {
      verbose: (statement) => executed.push(String(statement)),
    });
    const storage = new MemoryEstateStorage();
    const post = s.model({ id: s.string().id(), title: s.string() });
    const first = createClient({
      schema: { user },
      driver: new SQLite3Driver({ client: db }),
    });
    await createMigrationClient(first, { storage }).generate({ name: "init" });
    const second = createClient({
      schema: { user, post },
      driver: new SQLite3Driver({ client: db }),
    });
    const migrations = createMigrationClient(second, { storage });
    await migrations.generate({ name: "post" });
    executed.length = 0;

    const applied = await migrations.apply();
    expect(applied.path).toHaveLength(2);
    const { state, log } = CONTROL_TABLES;
    const writes = (table: string) =>
      executed.flatMap((statement, index) =>
        ROW_WRITE.test(statement) && statement.includes(table) ? [index] : []
      );
    const begin = executed.findIndex((statement) => BEGIN.test(statement));
    const ddl = executed.findIndex((statement) =>
      statement.includes('CREATE TABLE "post"')
    );
    const commit = executed.findIndex((statement) => COMMIT.test(statement));
    // Bootstrap writes nothing to either table; the group writes each once.
    expect(writes(state)).toHaveLength(1);
    expect(writes(log)).toHaveLength(1);
    expect([
      begin < ddl,
      ddl < writes(state)[0]!,
      writes(state)[0]! < writes(log)[0]!,
      writes(log)[0]! < commit,
    ]).toEqual([true, true, true, true]);
    const events = await migrations.log();
    expect(events.map((event) => [event.kind, event.toState])).toEqual(
      applied.path.map((stateId) => ["applied", stateId])
    );
    db.close();
  });

  test("an edge applied without a transaction records its start, each step, the marker move, then its arrival", async () => {
    const executed: string[] = [];
    const db = new Database(":memory:", {
      verbose: (statement) => executed.push(String(statement)),
    });
    // A declared custom driver with no transactions runs every edge probed.
    class Untransacted extends SQLite3Driver {
      override readonly supportsTransactions = false;
    }
    const client = createClient({
      schema: { user },
      driver: new Untransacted({ client: db }),
    });
    const migrations = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
    });
    await migrations.generate({ name: "init" });
    executed.length = 0;

    await expect(migrations.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    const { state, log } = CONTROL_TABLES;
    const order = executed.flatMap((statement) => {
      if (statement.includes('CREATE TABLE "user"')) return ["ddl"];
      if (!ROW_WRITE.test(statement)) return [];
      if (statement.includes(state)) return ["marker"];
      return statement.includes(log) ? ["event"] : [];
    });
    expect(order).toEqual(["event", "ddl", "event", "marker", "event"]);
    expect((await migrations.log()).map((event) => event.kind)).toEqual([
      "started",
      "step-confirmed",
      "applied",
    ]);
    db.close();
  });

  test("apply proves drift before returning a same-target no-op", async () => {
    const storage = new MemoryEstateStorage();
    const client = liveClient();
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    await migrations.apply();
    await client.$driver._executeRaw(
      'ALTER TABLE "user" ADD COLUMN "outside" TEXT'
    );

    await expect(migrations.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
    });
    await client.$disconnect();
  });

  test("ordinary apply refuses an occupied target without a marker", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    await driver._executeRaw('CREATE TABLE "outside" ("id" TEXT PRIMARY KEY)');

    await expect(migrations.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("empty managed target"),
    });
    await client.$disconnect();
  });

  test("origin checks refuse before the first stored dispatch", async () => {
    const storage = new MemoryEstateStorage();
    const client = liveClient();
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({
      name: "guarded",
      manualMigration: {
        transitions: [
          {
            from: null,
            execution: "transactional",
            up: [sql`SELECT 'must not run'`],
            originChecks: [
              { kind: "trusted-read", query: sql`SELECT 0`, equals: true },
            ],
            rollback: { kind: "irreversible", reason: "test" },
          },
        ],
      },
    });

    await expect(migrations.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: expect.stringContaining("Origin checks"),
    });
    await client.$disconnect();
  });

  test("an ordinary non-unique index survives generated artifact admission and apply", async () => {
    const storage = new MemoryEstateStorage();
    const client = createClient({
      schema: { user: indexedUser },
      driver: createInMemorySQLite3Driver(),
    });
    const migrations = createMigrationClient(client, { storage });

    await migrations.generate({ name: "indexed" });
    await expect(migrations.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    await expect(migrations.verify()).resolves.toEqual({ ok: true });
    await client.$disconnect();
  });

  test("a missing SQL blob on the selected path fails before the first effect", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientFor(sqliteEstateDriver());
    const migrations = createMigrationClient(client, { storage });
    const generated = await migrations.generate({ name: "init" });
    if (!generated.sqlHash) throw new Error("expected published SQL");
    const bytes = await storage.readSql(generated.sqlHash);
    if (!bytes) throw new Error("expected SQL bytes");
    Object.defineProperty(storage, "readSql", {
      value: async () => null,
    });
    await expect(migrations.apply({ dryRun: true })).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
    });
  });
});

function clientFor(driver: RecordingDriver) {
  return { $driver: driver, $schema: { user } };
}

function emptyParent(): Omit<MigrationParentTransitionV1, "transitionHash"> {
  return {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [],
    rollback: { kind: "irreversible", reason: "empty root" },
  };
}

async function publishEmptyRoot() {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  const snapshot = encodeSnapshot(emptyManagedSnapshot());
  const blob = composeSqlBlob([]);
  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
  await storage.publishSql(blob.sqlHash, blob.bytes);
  const parent = emptyParent();
  const encoded = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name: "root",
    snapshotHash: snapshot.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
  });
  await storage.publishState(encoded.stateId, encoded.bytes);
  return { storage, stateId: encoded.stateId, estateHash: estate.estateHash };
}

function dispatchAt(
  blob: ReturnType<typeof composeSqlBlob>,
  index: number,
  parameters: readonly MigrationParameterV1[] = []
): MigrationDispatchV1 {
  const range = blob.ranges[index];
  if (!range) throw new Error(`Missing SQL range ${index}`);
  return {
    ...range,
    sqlHash: blob.sqlHash,
    parameters,
    dispatchId: encodeDispatchIdentity(
      blob.sqlHash,
      range.offset,
      range.length,
      parameters
    ),
  };
}

async function publishMySqlNamespaceRoot() {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "mysql" });
  const snapshot = encodeSnapshot(emptyManagedSnapshot());
  const blob = composeSqlBlob(["SELECT 1", "SELECT ?"]);
  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
  await storage.publishSql(blob.sqlHash, blob.bytes);
  const parent = {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [
      {
        id: "portable",
        label: "portable",
        origin: "generated" as const,
        risk: "safe" as const,
        steps: [
          { retry: "opaque" as const, execute: dispatchAt(blob, 0) },
          {
            retry: "opaque" as const,
            execute: dispatchAt(blob, 1, [{ kind: "target-namespace" }]),
          },
        ],
      },
    ],
    rollback: { kind: "irreversible" as const, reason: "test" },
  };
  const encoded = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name: "portable-mysql",
    snapshotHash: snapshot.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
  });
  await storage.publishState(encoded.stateId, encoded.bytes);
  return storage;
}

function startedEvent(toState: string, estateHash: string): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId: "a".repeat(64),
    kind: "started" as const,
    estateHash,
    snapshotHash: "b".repeat(64),
    sqlHash: null,
    fromState: null,
    toState,
    transitionHash: null,
    direction: "forward" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-08-28T00:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

function controlRespond(options: {
  readonly statePresent?: boolean;
  readonly logPresent?: boolean;
  readonly ledger?: readonly LedgerEventV1[];
}) {
  const statePresent = options.statePresent ?? true;
  const logPresent = options.logPresent ?? true;
  const ledger = options.ledger ?? [];
  return (sql: string, params: unknown[]): unknown[] | Error => {
    const catalog = controlCatalogAnswer(sql, params, {
      state: statePresent,
      log: logPresent,
    });
    if (catalog) return catalog;
    const definition = sqliteControlDefinitionAnswer(sql, {
      state: statePresent,
      log: logPresent,
    });
    if (definition) return definition;
    if (
      sql.includes("SELECT payload FROM") &&
      sql.includes("_viborm_migration_log")
    ) {
      return ledger.map((event) => ({ payload: canonicalizeJsonText(event) }));
    }
    if (
      sql.startsWith("CREATE TABLE") ||
      sql.startsWith("INSERT INTO") ||
      sql.startsWith("UPDATE")
    ) {
      return [{ ok: 1 }];
    }
    return [];
  };
}

describe("migration v1 apply control-plane refusals", () => {
  test("recovers an exact interrupted bootstrap through public apply", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    const command = getMigrationDriver(driver);
    await driver._executeRaw(createControlTableSQL(command).state);

    await expect(migrations.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    await expect(migrations.verify()).resolves.toEqual({ ok: true });
    await client.$disconnect();
  });

  test("rolls the first transactional migration back and records it as failed", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    const migrations = createMigrationClient(client, { storage });
    const failing = await migrations.generate({
      name: "failing-init",
      manualMigration: {
        transitions: [
          {
            from: null,
            execution: "transactional",
            up: [
              sql.raw('CREATE TABLE "transient" ("id" TEXT PRIMARY KEY)'),
              sql.raw('INSERT INTO "missing" ("id") VALUES (\'x\')'),
            ],
            rollback: { kind: "irreversible", reason: "test failure" },
          },
        ],
      },
    });
    const command = getMigrationDriver(driver);
    await driver._executeRaw(createControlTableSQL(command).state);

    await expect(migrations.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      meta: { toState: failing.stateId, statementIndex: 1 },
    });
    const tables = await driver._executeRaw<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );
    expect(tables.rows.map((row) => row.name)).toEqual([
      "_viborm_migration_log",
      "_viborm_migration_state",
    ]);
    // The rollback took the attempt's own events; the bootstrap the failure
    // record needs completes outside it, holding exactly that record.
    const log = await migrations.log();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      kind: "failed",
      fromState: null,
      toState: failing.stateId,
      effectState: "none",
    });
    const status = await migrations.status();
    expect(status).toMatchObject({ marker: null, unfinished: false });
    expect(status.lastFailure).toEqual(log[0]);
    await client.$disconnect();
  });

  test.each([
    "malformed-log",
    "state-trigger",
  ] as const)("refuses a %s control pair before user-schema DDL", async (shape) => {
    const storage = new MemoryEstateStorage();
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    const command = getMigrationDriver(driver);
    const control = createControlTableSQL(command);
    await driver._executeRaw(control.state);
    if (shape === "malformed-log") {
      await driver._executeRaw(
        `CREATE TABLE "_viborm_migration_log" (event_id TEXT NOT NULL, attempt_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)`
      );
    } else {
      await driver._executeRaw(control.log);
      await driver._executeRaw(
        `CREATE TRIGGER reject_control_insert BEFORE INSERT ON "_viborm_migration_state" BEGIN SELECT RAISE(ABORT, 'blocked'); END`
      );
    }

    await expect(migrations.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    const applicationTables = await driver._executeRaw<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_viborm_migration_%'"
    );
    expect(applicationTables.rows).toEqual([]);
    await client.$disconnect();
  });

  test("a MySQL target-namespace parameter requires a bound command namespace before effects", async () => {
    const storage = await publishMySqlNamespaceRoot();
    const driver = mysqlEstateDriver({ attested: true });

    await expect(applyV1(clientFor(driver), storage)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("live MySQL database"),
    });
    expect(driver.statements).toEqual([]);
  });

  test("an unfinished attempt blocks ordinary apply", async () => {
    const published = await publishEmptyRoot();
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [startedEvent(published.stateId, published.estateHash)],
    });
    await expect(
      applyV1(clientFor(driver), published.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT,
    });
  });

  test("a missing one of the two control tables refuses rather than inventing history", async () => {
    const published = await publishEmptyRoot();
    const missingLog = sqliteEstateDriver();
    const missingLogRespond = controlRespond({ logPresent: false });
    missingLog.respond = (sql, params) =>
      sql.includes("SELECT payload FROM") &&
      sql.includes("_viborm_migration_state")
        ? [{ payload: "occupied" }]
        : missingLogRespond(sql, params);
    await expect(
      applyV1(clientFor(missingLog), published.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    const missingState = sqliteEstateDriver();
    missingState.respond = controlRespond({ statePresent: false });
    await expect(
      applyV1(clientFor(missingState), published.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
  });
});
