import { createClient } from "@client/client";
import { s } from "@schema";
import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { applyV1 } from "@src/migrations/apply-v1";
import { canonicalizeJsonText } from "@src/migrations/canonical-json";
import { createMigrationClient } from "@src/migrations/client";
import {
  createControlTableSQL,
  DEFAULT_CONTROL_BASE,
} from "@src/migrations/control";
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
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  mysqlEstateDriver,
  type RecordingDriver,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

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
    const client = liveClient();
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    const preview = await migrations.apply({ dryRun: true });
    expect(preview.outcome).toBe("preview");
    expect(preview.path).toHaveLength(1);
    expect(preview.statements.length).toBeGreaterThan(0);
    const status = await migrations.status();
    expect(status.control).toBe("absent");
    await client.$disconnect();
  });

  test("apply executes the authenticated path and a second apply is a no-op", async () => {
    const storage = new MemoryEstateStorage();
    const client = liveClient();
    const migrations = createMigrationClient(client, { storage });
    const generated = await migrations.generate({ name: "init" });
    const applied = await migrations.apply();
    expect(applied.outcome).toBe("applied");
    expect(applied.path).toEqual([generated.stateId]);
    const again = await migrations.apply();
    expect(again.outcome).toBe("noop");
    const verified = await migrations.verify();
    expect(verified.ok).toBe(true);
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
    const client = liveClient();
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
    await client.$disconnect();
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
    await driver._executeRaw(
      createControlTableSQL(command, DEFAULT_CONTROL_BASE).state
    );

    await expect(migrations.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    await expect(migrations.verify()).resolves.toEqual({ ok: true });
    await client.$disconnect();
  });

  test("rolls control bootstrap back with the first transactional migration", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({
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
    await driver._executeRaw(
      createControlTableSQL(command, DEFAULT_CONTROL_BASE).state
    );

    await expect(migrations.apply()).rejects.toThrow();
    const tables = await driver._executeRaw<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );
    expect(tables.rows.map((row) => row.name)).toContain(
      "_viborm_migration_state"
    );
    expect(tables.rows.map((row) => row.name)).not.toContain(
      "_viborm_migration_log"
    );
    expect(tables.rows.map((row) => row.name)).not.toContain("transient");
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
    const control = createControlTableSQL(command, DEFAULT_CONTROL_BASE);
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
