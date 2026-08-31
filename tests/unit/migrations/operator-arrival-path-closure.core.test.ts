import { VibORMErrorCode } from "@src/errors";
import { canonicalizeJsonText } from "@src/migrations/canonical-json";
import { markerFromPath } from "@src/migrations/control";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { generateV1 } from "@src/migrations/generate-v1";
import { baselineV1, downV1, statusV1 } from "@src/migrations/operators";
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
  MigrationMarkerV1,
  MigrationParentTransitionV1,
} from "@src/migrations/v1-types";
import { s } from "@src/schema";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  pgEstateDriver,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

async function publishArrivalGraph() {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  const snapshot = encodeSnapshot(emptyManagedSnapshot());
  const blob = composeSqlBlob([]);
  const rootTransitionBody: Omit<
    MigrationParentTransitionV1,
    "transitionHash"
  > = {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [],
    rollback: { kind: "schema", operations: [] },
  };
  const rootTransitionHash = encodeTransitionHash(rootTransitionBody);
  const root = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name: "root",
    snapshotHash: snapshot.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [{ ...rootTransitionBody, transitionHash: rootTransitionHash }],
  });
  const childTransitionBody: Omit<
    MigrationParentTransitionV1,
    "transitionHash"
  > = {
    fromState: root.stateId,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [],
    rollback: { kind: "irreversible", reason: "child cannot roll back" },
  };
  const childTransitionHash = encodeTransitionHash(childTransitionBody);
  const child = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name: "child",
    snapshotHash: snapshot.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [{ ...childTransitionBody, transitionHash: childTransitionHash }],
  });
  const branchTransitionBody: Omit<
    MigrationParentTransitionV1,
    "transitionHash"
  > = {
    fromState: root.stateId,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [],
    rollback: { kind: "schema", operations: [] },
  };
  const branchTransitionHash = encodeTransitionHash(branchTransitionBody);
  const branch = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name: "branch",
    snapshotHash: snapshot.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [
      { ...branchTransitionBody, transitionHash: branchTransitionHash },
    ],
  });

  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
  await storage.publishSql(blob.sqlHash, blob.bytes);
  for (const state of [root, child, branch]) {
    await storage.publishState(state.stateId, state.bytes);
  }
  return {
    storage,
    estateHash: estate.estateHash,
    snapshotHash: snapshot.snapshotHash,
    root,
    rootTransitionHash,
    child,
    childTransitionHash,
    branch,
  };
}

function controlRespond(
  marker: MigrationMarkerV1,
  ledger: readonly LedgerEventV1[] = []
) {
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
      return [{ payload: canonicalizeJsonText(marker) }];
    }
    if (
      statement.includes("SELECT payload FROM") &&
      statement.includes("_viborm_migration_log")
    ) {
      return ledger.map((event) => ({
        payload: canonicalizeJsonText(event),
      }));
    }
    return [];
  };
}

function forwardAttempt(
  graph: Awaited<ReturnType<typeof publishArrivalGraph>>,
  attemptId: string
): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId,
    kind: "started" as const,
    estateHash: graph.estateHash,
    snapshotHash: graph.snapshotHash,
    sqlHash: null,
    fromState: graph.root.stateId,
    toState: graph.child.stateId,
    transitionHash: graph.childTransitionHash,
    direction: "forward" as const,
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

function arrivalMarker(
  graph: Awaited<ReturnType<typeof publishArrivalGraph>>,
  rootIsBaseline = false
): MigrationMarkerV1 {
  return markerFromPath(
    graph.estateHash,
    graph.snapshotHash,
    [
      {
        stateId: graph.root.stateId,
        transitionHash: graph.rootTransitionHash,
        baselineBoundary: rootIsBaseline,
      },
      {
        stateId: graph.child.stateId,
        transitionHash: graph.childTransitionHash,
        baselineBoundary: false,
      },
    ],
    2
  );
}

async function downFrom(
  graph: Awaited<ReturnType<typeof publishArrivalGraph>>,
  marker: MigrationMarkerV1,
  options: Parameters<typeof downV1>[2]
) {
  const driver = sqliteEstateDriver();
  driver.respond = controlRespond(marker);
  return downV1({ $driver: driver, $schema: {} }, graph.storage, options);
}

