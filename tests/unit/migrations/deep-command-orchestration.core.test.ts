import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import {
  canonicalizeJson,
  canonicalizeJsonText,
} from "@src/migrations/canonical-json";
import { markerFromPath } from "@src/migrations/control";
import type { BoundMigrationDriver } from "@src/migrations/drivers";
import { getMigrationDriver } from "@src/migrations/drivers";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { domainHash, HASH_DOMAIN } from "@src/migrations/identity";
import { planLiveNamespaceReset } from "@src/migrations/live-reset";
import { downV1, resolveV1 } from "@src/migrations/operators";
import { resetV1 } from "@src/migrations/reset-v1";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import type { SchemaSnapshot, TableDef } from "@src/migrations/types";
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
  mysqlEstateDriver,
  pgEstateDriver,
  type RecordingDriver,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

const user = s.model({ id: s.string().id() });
const ATTEMPT_ID = "a".repeat(64);

function clientFor(driver: RecordingDriver) {
  return { $driver: driver, $schema: { user } };
}

async function publishReversibleRoot() {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  const snapshot = encodeSnapshot(emptyManagedSnapshot());
  const blob = composeSqlBlob([]);
  const parentBody: Omit<MigrationParentTransitionV1, "transitionHash"> = {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [],
    rollback: { kind: "schema", operations: [] },
  };
  const transitionHash = encodeTransitionHash(parentBody);
  const state = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name: "reversible-root",
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
    sqlHash: blob.sqlHash,
    stateId: state.stateId,
    transitionHash,
  };
}

function startedEvent(
  program: Awaited<ReturnType<typeof publishReversibleRoot>>,
  direction: "forward" | "rollback",
  changes: {
    readonly estateHash?: string;
    readonly transitionHash?: string | null;
  } = {}
): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId: ATTEMPT_ID,
    kind: "started" as const,
    estateHash: program.estateHash,
    snapshotHash: program.snapshotHash,
    sqlHash: program.sqlHash,
    fromState: direction === "rollback" ? program.stateId : null,
    toState: direction === "rollback" ? null : program.stateId,
    transitionHash: program.transitionHash,
    direction,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-08-31T00:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    failure: null,
    ...changes,
  };
  return { ...event, eventId: eventIdFor(event) };
}

function resetStarted(
  program: Awaited<ReturnType<typeof publishReversibleRoot>>
): LedgerEventV1 {
  const planBody: Omit<ResetPlanV1, "resetPlanHash"> = {
    estateHash: program.estateHash,
    targetIdentity: "sqlite:",
    sourceRevision: 0,
    sourceFingerprint: program.snapshotHash,
    replayPath: [program.stateId],
    clearDispatches: [],
    referencedStates: [program.stateId],
  };
  const resetPlanHash = domainHash(
    HASH_DOMAIN.resetPlan,
    canonicalizeJson(planBody)
  );
  const event = {
    format: "1" as const,
    attemptId: resetPlanHash,
    kind: "reset-started" as const,
    estateHash: program.estateHash,
    snapshotHash: program.snapshotHash,
    sqlHash: null,
    fromState: null,
    toState: program.stateId,
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
  readonly ledger: readonly LedgerEventV1[];
}) {
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
      return options.marker
        ? [{ payload: canonicalizeJsonText(options.marker) }]
        : [];
    }
    if (
      statement.includes("SELECT payload FROM") &&
      statement.includes("_viborm_migration_log")
    ) {
      return options.ledger.map((event) => ({
        payload: canonicalizeJsonText(event),
      }));
    }
    if (statement.startsWith("INSERT") || statement.startsWith("UPDATE")) {
      return [{ changed: 1 }];
    }
    return [];
  };
}

function table(
  name: string,
  foreignKeys: TableDef["foreignKeys"] = []
): TableDef {
  return {
    name,
    columns: [{ name: "id", type: "integer", nullable: false }],
    primaryKey: { name: `${name}_pkey`, columns: ["id"] },
    indexes: [],
    foreignKeys,
    uniqueConstraints: [],
  };
}

function foreignKey(name: string, referencedTable: string) {
  return {
    name,
    columns: ["parent_id"],
    referencedTable,
    referencedColumns: ["id"],
  };
}

function commandWithInventory(
  base: BoundMigrationDriver,
  snapshot: SchemaSnapshot,
  options: {
    readonly tables: readonly string[];
    readonly enums?: readonly string[];
  }
): BoundMigrationDriver {
  const command: BoundMigrationDriver = Object.create(base);
  Object.defineProperties(command, {
    introspect: { value: () => Promise.resolve(snapshot) },
    generateInventoryTables: {
      value: () => ({ sql: "TABLE INVENTORY", params: [] }),
    },
    generateInventoryEnums: {
      value: () =>
        options.enums ? { sql: "ENUM INVENTORY", params: [] } : null,
    },
  });
  return command;
}

function inventoryRespond(options: {
  readonly tables: readonly string[];
  readonly enums?: readonly string[];
}) {
  return (statement: string): unknown[] | Error => {
    if (statement === "TABLE INVENTORY") {
      return options.tables.map((name) => ({ name }));
    }
    if (statement === "ENUM INVENTORY") {
      return (options.enums ?? []).map((name) => ({ name }));
    }
    return [];
  };
}

