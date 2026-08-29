import { createClient } from "@client/client";
import { s } from "@schema";
import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
// biome-ignore lint/performance/noNamespaceImport: vi.spyOn needs the module object
import * as applyModule from "@src/migrations/apply-v1";
import { applyV1 } from "@src/migrations/apply-v1";
import {
  canonicalizeJson,
  canonicalizeJsonText,
} from "@src/migrations/canonical-json";
import { createMigrationClient } from "@src/migrations/client";
import {
  createControlTableSQL,
  DEFAULT_CONTROL_BASE,
  markerFromPath,
  unfinishedAttempts,
} from "@src/migrations/control";
import { getMigrationDriver } from "@src/migrations/drivers";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { generateV1 } from "@src/migrations/generate-v1";
import { domainHash, HASH_DOMAIN } from "@src/migrations/identity";
import { downV1, resolveV1 } from "@src/migrations/operators";
import { resetV1 } from "@src/migrations/reset-v1";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  encodeDispatchIdentity,
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeSqlBlob,
  encodeStateManifest,
  encodeTransitionHash,
  eventIdFor,
} from "@src/migrations/v1-parse";
import type {
  LedgerEventV1,
  MigrationDispatchV1,
  MigrationParentTransitionV1,
  ResolveV1Options,
} from "@src/migrations/v1-types";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import {
  controlCatalogAnswer,
  type RecordingDriver,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});

function liveClient() {
  return createClient({
    schema: { user },
    driver: createInMemorySQLite3Driver(),
  });
}

