import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import {
  canonicalizeJson,
  canonicalizeJsonText,
} from "@src/migrations/canonical-json";
import {
  assertControlTablesAuthentic,
  DEFAULT_CONTROL_BASE,
  inspectControlPresence,
  markerFromPath,
  readControlState,
} from "@src/migrations/control";
import type { BoundMigrationDriver } from "@src/migrations/drivers";
import { getMigrationDriver } from "@src/migrations/drivers";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { domainHash, HASH_DOMAIN } from "@src/migrations/identity";
import {
  baselineV1,
  downV1,
  resolveV1,
  statusV1,
  verifyV1,
} from "@src/migrations/operators";
import { resetV1 } from "@src/migrations/reset-v1";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeStateManifest,
  encodeTransitionHash,
  eventIdFor,
} from "@src/migrations/v1-parse";
import type {
  LedgerEventV1,
  MigrationParentTransitionV1,
  ResetPlanV1,
} from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  type RecordingDriver,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

const user = s.model({ id: s.string().id() });
const HASH_A = "a".repeat(64);

function clientFor(driver: RecordingDriver) {
  return { $driver: driver, $schema: { user } };
}

async function publishRoot() {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  const snapshot = encodeSnapshot(emptyManagedSnapshot());
  const blob = composeSqlBlob([]);
  const parentBody: Omit<MigrationParentTransitionV1, "transitionHash"> = {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [],
    rollback: { kind: "irreversible", reason: "command fixture" },
  };
  const transitionHash = encodeTransitionHash(parentBody);
  const state = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name: "root",
    snapshotHash: snapshot.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [{ ...parentBody, transitionHash }],
  });
  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
  await storage.publishSql(blob.sqlHash, blob.bytes);
  await storage.publishState(state.stateId, state.bytes);
  return {
    storage,
    estateHash: estate.estateHash,
    snapshotHash: snapshot.snapshotHash,
    stateId: state.stateId,
    transitionHash,
  };
}

function startedEvent(options: {
  readonly estateHash: string;
  readonly snapshotHash: string;
  readonly stateId: string;
  readonly direction?: "forward" | "rollback";
}): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId: HASH_A,
    kind: "started" as const,
    estateHash: options.estateHash,
    snapshotHash: options.snapshotHash,
    sqlHash: null,
    fromState: options.direction === "rollback" ? options.stateId : null,
    toState: options.direction === "rollback" ? null : options.stateId,
    transitionHash: null,
    direction: options.direction ?? ("forward" as const),
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-08-31T00:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