describe("deep migration operator orchestration", () => {
  test("down closes a completed root rollback after the marker CAS crash window", async () => {
    const program = await publishReversibleRoot();
    const rollback = startedEvent(program, "rollback");
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({ ledger: [rollback] });

    await expect(downV1(clientFor(driver), program.storage)).resolves.toEqual({
      path: [program.stateId],
      preview: false,
    });
    expect(
      driver.statements.some(
        (statement) =>
          statement.startsWith("INSERT") && statement.includes("_log")
      )
    ).toBe(true);
  });

  test("down authenticates the unfinished rollback edge before closing it", async () => {
    const program = await publishReversibleRoot();
    const missingIdentity = startedEvent(program, "rollback", {
      transitionHash: null,
    });
    const missingDriver = sqliteEstateDriver();
    missingDriver.respond = controlRespond({ ledger: [missingIdentity] });
    await expect(
      downV1(clientFor(missingDriver), program.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("edge identity"),
    });

    const wrongEstate = startedEvent(program, "rollback", {
      estateHash: "b".repeat(64),
    });
    const mismatchDriver = sqliteEstateDriver();
    mismatchDriver.respond = controlRespond({ ledger: [wrongEstate] });
    await expect(
      downV1(clientFor(mismatchDriver), program.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("authenticated estate edge"),
    });
  });

  test("resolve rolled-back repairs a marker that advanced before its terminal event", async () => {
    const program = await publishReversibleRoot();
    const forward = startedEvent(program, "forward");
    const marker = markerFromPath(
      program.estateHash,
      program.snapshotHash,
      [
        {
          stateId: program.stateId,
          transitionHash: program.transitionHash,
          baselineBoundary: false,
        },
      ],
      1
    );
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({ marker, ledger: [forward] });

    await expect(
      resolveV1(clientFor(driver), program.storage, {
        outcome: "rolled-back",
      })
    ).resolves.toEqual({ outcome: "rolled-back" });
    expect(
      driver.statements.some((statement) => statement.startsWith("UPDATE"))
    ).toBe(true);
  });
});

describe("deep reset orchestration", () => {
  test("reset refuses a source marker whose revision no longer matches its stored plan", async () => {
    const program = await publishReversibleRoot();
    const attempt = resetStarted(program);
    const marker = markerFromPath(
      program.estateHash,
      program.snapshotHash,
      [],
      1
    );
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({ marker, ledger: [attempt] });

    await expect(
      resetV1(clientFor(driver), program.storage, {
        to: { id: program.stateId },
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
      message: expect.stringContaining("source marker"),
    });
    expect(
      driver.statements.some((statement) => statement.startsWith("DROP"))
    ).toBe(false);
  });
});

describe("deep live reset planning", () => {
  test("plans owned foreign keys, cyclic tables, preserved tables, and enums before effects", async () => {
    const snapshot: SchemaSnapshot = {
      tables: [
        table("parent", [foreignKey("parent_child_fk", "child")]),
        table("child", [foreignKey("child_parent_fk", "parent")]),
        table("self", [foreignKey("self_fk", "self")]),
        table("catalog_only", [foreignKey("ignored_fk", "parent")]),
      ],
      enums: [{ name: "status", values: ["open", "closed"] }],
    };
    const tables = ["_track", "kept", "parent", "child", "self"];
    const enums = ["status"];
    const driver = pgEstateDriver("tenant");
    driver.respond = inventoryRespond({ tables, enums });
    const command = commandWithInventory(getMigrationDriver(driver), snapshot, {
      tables,
      enums,
    });

    const plan = await planLiveNamespaceReset(driver, command, {
      trackingTable: "preserve",
      trackingTableName: "_track",
      preserveTables: ["kept"],
    });

    expect(plan.tables).toEqual(tables);
    expect(plan.clearTracking).toContain("_track");
    expect(plan.dropForeignKeys).toHaveLength(3);
    expect(plan.dropTables.map(({ name }) => name)).toEqual([
      "self",
      "parent",
      "child",
    ]);
    expect(plan.dropEnums).toHaveLength(1);
    expect(
      driver.statements.some((statement) => statement.startsWith("DROP"))
    ).toBe(false);
  });

  test("MySQL refuses an inbound tracking-table reference during planning", async () => {
    const snapshot: SchemaSnapshot = {
      tables: [table("application", [foreignKey("history_fk", "_track")])],
      enums: [],
    };
    const tables = ["_track", "application"];
    const driver = mysqlEstateDriver({
      namespace: "tenant",
      attested: true,
    });
    driver.respond = inventoryRespond({ tables });
    const command = commandWithInventory(getMigrationDriver(driver), snapshot, {
      tables,
    });

    await expect(
      planLiveNamespaceReset(driver, command, {
        trackingTable: "preserve",
        trackingTableName: "_track",
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: expect.objectContaining({ constraint: "history_fk" }),
    });
    expect(
      driver.statements.some((statement) => statement.startsWith("DROP"))
    ).toBe(false);
  });
});