describe("migration v1 operators", () => {
  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("down refuses hostile step count %s before storage or provider work", async (steps) => {
    const storage = new MemoryEstateStorage();
    const client = liveClient();
    const migrations = createMigrationClient(client, { storage });
    await expect(migrations.down({ steps })).rejects.toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      message: expect.stringContaining("positive safe integer"),
    });
    expect(await storage.readEstate()).toBeNull();
    await client.$disconnect();
  });

  test("down snapshots its selector once before estate access", async () => {
    const storage = new MemoryEstateStorage();
    const client = liveClient();
    const migrations = createMigrationClient(client, { storage });
    let reads = 0;
    const options = Object.defineProperty({}, "steps", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? 1 : 5;
      },
    });

    await expect(
      Reflect.apply(migrations.down, migrations, [options])
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
    });
    expect(reads).toBe(1);
    await client.$disconnect();
  });

  test.each([
    { steps: 1, to: { name: "init" } },
    { steps: 1, unknown: true },
    { steps: 1, dryRun: "yes" },
  ])("down refuses malformed exact options before estate access", async (options) => {
    const storage = new MemoryEstateStorage();
    const client = liveClient();
    const migrations = createMigrationClient(client, { storage });

    await expect(
      Reflect.apply(migrations.down, migrations, [options])
    ).rejects.toMatchObject({ code: VibORMErrorCode.INVALID_INPUT });
    expect(await storage.readEstate()).toBeNull();
    await client.$disconnect();
  });

  test("down translates a hostile selector accessor at its boundary", async () => {
    const storage = new MemoryEstateStorage();
    const client = liveClient();
    const migrations = createMigrationClient(client, { storage });
    const failure = new Error("selector trap");
    const options = Object.defineProperty({}, "steps", {
      enumerable: true,
      get() {
        throw failure;
      },
    });

    await expect(
      Reflect.apply(migrations.down, migrations, [options])
    ).rejects.toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      originalCause: expect.objectContaining({
        message: "Underlying error details redacted",
        name: failure.name,
      }),
    });
    await client.$disconnect();
  });

  test("status and log are read-only on an unmarked database", async () => {
    const storage = new MemoryEstateStorage();
    const client = liveClient();
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    const status = await migrations.status();
    expect(status.control).toBe("absent");
    expect(status.unfinished).toBe(false);
    await expect(migrations.log()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_NOT_FOUND,
    });
    await client.$disconnect();
  });

  test("read-only commands authenticate present control tables", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    const command = getMigrationDriver(driver);
    const control = createControlTableSQL(command, DEFAULT_CONTROL_BASE);
    await driver._executeRaw(control.state);
    await driver._executeRaw(
      `CREATE TABLE "_viborm_migration_log" (event_id TEXT NOT NULL, attempt_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)`
    );

    const reads = [
      () => migrations.status(),
      () => migrations.log(),
      () => migrations.apply({ dryRun: true }),
      () => migrations.down({ dryRun: true }),
    ];
    for (const read of reads) {
      await expect(read()).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      });
    }
    await client.$disconnect();
  });

  test("baseline refuses a data-only path and accepts an exact schema match", async () => {
    const storage = new MemoryEstateStorage();
    const client = liveClient();
    const first = await generateV1(client, storage, { name: "init" });
    if (!first.stateId) throw new Error("expected published init");
    await generateV1(client, storage, {
      name: "data",
      from: first.stateId,
      manualMigration: {
        transitions: [
          {
            from: first.stateId,
            execution: "transactional",
            up: [sql`SELECT 1`],
            originChecks: [
              { kind: "trusted-read", query: sql`SELECT 1`, equals: true },
            ],
            rollback: { kind: "irreversible", reason: "data" },
          },
        ],
        destinationChecks: [
          { kind: "trusted-read", query: sql`SELECT 1`, equals: true },
        ],
      },
    });
    const migrations = createMigrationClient(client, { storage });
    await syncLiveSchema(client);
    await expect(
      migrations.baseline({ to: { name: "data" } })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    const adopted = await migrations.baseline({ to: { name: "init" } });
    expect(adopted.stateId).toBe(first.stateId);
    await client.$disconnect();
  });

  test("baseline recovers an exact interrupted control bootstrap", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    const migrations = createMigrationClient(client, { storage });
    const generated = await migrations.generate({ name: "init" });
    if (!generated.stateId) throw new Error("expected a published state");
    await syncLiveSchema(client);
    const command = getMigrationDriver(driver);
    await driver._executeRaw(
      createControlTableSQL(command, DEFAULT_CONTROL_BASE).state
    );

    await expect(
      migrations.baseline({ to: { id: generated.stateId } })
    ).resolves.toMatchObject({ stateId: generated.stateId });
    await client.$disconnect();
  });

  test("reset recovers an exact interrupted control bootstrap", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    const command = getMigrationDriver(driver);
    await driver._executeRaw(
      createControlTableSQL(command, DEFAULT_CONTROL_BASE).state
    );

    await expect(migrations.reset()).resolves.toMatchObject({ preview: false });
    await expect(migrations.verify()).resolves.toEqual({ ok: true });
    await client.$disconnect();
  });

  test("dry-run down and reset take no writer lock and change no marker", async () => {
    const storage = new MemoryEstateStorage();
    const client = liveClient();
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    await migrations.apply();
    const before = await migrations.status();
    const down = await migrations.down({ steps: 1, dryRun: true });
    expect(down.preview).toBe(true);
    expect(down.path).toHaveLength(1);
    const reset = await migrations.reset({ dryRun: true });
    expect(reset.preview).toBe(true);
    const after = await migrations.status();
    expect(after.marker?.revision).toBe(before.marker?.revision);
    await client.$disconnect();
  });

  test("down records a rollback start before it moves the marker", async () => {
    const storage = new MemoryEstateStorage();
    const client = liveClient();
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    await migrations.apply();
    const rolled = await migrations.down({ steps: 1 });
    expect(rolled.preview).toBe(false);
    const log = await migrations.log();
    expect(
      log.some(
        (event) => event.kind === "started" && event.direction === "rollback"
      )
    ).toBe(true);
    expect(log.some((event) => event.kind === "rolled-back")).toBe(true);
    await client.$disconnect();
  });

  test("a no-op push after apply succeeds; a non-empty push against the marker refuses", async () => {
    const driver = createInMemorySQLite3Driver();
    const storage = new MemoryEstateStorage();
    const client = createClient({ schema: { user }, driver });
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    await migrations.apply();
    const noop = await migrations.push();
    expect(noop).toMatchObject({ outcome: "noop" });
    const expanded = s.model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
    });
    const next = createClient({ schema: { user: expanded }, driver });
    await expect(createMigrationClient(next).push()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    await client.$disconnect();
    await next.$disconnect();
  });

  test("push refuses an interrupted control bootstrap before user DDL", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { user }, driver });
    const command = getMigrationDriver(driver);
    const control = createControlTableSQL(command, DEFAULT_CONTROL_BASE);
    await driver._executeRaw(control.state);

    await expect(createMigrationClient(client).push()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    await expect(
      driver._executeRaw<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ["user"]
      )
    ).resolves.toMatchObject({ rows: [] });
    await client.$disconnect();
  });

  test("a closer closes its attempt even when it sorts before the start", () => {
    const attemptId = "c".repeat(64);
    const started = startedEvent("d".repeat(64), "e".repeat(64));
    const applied = {
      ...started,
      attemptId,
      kind: "applied" as const,
      finishedAt: started.startedAt,
      effectState: "committed" as const,
    };
    const openStart = { ...started, attemptId };
    expect(
      unfinishedAttempts([
        { ...applied, eventId: eventIdFor(applied) },
        { ...openStart, eventId: eventIdFor(openStart) },
      ])
    ).toEqual([]);
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

function opaqueDispatch(
  blob: ReturnType<typeof composeSqlBlob>
): MigrationDispatchV1 {
  const range = blob.ranges[0]!;
  return {
    dispatchId: encodeDispatchIdentity(
      blob.sqlHash,
      range.offset,
      range.length,
      []
    ),
    sqlHash: blob.sqlHash,
    offset: range.offset,
    length: range.length,
    parameters: [],
  };
}

async function publishRoot(options: { readonly opaque?: boolean } = {}) {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  const snapshot = encodeSnapshot(emptyManagedSnapshot());
  const blob = composeSqlBlob(options.opaque ? ["SELECT 1"] : []);
  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
  await storage.publishSql(blob.sqlHash, blob.bytes);
  const parent: Omit<MigrationParentTransitionV1, "transitionHash"> =
    options.opaque
      ? {
          fromState: null,
          originChecks: [],
          requestedForwardBoundary: "stepwise",
          operations: [
            {
              id: "manual:forward:0",
              label: "manual",
              origin: "manual",
              risk: "opaque",
              steps: [{ retry: "opaque", execute: opaqueDispatch(blob) }],
            },
          ],
          rollback: { kind: "irreversible", reason: "opaque data" },
        }
      : emptyParent();
  const encoded = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name: options.opaque ? "opaque" : "root",
    snapshotHash: snapshot.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
  });
  await storage.publishState(encoded.stateId, encoded.bytes);
  return {
    storage,
    stateId: encoded.stateId,
    estateHash: estate.estateHash,
    snapshotHash: snapshot.snapshotHash,
    sqlHash: blob.sqlHash,
    transitionHash: encodeTransitionHash(parent),
    dispatch: options.opaque ? opaqueDispatch(blob) : undefined,
  };
}