function resetStarted(options: {
  readonly estateHash: string;
  readonly snapshotHash: string;
  readonly stateId: string;
}): LedgerEventV1 {
  const planBody: Omit<ResetPlanV1, "resetPlanHash"> = {
    estateHash: options.estateHash,
    targetIdentity: "sqlite:",
    sourceRevision: 0,
    sourceFingerprint: options.snapshotHash,
    replayPath: [options.stateId],
    clearDispatches: [],
    referencedStates: [options.stateId],
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
    toState: options.stateId,
    transitionHash: null,
    direction: "reset" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-08-31T00:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    resetPlan: { ...planBody, resetPlanHash },
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

function controlRespond(options: {
  readonly marker?: ReturnType<typeof markerFromPath>;
  readonly ledger?: readonly LedgerEventV1[];
  readonly objectPayloads?: boolean;
}) {
  const ledger = options.ledger ?? [];
  return (statement: string, parameters: unknown[]): unknown[] | Error => {
    const catalog = controlCatalogAnswer(statement, parameters, {
      state: true,
      log: true,
    });
    if (catalog) return catalog;
    const definition = sqliteControlDefinitionAnswer(statement, {
      state: true,
      log: true,
    });
    if (definition) return definition;
    if (
      statement.includes("SELECT payload FROM") &&
      statement.includes("_viborm_migration_state")
    ) {
      if (!options.marker) return [];
      return [
        {
          payload: options.objectPayloads
            ? options.marker
            : canonicalizeJsonText(options.marker),
        },
      ];
    }
    if (
      statement.includes("SELECT payload FROM") &&
      statement.includes("_viborm_migration_log")
    ) {
      return ledger.map((event) => ({
        payload: options.objectPayloads ? event : canonicalizeJsonText(event),
      }));
    }
    return [];
  };
}

function exactSqliteControlCommand(
  driver: BoundMigrationDriver
): BoundMigrationDriver {
  const command: BoundMigrationDriver = Object.create(driver);
  Object.defineProperty(command, "introspect", {
    value: async () => ({
      tables: [
        {
          name: "_viborm_migration_state",
          columns: [
            { name: "singleton", type: "INTEGER", nullable: false },
            { name: "payload", type: "TEXT", nullable: false },
          ],
          primaryKey: {
            name: "_viborm_migration_state_pkey",
            columns: ["singleton"],
          },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "_viborm_migration_log",
          columns: [
            { name: "event_id", type: "TEXT", nullable: false },
            { name: "attempt_id", type: "TEXT", nullable: false },
            { name: "kind", type: "TEXT", nullable: false },
            { name: "payload", type: "TEXT", nullable: false },
          ],
          primaryKey: {
            name: "_viborm_migration_log_pkey",
            columns: ["event_id"],
          },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    }),
  });
  return command;
}

describe("migration operator command boundaries", () => {
  test("status reports the unique root as pending with present empty control", async () => {
    const published = await publishRoot();
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({});

    await expect(
      statusV1(clientFor(driver), published.storage)
    ).resolves.toEqual({
      control: "present",
      marker: null,
      pending: [published.stateId],
      unfinished: false,
    });
  });

  test("verify distinguishes absent control from a present pair without a marker", async () => {
    const published = await publishRoot();
    const absent = sqliteEstateDriver();
    await expect(
      verifyV1(clientFor(absent), published.storage)
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_NOT_FOUND });

    const markerless = sqliteEstateDriver();
    markerless.respond = controlRespond({});
    await expect(
      verifyV1(clientFor(markerless), published.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_NOT_FOUND,
      message: expect.stringContaining("marker"),
    });
  });

  test("baseline refuses a database that already has a marker", async () => {
    const published = await publishRoot();
    const marker = markerFromPath(
      published.estateHash,
      published.snapshotHash,
      [
        {
          stateId: published.stateId,
          transitionHash: published.transitionHash,
          baselineBoundary: false,
        },
      ],
      1
    );
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({ marker });

    await expect(
      baselineV1(clientFor(driver), published.storage, {
        to: { id: published.stateId },
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("unmarked database"),
    });
  });

  test("dry-run down refuses a present control plane without a marker", async () => {
    const published = await publishRoot();
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({});

    await expect(
      downV1(clientFor(driver), published.storage, { dryRun: true })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_NOT_FOUND,
      message: expect.stringContaining("Nothing to roll back"),
    });
  });

  test("resolve distinguishes no attempt, reset, and rollback ownership", async () => {
    const published = await publishRoot();
    const noAttempt = sqliteEstateDriver();
    noAttempt.respond = controlRespond({});
    await expect(
      resolveV1(clientFor(noAttempt), published.storage, {
        outcome: "complete",
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("requires an unfinished attempt"),
    });

    const reset = sqliteEstateDriver();
    reset.respond = controlRespond({
      ledger: [
        resetStarted({
          estateHash: published.estateHash,
          snapshotHash: published.snapshotHash,
          stateId: published.stateId,
        }),
      ],
    });
    await expect(
      resolveV1(clientFor(reset), published.storage, { outcome: "complete" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("reset"),
    });

    const rollback = sqliteEstateDriver();
    rollback.respond = controlRespond({
      ledger: [
        startedEvent({
          estateHash: published.estateHash,
          snapshotHash: published.snapshotHash,
          stateId: published.stateId,
          direction: "rollback",
        }),
      ],
    });
    await expect(
      resolveV1(clientFor(rollback), published.storage, {
        outcome: "complete",
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("rollback"),
    });
  });

  test("reset refuses an unfinished non-reset attempt before live planning", async () => {
    const published = await publishRoot();
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        startedEvent({
          estateHash: published.estateHash,
          snapshotHash: published.snapshotHash,
          stateId: published.stateId,
        }),
      ],
    });

    await expect(
      resetV1(clientFor(driver), published.storage, {
        to: { id: published.stateId },
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT,
    });
    expect(
      driver.statements.some((statement) => statement.startsWith("DROP"))
    ).toBe(false);
  });
});

describe("migration control command boundaries", () => {
  test("control reads accept already-decoded payloads", async () => {
    const published = await publishRoot();
    const marker = markerFromPath(
      published.estateHash,
      published.snapshotHash,
      [],
      1
    );
    const event = startedEvent({
      estateHash: published.estateHash,
      snapshotHash: published.snapshotHash,
      stateId: published.stateId,
    });
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      marker,
      ledger: [event],
      objectPayloads: true,
    });

    await expect(
      readControlState(driver, getMigrationDriver(driver), DEFAULT_CONTROL_BASE)
    ).resolves.toMatchObject({ marker, ledger: [event] });
  });

  test("catalog probes reject a non-singleton answer", async () => {
    const driver = sqliteEstateDriver();
    driver.respond = (statement) =>
      statement.includes("EXISTS") ? [{ exists: 0 }, { exists: 0 }] : [];

    await expect(
      inspectControlPresence(
        driver,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("exactly one row"),
    });
  });

  test("the singleton-check probe rejects multiple definition rows", async () => {
    const driver = sqliteEstateDriver();
    const command = exactSqliteControlCommand(getMigrationDriver(driver));
    driver.respond = (statement) => {
      if (
        statement.startsWith("SELECT sql FROM sqlite_master") &&
        statement.includes("type = 'table'")
      ) {
        const definition = {
          sql: "CREATE TABLE _viborm_migration_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), payload TEXT NOT NULL)",
        };
        return [definition, definition];
      }
      const definition = sqliteControlDefinitionAnswer(statement, {
        state: true,
        log: true,
      });
      return definition ?? [];
    };

    await expect(
      assertControlTablesAuthentic(driver, command, DEFAULT_CONTROL_BASE)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
  });

  test("the attachment probe rejects an invalid flag", async () => {
    const driver = sqliteEstateDriver();
    const command = exactSqliteControlCommand(getMigrationDriver(driver));
    driver.respond = (statement) => {
      if (statement.includes("AS attached")) {
        return [{ attached: "unknown" }];
      }
      const definition = sqliteControlDefinitionAnswer(statement, {
        state: true,
        log: true,
      });
      return definition ?? [];
    };

    await expect(
      assertControlTablesAuthentic(driver, command, DEFAULT_CONTROL_BASE)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
  });
});

describe("coverage low value", () => {
  test("control introspection wraps an ordinary provider error", async () => {
    const driver = sqliteEstateDriver();
    const command: BoundMigrationDriver = Object.create(
      getMigrationDriver(driver)
    );
    Object.defineProperty(command, "introspect", {
      value: () => Promise.reject(new Error("catalog unavailable")),
    });

    await expect(
      assertControlTablesAuthentic(driver, command, DEFAULT_CONTROL_BASE)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      originalCause: expect.any(Error),
    });
  });
});