describe("down arrival-path planning", () => {
  test("status leaves pending empty for a branched graph and reports open work", async () => {
    const graph = await publishArrivalGraph();
    const marker = arrivalMarker(graph);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond(marker, [
      forwardAttempt(graph, "a".repeat(64)),
    ]);

    await expect(
      statusV1({ $driver: driver, $schema: {} }, graph.storage)
    ).resolves.toMatchObject({
      control: "present",
      pending: [],
      unfinished: true,
    });
  });

  test("selects the exact suffix after a named arrival-path state", async () => {
    const graph = await publishArrivalGraph();
    await expect(
      downFrom(graph, arrivalMarker(graph), {
        to: { id: graph.root.stateId },
        dryRun: true,
      })
    ).resolves.toEqual({ path: [graph.child.stateId], preview: true });
  });

  test("refuses a graph state that is not on the actual arrival path", async () => {
    const graph = await publishArrivalGraph();
    await expect(
      downFrom(graph, arrivalMarker(graph), {
        to: { id: graph.branch.stateId },
        dryRun: true,
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_NOT_FOUND,
      message: expect.stringContaining("not on the arrival path"),
    });
  });

  test("never crosses the marker's baseline boundary", async () => {
    const graph = await publishArrivalGraph();
    await expect(
      downFrom(graph, arrivalMarker(graph, true), {
        steps: 2,
        dryRun: true,
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("baseline boundary"),
    });
  });

  test("preflights an irreversible edge before rollback effects", async () => {
    const graph = await publishArrivalGraph();
    await expect(
      downFrom(graph, arrivalMarker(graph), { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      message: "child cannot roll back",
    });
  });

  test("refuses forward work and multiple attempts before rollback planning", async () => {
    const graph = await publishArrivalGraph();
    const marker = arrivalMarker(graph);
    const one = sqliteEstateDriver();
    one.respond = controlRespond(marker, [
      forwardAttempt(graph, "a".repeat(64)),
    ]);
    await expect(
      downV1({ $driver: one, $schema: {} }, graph.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT,
      message: expect.stringContaining("blocking ordinary work"),
    });

    const multiple = sqliteEstateDriver();
    multiple.respond = controlRespond(marker, [
      forwardAttempt(graph, "a".repeat(64)),
      forwardAttempt(graph, "b".repeat(64)),
    ]);
    await expect(
      downV1({ $driver: multiple, $schema: {} }, graph.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT,
      message: expect.stringContaining("Multiple unfinished"),
    });
  });

  test("baseline reports live-schema drift before it publishes a marker", async () => {
    const storage = new MemoryEstateStorage();
    const driver = sqliteEstateDriver();
    const schema = { account: s.model({ id: s.string().id() }) };
    const generated = await generateV1(
      { $driver: driver, $schema: schema },
      storage,
      { name: "root" }
    );
    if (!generated.stateId) throw new Error("expected a published root");
    driver.respond = () => [];

    await expect(
      baselineV1({ $driver: driver, $schema: schema }, storage, {
        to: { id: generated.stateId },
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: expect.stringContaining("exact live equality"),
    });
    expect(
      driver.statements.some((statement) => statement.startsWith("UPDATE"))
    ).toBe(false);
  });
});

describe("coverage low value", () => {
  test("refuses an empty marker path", async () => {
    const graph = await publishArrivalGraph();
    const marker = markerFromPath(graph.estateHash, graph.snapshotHash, [], 1);
    await expect(
      downFrom(graph, marker, { dryRun: true })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_NOT_FOUND,
      message: "Nothing to roll back",
    });
  });

  test("refuses a marker edge absent from its state manifest", async () => {
    const graph = await publishArrivalGraph();
    const marker = markerFromPath(
      graph.estateHash,
      graph.snapshotHash,
      [
        {
          stateId: graph.root.stateId,
          transitionHash: graph.rootTransitionHash,
          baselineBoundary: false,
        },
        {
          stateId: graph.child.stateId,
          transitionHash: "f".repeat(64),
          baselineBoundary: false,
        },
      ],
      2
    );
    await expect(downFrom(graph, marker, { steps: 1 })).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("arrival transition"),
    });
  });
});