async function publishRollbackProgram() {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  const snapshot = encodeSnapshot(emptyManagedSnapshot());
  const firstSql = "SELECT 'rollback-first'";
  const secondSql = "SELECT 'rollback-second'";
  const blob = composeSqlBlob([firstSql, secondSql]);
  const first = opaqueDispatchAt(blob, 0);
  const second = opaqueDispatchAt(blob, 1);
  const parent: Omit<MigrationParentTransitionV1, "transitionHash"> = {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [],
    rollback: {
      kind: "manual",
      requestedBoundary: "stepwise",
      operations: [
        {
          id: "rollback:first",
          label: "first",
          origin: "manual",
          risk: "opaque",
          steps: [{ retry: "opaque", execute: first }],
        },
        {
          id: "rollback:second",
          label: "second",
          origin: "manual",
          risk: "opaque",
          steps: [{ retry: "opaque", execute: second }],
        },
      ],
    },
  };
  const transitionHash = encodeTransitionHash(parent);
  const state = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name: "rollback",
    snapshotHash: snapshot.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [{ ...parent, transitionHash }],
  });
  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
  await storage.publishSql(blob.sqlHash, blob.bytes);
  await storage.publishState(state.stateId, state.bytes);
  const marker = markerFromPath(
    estate.estateHash,
    snapshot.snapshotHash,
    [{ stateId: state.stateId, transitionHash, baselineBoundary: false }],
    1
  );
  return {
    storage,
    estateHash: estate.estateHash,
    snapshotHash: snapshot.snapshotHash,
    sqlHash: blob.sqlHash,
    stateId: state.stateId,
    transitionHash,
    marker,
    first,
    second,
    firstSql,
    secondSql,
  };
}

async function publishMixedApplyProgram() {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  const snapshot = encodeSnapshot(emptyManagedSnapshot());
  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
  let fromState: string | null = null;
  const boundaries = ["transactional", "stepwise", "transactional"] as const;
  const stateIds: string[] = [];
  const edges: {
    readonly fromState: string | null;
    readonly toState: string;
    readonly snapshotHash: string;
    readonly sqlHash: string;
    readonly transitionHash: string;
    readonly operationId: string;
    readonly dispatch: MigrationDispatchV1;
    readonly sql: string;
  }[] = [];
  for (const [index, boundary] of boundaries.entries()) {
    const statement = `SELECT 'mixed-${index}'`;
    const blob = composeSqlBlob([statement]);
    const dispatch = opaqueDispatchAt(blob, 0);
    const parentBody: Omit<MigrationParentTransitionV1, "transitionHash"> = {
      fromState,
      originChecks: [],
      requestedForwardBoundary: boundary,
      operations: [
        {
          id: `mixed:${index}`,
          label: `mixed ${index}`,
          origin: "manual",
          risk: "opaque",
          steps: [{ retry: "opaque", execute: dispatch }],
        },
      ],
      rollback: { kind: "irreversible", reason: "test" },
    };
    const transitionHash = encodeTransitionHash(parentBody);
    const state = encodeStateManifest({
      format: "1",
      estateHash: estate.estateHash,
      name: `mixed-${index}`,
      snapshotHash: snapshot.snapshotHash,
      sqlHash: blob.sqlHash,
      destinationChecks: [],
      parents: [{ ...parentBody, transitionHash }],
    });
    await storage.publishSql(blob.sqlHash, blob.bytes);
    await storage.publishState(state.stateId, state.bytes);
    edges.push({
      fromState,
      toState: state.stateId,
      snapshotHash: snapshot.snapshotHash,
      sqlHash: blob.sqlHash,
      transitionHash,
      operationId: `mixed:${index}`,
      dispatch,
      sql: statement,
    });
    stateIds.push(state.stateId);
    fromState = state.stateId;
  }
  return {
    storage,
    stateIds,
    edges,
    estateHash: estate.estateHash,
    snapshotHash: snapshot.snapshotHash,
  };
}

