import { createClient } from "@client/client";
import { s } from "@schema";
import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
// biome-ignore lint/performance/noNamespaceImport: vi.spyOn needs the module object
import * as applyModule from "@src/migrations/apply-v1";
import {
  canonicalizeJson,
  canonicalizeJsonText,
} from "@src/migrations/canonical-json";
import { createMigrationClient } from "@src/migrations/client";
import { markerFromPath, unfinishedAttempts } from "@src/migrations/control";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { generateV1 } from "@src/migrations/generate-v1";
import { domainHash, HASH_DOMAIN } from "@src/migrations/identity";
import { resolveV1 } from "@src/migrations/operators";
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
  return { storage, stateId: encoded.stateId, estateHash: estate.estateHash };
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
    if (sql.includes("sqlite_master") || sql.includes("PRAGMA")) {
      return [];
    }
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