function opaqueDispatchAt(
  blob: ReturnType<typeof composeSqlBlob>,
  index: number
): MigrationDispatchV1 {
  const range = blob.ranges[index]!;
  return {
    dispatchId: encodeDispatchIdentity(
      blob.sqlHash,
      range.offset,
      range.length,
      []
    ),
    sqlHash: blob.sqlHash,
    offset: range.offset,
    length: range.length,
    parameters: [],
  };
}

function requiredMigrationDispatch(
  dispatch: MigrationDispatchV1 | undefined
): MigrationDispatchV1 {
  if (!dispatch) throw new Error("expected migration dispatch");
  return dispatch;
}

function rollbackStarted(
  program: Awaited<ReturnType<typeof publishRollbackProgram>>
): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId: "c".repeat(64),
    kind: "started" as const,
    estateHash: program.estateHash,
    snapshotHash: program.snapshotHash,
    sqlHash: program.sqlHash,
    fromState: program.stateId,
    toState: null,
    transitionHash: program.transitionHash,
    direction: "rollback" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-08-29T10:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

function rollbackProgress(
  started: LedgerEventV1,
  operationId: string,
  dispatchId: string,
  effectState: "none" | "committed"
): LedgerEventV1 {
  const { eventId: _eventId, ...startedBody } = started;
  const event = {
    ...startedBody,
    kind: "step-confirmed" as const,
    operationId,
    dispatchId,
    effectState,
    finishedAt: "2026-08-29T10:00:01.000Z",
  };
  return { ...event, eventId: eventIdFor(event) };
}

function resetStarted(options: {
  readonly estateHash: string;
  readonly snapshotHash: string;
  readonly path: readonly string[];
  readonly clearDispatches?: readonly MigrationDispatchV1[];
}): LedgerEventV1 {
  const planBody = {
    estateHash: options.estateHash,
    targetIdentity: "sqlite:",
    sourceRevision: 0,
    sourceFingerprint: options.snapshotHash,
    replayPath: options.path,
    clearDispatches: options.clearDispatches ?? [],
    referencedStates: options.path,
  };
  const resetPlanHash = domainHash(
    HASH_DOMAIN.resetPlan,
    canonicalizeJson(planBody)
  );
  const event = {
    format: "1" as const,
    attemptId: resetPlanHash,
    kind: "reset-started" as const,
    estateHash: options.estateHash,
    snapshotHash: options.snapshotHash,
    sqlHash: null,
    fromState: null,
    toState: options.path.at(-1)!,
    transitionHash: null,
    direction: "reset" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-08-29T10:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    resetPlan: { ...planBody, resetPlanHash },
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

function resetProgress(
  started: LedgerEventV1,
  edge: {
    readonly fromState: string | null;
    readonly toState: string;
    readonly snapshotHash: string;
    readonly sqlHash: string;
    readonly transitionHash: string;
    readonly operationId: string;
    readonly dispatch: MigrationDispatchV1;
  },
  effectState: "none" | "committed"
): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId: started.attemptId,
    kind: "reset-step-confirmed" as const,
    estateHash: started.estateHash,
    snapshotHash: edge.snapshotHash,
    sqlHash: edge.sqlHash,
    fromState: edge.fromState,
    toState: edge.toState,
    transitionHash: edge.transitionHash,
    direction: "reset" as const,
    operationId: edge.operationId,
    dispatchId: edge.dispatch.dispatchId,
    effectState,
    startedAt: "2026-08-29T10:00:01.000Z",
    finishedAt: "2026-08-29T10:00:01.000Z",
    toolVersion: "v1",
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
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
  readonly ledger?: readonly LedgerEventV1[];
  readonly marker?: ReturnType<typeof markerFromPath>;
}) {
  const ledger = options.ledger ?? [];
  return (sql: string, params: unknown[]): unknown[] | Error => {
    const catalog = controlCatalogAnswer(sql, params, {
      state: true,
      log: true,
    });
    if (catalog) return catalog;
    const definition = sqliteControlDefinitionAnswer(sql, {
      state: true,
      log: true,
    });
    if (definition) return definition;
    if (
      sql.includes("SELECT payload FROM") &&
      sql.includes("_viborm_migration_state")
    ) {
      return options.marker
        ? [{ payload: canonicalizeJsonText(options.marker) }]
        : [];
    }
    if (
      sql.includes("SELECT payload FROM") &&
      sql.includes("_viborm_migration_log")
    ) {
      return ledger.map((event) => ({ payload: canonicalizeJsonText(event) }));
    }
    if (
      sql.startsWith("INSERT INTO") ||
      sql.startsWith("UPDATE") ||
      sql.startsWith("CREATE TABLE")
    ) {
      return [{ ok: 1 }];
    }
    return [];
  };
}

describe("migration v1 resolve and reset shapes", () => {
  test("apply keeps transactional edges atomic around a stepwise edge", async () => {
    const program = await publishMixedApplyProgram();
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({});

    await expect(
      applyV1(clientFor(driver), program.storage)
    ).resolves.toMatchObject({ outcome: "applied", path: program.stateIds });
    expect(driver.statements.filter((sql) => sql === "<begin>")).toHaveLength(
      2
    );
  });

  test("reset keeps transactional replay groups atomic around a stepwise edge", async () => {
    const program = await publishMixedApplyProgram();
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({});

    await expect(
      resetV1(clientFor(driver), program.storage)
    ).resolves.toMatchObject({ preview: false, path: program.stateIds });
    expect(driver.statements.filter((sql) => sql === "<begin>")).toHaveLength(
      2
    );
  });

  test("reset resumes after the last committed replay dispatch", async () => {
    const published = await publishRoot({ opaque: true });
    const started = resetStarted({
      estateHash: published.estateHash,
      snapshotHash: published.snapshotHash,
      path: [published.stateId],
    });
    const driver = sqliteEstateDriver();
    const edge = {
      fromState: null,
      toState: published.stateId,
      snapshotHash: published.snapshotHash,
      sqlHash: published.sqlHash,
      transitionHash: published.transitionHash,
      operationId: "manual:forward:0",
      dispatch: requiredMigrationDispatch(published.dispatch),
    };
    driver.respond = controlRespond({
      ledger: [
        started,
        resetProgress(started, edge, "none"),
        resetProgress(started, edge, "committed"),
      ],
    });

    await expect(
      resetV1(clientFor(driver), published.storage)
    ).resolves.toMatchObject({ preview: false, path: [published.stateId] });
    expect(driver.statements).not.toContain("SELECT 1");
  });

  test("reset refuses noncontiguous replay evidence before dispatch", async () => {
    const program = await publishMixedApplyProgram();
    const started = resetStarted({
      estateHash: program.estateHash,
      snapshotHash: program.snapshotHash,
      path: program.stateIds,
    });
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [started, resetProgress(started, program.edges[1]!, "committed")],
    });

    await expect(
      resetV1(clientFor(driver), program.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("contiguous dispatch prefix"),
    });
    expect(driver.statements.some((sql) => sql.includes("mixed-"))).toBe(false);
  });

  test("reset refuses replay evidence before the stored clear prefix completes", async () => {
    const published = await publishRoot({ opaque: true });
    const clearBlob = composeSqlBlob(["DROP TABLE leftover"]);
    const started = resetStarted({
      estateHash: published.estateHash,
      snapshotHash: published.snapshotHash,
      path: [published.stateId],
      clearDispatches: [opaqueDispatchAt(clearBlob, 0)],
    });
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        started,
        resetProgress(
          started,
          {
            fromState: null,
            toState: published.stateId,
            snapshotHash: published.snapshotHash,
            sqlHash: published.sqlHash,
            transitionHash: published.transitionHash,
            operationId: "manual:forward:0",
            dispatch: requiredMigrationDispatch(published.dispatch),
          },
          "committed"
        ),
      ],
    });

    await expect(
      resetV1(clientFor(driver), published.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("clear prefix"),
    });
    expect(driver.statements).not.toContain("SELECT 1");
  });

  test("reset refuses an announced opaque replay dispatch as ambiguous", async () => {
    const published = await publishRoot({ opaque: true });
    const started = resetStarted({
      estateHash: published.estateHash,
      snapshotHash: published.snapshotHash,
      path: [published.stateId],
    });
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        started,
        resetProgress(
          started,
          {
            fromState: null,
            toState: published.stateId,
            snapshotHash: published.snapshotHash,
            sqlHash: published.sqlHash,
            transitionHash: published.transitionHash,
            operationId: "manual:forward:0",
            dispatch: requiredMigrationDispatch(published.dispatch),
          },
          "none"
        ),
      ],
    });

    await expect(
      resetV1(clientFor(driver), published.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
    });
    expect(driver.statements).not.toContain("SELECT 1");
  });

  test("down resumes after the last committed rollback dispatch", async () => {
    const program = await publishRollbackProgram();
    const started = rollbackStarted(program);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      marker: program.marker,
      ledger: [
        started,
        rollbackProgress(
          started,
          "rollback:first",
          program.first.dispatchId,
          "committed"
        ),
      ],
    });

    await expect(
      downV1(clientFor(driver), program.storage, { steps: 1 })
    ).resolves.toMatchObject({ preview: false, path: [program.stateId] });
    expect(driver.statements).not.toContain(program.firstSql);
    expect(driver.statements).toContain(program.secondSql);
  });

  test("down closes the marker-CAS crash window without replaying rollback", async () => {
    const program = await publishRollbackProgram();
    const started = rollbackStarted(program);
    const marker = markerFromPath(
      program.estateHash,
      program.snapshotHash,
      [],
      program.marker.revision + 1
    );
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      marker,
      ledger: [
        started,
        rollbackProgress(
          started,
          "rollback:first",
          program.first.dispatchId,
          "committed"
        ),
        rollbackProgress(
          started,
          "rollback:second",
          program.second.dispatchId,
          "committed"
        ),
      ],
    });

    await expect(
      downV1(clientFor(driver), program.storage, { steps: 1 })
    ).resolves.toMatchObject({ preview: false, path: [program.stateId] });
    expect(driver.statements).not.toContain(program.firstSql);
    expect(driver.statements).not.toContain(program.secondSql);
  });

  test("down refuses an opaque dispatch whose durable outcome is ambiguous", async () => {
    const program = await publishRollbackProgram();
    const started = rollbackStarted(program);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      marker: program.marker,
      ledger: [
        started,
        rollbackProgress(
          started,
          "rollback:first",
          program.first.dispatchId,
          "none"
        ),
      ],
    });

    await expect(
      downV1(clientFor(driver), program.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
    });
    expect(driver.statements).not.toContain(program.firstSql);
    expect(driver.statements).not.toContain(program.secondSql);
  });

  test("resolve complete, rolled-back, and retry shapes", async () => {
    const published = await publishRoot();
    const completeDriver = sqliteEstateDriver();
    completeDriver.respond = controlRespond({
      ledger: [startedEvent(published.stateId, published.estateHash)],
    });
    expect(
      await resolveV1(clientFor(completeDriver), published.storage, {
        outcome: "complete",
      })
    ).toEqual({ outcome: "complete" });

    const rolledBackDriver = sqliteEstateDriver();
    rolledBackDriver.respond = controlRespond({
      ledger: [startedEvent(published.stateId, published.estateHash)],
    });
    expect(
      await resolveV1(clientFor(rolledBackDriver), published.storage, {
        outcome: "rolled-back",
      })
    ).toEqual({ outcome: "rolled-back" });

    const retryDriver = sqliteEstateDriver();
    retryDriver.respond = controlRespond({
      ledger: [startedEvent(published.stateId, published.estateHash)],
    });
    expect(
      await resolveV1(clientFor(retryDriver), published.storage, {
        outcome: "retry",
      })
    ).toEqual({ outcome: "retry" });
    expectTypeOf<ResolveV1Options["outcome"]>().toEqualTypeOf<
      "complete" | "rolled-back" | "retry"
    >();
  });

  test("resolve completes a generated structural opaque step from a fingerprint", async () => {
    const storage = new MemoryEstateStorage();
    const estate = encodeEstateDescriptor({ dialect: "sqlite" });
    const snapshot = encodeSnapshot(emptyManagedSnapshot());
    const blob = composeSqlBlob(["ALTER TABLE item ADD COLUMN name TEXT"]);
    await storage.publishEstate(estate.bytes);
    await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
    await storage.publishSql(blob.sqlHash, blob.bytes);
    const parent: Omit<MigrationParentTransitionV1, "transitionHash"> = {
      fromState: null,
      originChecks: [],
      requestedForwardBoundary: null,
      operations: [
        {
          id: "addColumn:0",
          label: "addColumn",
          origin: "generated",
          risk: "safe",
          steps: [{ retry: "opaque", execute: opaqueDispatch(blob) }],
        },
      ],
      rollback: { kind: "irreversible", reason: "no inverse" },
    };
    const encoded = encodeStateManifest({
      format: "1",
      estateHash: estate.estateHash,
      name: "generated",
      snapshotHash: snapshot.snapshotHash,
      sqlHash: blob.sqlHash,
      destinationChecks: [],
      parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
    });
    await storage.publishState(encoded.stateId, encoded.bytes);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [startedEvent(encoded.stateId, estate.estateHash)],
    });
    expect(
      await resolveV1(clientFor(driver), storage, { outcome: "complete" })
    ).toEqual({ outcome: "complete" });
  });

  test("resolve refuses opaque data without the required state checks", async () => {
    const published = await publishRoot({ opaque: true });
    for (const outcome of ["complete", "rolled-back", "retry"] as const) {
      const driver = sqliteEstateDriver();
      driver.respond = controlRespond({
        ledger: [startedEvent(published.stateId, published.estateHash)],
      });
      await expect(
        resolveV1(clientFor(driver), published.storage, { outcome })
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      });
    }
  });

  test("resolve refuses multiple unfinished attempts", async () => {
    const published = await publishRoot();
    const first = startedEvent(published.stateId, published.estateHash);
    const { eventId: _eventId, ...firstBody } = first;
    const secondBody = { ...firstBody, attemptId: "f".repeat(64) };
    const second = { ...secondBody, eventId: eventIdFor(secondBody) };
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({ ledger: [first, second] });

    await expect(
      resolveV1(clientFor(driver), published.storage, { outcome: "complete" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    expect(driver.statements.some((sql) => sql.startsWith("UPDATE"))).toBe(
      false
    );
  });

  test("reset resumes a stored plan after remaining clears shrink", async () => {
    const published = await publishRoot();
    const emptySnapshot = encodeSnapshot(emptyManagedSnapshot()).snapshotHash;
    const leftoverBytes = new TextEncoder().encode("DROP TABLE leftover");
    const leftover = encodeSqlBlob(leftoverBytes);
    const leftoverDispatch = {
      dispatchId: encodeDispatchIdentity(leftover, 0, leftoverBytes.length, []),
      sqlHash: leftover,
      offset: 0,
      length: leftoverBytes.length,
      parameters: [] as const,
    };
    const planBody = {
      estateHash: published.estateHash,
      targetIdentity: "sqlite:",
      sourceRevision: 0,
      sourceFingerprint: emptySnapshot,
      replayPath: [published.stateId],
      clearDispatches: [leftoverDispatch],
      referencedStates: [published.stateId],
    };
    const resetPlanHash = domainHash(
      HASH_DOMAIN.resetPlan,
      canonicalizeJson(planBody)
    );
    const started = {
      format: "1" as const,
      attemptId: resetPlanHash,
      kind: "reset-started" as const,
      estateHash: published.estateHash,
      snapshotHash: emptySnapshot,
      sqlHash: null,
      fromState: null,
      toState: published.stateId,
      transitionHash: null,
      direction: "reset" as const,
      operationId: null,
      dispatchId: null,
      effectState: "none" as const,
      startedAt: "2026-08-28T00:00:00.000Z",
      finishedAt: null,
      toolVersion: "v1",
      resetPlan: { ...planBody, resetPlanHash },
      failure: null,
    };
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [{ ...started, eventId: eventIdFor(started) }],
    });
    const result = await resetV1(clientFor(driver), published.storage);
    expect(result.preview).toBe(false);
    expect(result.path).toEqual([published.stateId]);
  });

  test("reset closes a crashed CAS when the marker already names the target", async () => {
    const published = await publishRoot();
    const emptySnapshot = encodeSnapshot(emptyManagedSnapshot()).snapshotHash;
    const parent = emptyParent();
    const marker = markerFromPath(
      published.estateHash,
      emptySnapshot,
      [
        {
          stateId: published.stateId,
          transitionHash: encodeTransitionHash(parent),
          baselineBoundary: false,
        },
      ],
      1
    );
    const planBody = {
      estateHash: published.estateHash,
      targetIdentity: "sqlite:",
      sourceRevision: 0,
      sourceFingerprint: emptySnapshot,
      replayPath: [published.stateId],
      clearDispatches: [] as const,
      referencedStates: [published.stateId],
    };
    const resetPlanHash = domainHash(
      HASH_DOMAIN.resetPlan,
      canonicalizeJson(planBody)
    );
    const started = {
      format: "1" as const,
      attemptId: resetPlanHash,
      kind: "reset-started" as const,
      estateHash: published.estateHash,
      snapshotHash: emptySnapshot,
      sqlHash: null,
      fromState: null,
      toState: published.stateId,
      transitionHash: null,
      direction: "reset" as const,
      operationId: null,
      dispatchId: null,
      effectState: "none" as const,
      startedAt: "2026-08-28T00:00:00.000Z",
      finishedAt: null,
      toolVersion: "v1",
      resetPlan: { ...planBody, resetPlanHash },
      failure: null,
    };
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [{ ...started, eventId: eventIdFor(started) }],
      marker,
    });
    const result = await resetV1(clientFor(driver), published.storage);
    expect(result.preview).toBe(false);
    expect(result.path).toEqual([published.stateId]);
    expect(driver.statements.some((sql) => sql.startsWith("UPDATE"))).toBe(
      false
    );
  });

  test("reset does not mistake an unchanged same-target marker for a completed reset", async () => {
    const published = await publishRoot();
    const emptySnapshot = encodeSnapshot(emptyManagedSnapshot()).snapshotHash;
    const parent = emptyParent();
    const marker = markerFromPath(
      published.estateHash,
      emptySnapshot,
      [
        {
          stateId: published.stateId,
          transitionHash: encodeTransitionHash(parent),
          baselineBoundary: false,
        },
      ],
      1
    );
    const planBody = {
      estateHash: published.estateHash,
      targetIdentity: "sqlite:",
      sourceRevision: marker.revision,
      sourceFingerprint: marker.snapshotHash,
      replayPath: [published.stateId],
      clearDispatches: [] as const,
      referencedStates: [published.stateId],
    };
    const resetPlanHash = domainHash(
      HASH_DOMAIN.resetPlan,
      canonicalizeJson(planBody)
    );
    const started = {
      format: "1" as const,
      attemptId: resetPlanHash,
      kind: "reset-started" as const,
      estateHash: published.estateHash,
      snapshotHash: emptySnapshot,
      sqlHash: null,
      fromState: published.stateId,
      toState: published.stateId,
      transitionHash: null,
      direction: "reset" as const,
      operationId: null,
      dispatchId: null,
      effectState: "none" as const,
      startedAt: "2026-08-28T00:00:00.000Z",
      finishedAt: null,
      toolVersion: "v1",
      resetPlan: { ...planBody, resetPlanHash },
      failure: null,
    };
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [{ ...started, eventId: eventIdFor(started) }],
      marker,
    });

    const result = await resetV1(clientFor(driver), published.storage);

    expect(result).toEqual({ preview: false, path: [published.stateId] });
    expect(driver.statements.some((sql) => sql.startsWith("UPDATE"))).toBe(
      true
    );
  });

  test("reset refuses multiple unfinished attempts without selecting one", async () => {
    const published = await publishRoot();
    const emptySnapshot = encodeSnapshot(emptyManagedSnapshot()).snapshotHash;
    const planBody = {
      estateHash: published.estateHash,
      targetIdentity: "sqlite:",
      sourceRevision: 0,
      sourceFingerprint: emptySnapshot,
      replayPath: [published.stateId],
      clearDispatches: [] as const,
      referencedStates: [published.stateId],
    };
    const resetPlanHash = domainHash(
      HASH_DOMAIN.resetPlan,
      canonicalizeJson(planBody)
    );
    const resetStarted = {
      format: "1" as const,
      attemptId: resetPlanHash,
      kind: "reset-started" as const,
      estateHash: published.estateHash,
      snapshotHash: emptySnapshot,
      sqlHash: null,
      fromState: null,
      toState: published.stateId,
      transitionHash: null,
      direction: "reset" as const,
      operationId: null,
      dispatchId: null,
      effectState: "none" as const,
      startedAt: "2026-08-28T00:00:00.000Z",
      finishedAt: null,
      toolVersion: "v1",
      resetPlan: { ...planBody, resetPlanHash },
      failure: null,
    };
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        { ...resetStarted, eventId: eventIdFor(resetStarted) },
        startedEvent(published.stateId, published.estateHash),
      ],
    });

    await expect(
      resetV1(clientFor(driver), published.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT,
    });
    expect(driver.statements.some((sql) => sql.startsWith("UPDATE"))).toBe(
      false
    );

    const mismatchedBody = {
      ...resetStarted,
      toState: "f".repeat(64),
    };
    const mismatchedDriver = sqliteEstateDriver();
    mismatchedDriver.respond = controlRespond({
      ledger: [{ ...mismatchedBody, eventId: eventIdFor(mismatchedBody) }],
    });
    await expect(
      resetV1(clientFor(mismatchedDriver), published.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    expect(
      mismatchedDriver.statements.some((sql) => sql.startsWith("UPDATE"))
    ).toBe(false);
  });

  test("reset does not call applyV1", async () => {
    const published = await publishRoot();
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({});
    const spy = vi.spyOn(applyModule, "applyV1");
    const preview = await resetV1(clientFor(driver), published.storage, {
      dryRun: true,
    });
    expect(preview.preview).toBe(true);
    expect(preview.path).toEqual([published.stateId]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
