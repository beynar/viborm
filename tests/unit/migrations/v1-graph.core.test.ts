import { VibORMErrorCode } from "@src/errors";
import { canonicalizeJson } from "@src/migrations/canonical-json";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import {
  loadMigrationGraph,
  resolveStateSelector,
  selectRoute,
} from "@src/migrations/graph";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  encodeDispatchIdentity,
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeSqlBlob,
  encodeStateId,
  encodeStateManifest,
  encodeTransitionHash,
} from "@src/migrations/v1-parse";
import type {
  MigrationBooleanCheckV1,
  MigrationDispatchV1,
  MigrationParameterV1,
  MigrationParentTransitionV1,
  MigrationStateManifestV1,
} from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";

function dispatchAt(
  blob: ReturnType<typeof composeSqlBlob>,
  index: number,
  parameters: readonly MigrationParameterV1[] = []
): MigrationDispatchV1 {
  const range = blob.ranges[index];
  if (!range) throw new Error(`Missing SQL range ${index}`);
  return {
    dispatchId: encodeDispatchIdentity(
      blob.sqlHash,
      range.offset,
      range.length,
      parameters
    ),
    sqlHash: blob.sqlHash,
    offset: range.offset,
    length: range.length,
    parameters,
  };
}

function checkAt(
  blob: ReturnType<typeof composeSqlBlob>,
  index: number,
  id: string
): MigrationBooleanCheckV1 {
  return {
    kind: "trusted-read",
    id,
    query: dispatchAt(blob, index),
    equals: true,
  };
}

async function publishLinear(name = "root") {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  await storage.publishEstate(estate.bytes);
  const snapshot = encodeSnapshot(emptyManagedSnapshot());
  await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
  const blob = composeSqlBlob([]);
  await storage.publishSql(blob.sqlHash, blob.bytes);
  const parent = {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [
      {
        id: "empty",
        label: "empty",
        origin: "generated" as const,
        risk: "safe" as const,
        steps: [
          {
            retry: "opaque" as const,
            execute: {
              dispatchId: encodeDispatchIdentity(blob.sqlHash, 0, 0, []),
              sqlHash: blob.sqlHash,
              offset: 0,
              length: 0,
              parameters: [],
            },
          },
        ],
      },
    ],
    rollback: { kind: "irreversible" as const, reason: "empty root" },
  };
  const encoded = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name,
    snapshotHash: snapshot.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
  });
  await storage.publishState(encoded.stateId, encoded.bytes);
  return { storage, stateId: encoded.stateId, name };
}

describe("migration v1 graph", () => {
  test.each([
    ["generated", "COMMIT"],
    ["manual", "PREPARE TRANSACTION 'viborm'"],
    ["generated", "SELECT pg_advisory_unlock(1)"],
  ] as const)("refuses authenticated %s boundary control before execution", async (origin, statement) => {
    const storage = new MemoryEstateStorage();
    const estate = encodeEstateDescriptor({
      dialect: "postgresql",
      namespace: "public",
    });
    const snapshot = encodeSnapshot(emptyManagedSnapshot());
    const blob = composeSqlBlob([statement]);
    const operation = {
      id: "unsafe",
      label: "unsafe",
      origin,
      risk: origin === "manual" ? ("opaque" as const) : ("safe" as const),
      steps: [{ retry: "opaque" as const, execute: dispatchAt(blob, 0) }],
    };
    const parent = {
      fromState: null,
      originChecks: [],
      requestedForwardBoundary:
        origin === "manual" ? ("transactional" as const) : null,
      operations: [operation],
      rollback: { kind: "irreversible" as const, reason: "test" },
    };
    const encoded = encodeStateManifest({
      format: "1",
      estateHash: estate.estateHash,
      name: "unsafe-artifact",
      snapshotHash: snapshot.snapshotHash,
      sqlHash: blob.sqlHash,
      destinationChecks: [],
      parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
    });
    await storage.publishEstate(estate.bytes);
    await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
    await storage.publishSql(blob.sqlHash, blob.bytes);
    await storage.publishState(encoded.stateId, encoded.bytes);

    await expect(loadMigrationGraph(storage)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("unsafe-artifact"),
    });
  });

  test.each([
    "BEGIN",
    "COMMIT",
    "END",
    "ROLLBACK",
    "SAVEPOINT s",
    "RELEASE s",
  ])("refuses authenticated SQLite boundary control %s", async (statement) => {
    const storage = new MemoryEstateStorage();
    const estate = encodeEstateDescriptor({ dialect: "sqlite" });
    const snapshot = encodeSnapshot(emptyManagedSnapshot());
    const blob = composeSqlBlob([statement]);
    const parent = {
      fromState: null,
      originChecks: [],
      requestedForwardBoundary: null,
      operations: [
        {
          id: "unsafe",
          label: "unsafe",
          origin: "manual" as const,
          risk: "opaque" as const,
          steps: [{ retry: "opaque" as const, execute: dispatchAt(blob, 0) }],
        },
      ],
      rollback: { kind: "irreversible" as const, reason: "test" },
    };
    const encoded = encodeStateManifest({
      format: "1",
      estateHash: estate.estateHash,
      name: "unsafe-sqlite",
      snapshotHash: snapshot.snapshotHash,
      sqlHash: blob.sqlHash,
      destinationChecks: [],
      parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
    });
    await storage.publishEstate(estate.bytes);
    await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
    await storage.publishSql(blob.sqlHash, blob.bytes);
    await storage.publishState(encoded.stateId, encoded.bytes);

    await expect(loadMigrationGraph(storage)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("unsafe-sqlite"),
    });
  });

  test("accepts SQLite control words in data, identifiers, and trigger grammar", async () => {
    const storage = new MemoryEstateStorage();
    const estate = encodeEstateDescriptor({ dialect: "sqlite" });
    const snapshot = encodeSnapshot(emptyManagedSnapshot());
    const blob = composeSqlBlob([
      "CREATE TABLE [begin] ([commit] TEXT DEFAULT 'ROLLBACK')",
      "CREATE TRIGGER savepoint AFTER INSERT ON [begin] BEGIN SELECT 'RELEASE'; END",
    ]);
    const parent = {
      fromState: null,
      originChecks: [],
      requestedForwardBoundary: null,
      operations: [
        {
          id: "safe",
          label: "safe",
          origin: "manual" as const,
          risk: "opaque" as const,
          steps: [
            { retry: "opaque" as const, execute: dispatchAt(blob, 0) },
            { retry: "opaque" as const, execute: dispatchAt(blob, 1) },
          ],
        },
      ],
      rollback: { kind: "irreversible" as const, reason: "test" },
    };
    const encoded = encodeStateManifest({
      format: "1",
      estateHash: estate.estateHash,
      name: "safe-sqlite",
      snapshotHash: snapshot.snapshotHash,
      sqlHash: blob.sqlHash,
      destinationChecks: [],
      parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
    });
    await storage.publishEstate(estate.bytes);
    await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
    await storage.publishSql(blob.sqlHash, blob.bytes);
    await storage.publishState(encoded.stateId, encoded.bytes);

    await expect(loadMigrationGraph(storage)).resolves.toMatchObject({
      leaves: [encoded.stateId],
    });
  });

  test.each([
    "postgresql",
    "sqlite",
  ] as const)("refuses a target-namespace parameter in a %s estate before exposing the graph", async (dialect) => {
    const storage = new MemoryEstateStorage();
    const estate = encodeEstateDescriptor(
      dialect === "postgresql" ? { dialect, namespace: "public" } : { dialect }
    );
    const snapshot = encodeSnapshot(emptyManagedSnapshot());
    const blob = composeSqlBlob(["SELECT 1", "SELECT ?"]);
    const parent = {
      fromState: null,
      originChecks: [],
      requestedForwardBoundary: null,
      operations: [
        {
          id: "crafted",
          label: "crafted",
          origin: "manual" as const,
          risk: "opaque" as const,
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
      name: "foreign-namespace-tag",
      snapshotHash: snapshot.snapshotHash,
      sqlHash: blob.sqlHash,
      destinationChecks: [],
      parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
    });
    await storage.publishEstate(estate.bytes);
    await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
    await storage.publishSql(blob.sqlHash, blob.bytes);
    await storage.publishState(encoded.stateId, encoded.bytes);

    await expect(loadMigrationGraph(storage)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("target-namespace"),
    });
  });

  test("loads a linear estate and selects the unique leaf", async () => {
    const published = await publishLinear("initial");
    const graph = await loadMigrationGraph(published.storage);
    expect(graph.leaves).toEqual([published.stateId]);
    expect(resolveStateSelector(graph, { name: "initial" })).toBe(
      published.stateId
    );
    expect(
      resolveStateSelector(graph, { prefix: published.stateId.slice(0, 8) })
    ).toBe(published.stateId);
    expect(selectRoute(graph, null, published.stateId)).toEqual([
      published.stateId,
    ]);
  });

  test("altered SQL bytes are corruption", async () => {
    const published = await publishLinear();
    const graph = await loadMigrationGraph(published.storage);
    const hash = graph.states.get(published.stateId)!.sqlHash;
    await expect(
      published.storage.publishSql(hash, new Uint8Array([1, 2, 3]))
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_CORRUPTION });
  });

  test("sql hash owner exists independently of snapshots", async () => {
    const blob = composeSqlBlob(["SELECT 1"]);
    expect(encodeSqlBlob(blob.bytes)).toBe(blob.sqlHash);
    expect(blob.sqlHash).not.toBe(
      encodeSnapshot(emptyManagedSnapshot()).snapshotHash
    );
  });

  test("collects check and execute dispatches from forward and rollback programs", async () => {
    const storage = new MemoryEstateStorage();
    const estate = encodeEstateDescriptor({ dialect: "sqlite" });
    const snapshot = encodeSnapshot(emptyManagedSnapshot());
    const blob = composeSqlBlob([
      "CREATE TABLE example(id text)",
      "SELECT forward_pre",
      "SELECT forward_post",
      "DROP TABLE example",
      "SELECT rollback_pre",
      "SELECT rollback_post",
      "SELECT origin",
      "SELECT destination",
    ]);
    await storage.publishEstate(estate.bytes);
    await storage.publishSql(blob.sqlHash, blob.bytes);

    const parent: Omit<MigrationParentTransitionV1, "transitionHash"> = {
      fromState: null,
      originChecks: [checkAt(blob, 6, "origin")],
      requestedForwardBoundary: null,
      operations: [
        {
          id: "create",
          label: "create",
          origin: "generated",
          risk: "safe",
          steps: [
            {
              retry: "proven",
              precheck: checkAt(blob, 1, "forward-pre"),
              execute: dispatchAt(blob, 0),
              postcheck: checkAt(blob, 2, "forward-post"),
            },
          ],
        },
      ],
      rollback: {
        kind: "schema",
        operations: [
          {
            id: "drop",
            label: "drop",
            origin: "generated",
            risk: "destructive",
            steps: [
              {
                retry: "proven",
                precheck: checkAt(blob, 4, "rollback-pre"),
                execute: dispatchAt(blob, 3),
                postcheck: checkAt(blob, 5, "rollback-post"),
              },
            ],
          },
        ],
      },
    };
    const encoded = encodeStateManifest({
      format: "1",
      estateHash: estate.estateHash,
      name: "checked",
      snapshotHash: snapshot.snapshotHash,
      sqlHash: blob.sqlHash,
      destinationChecks: [checkAt(blob, 7, "destination")],
      parents: [
        {
          ...parent,
          transitionHash: encodeTransitionHash(parent),
        },
      ],
    });
    await storage.publishState(encoded.stateId, encoded.bytes);

    await expect(loadMigrationGraph(storage)).resolves.toMatchObject({
      roots: [encoded.stateId],
    });
  });

  test("refuses states with no path from the empty state", async () => {
    const storage = new MemoryEstateStorage();
    const estate = encodeEstateDescriptor({ dialect: "sqlite" });
    const snapshot = encodeSnapshot(emptyManagedSnapshot());
    const blob = composeSqlBlob([]);
    await storage.publishEstate(estate.bytes);
    const orphan: Omit<MigrationStateManifestV1, "stateId"> = {
      format: "1",
      estateHash: estate.estateHash,
      name: "orphan",
      snapshotHash: snapshot.snapshotHash,
      sqlHash: blob.sqlHash,
      destinationChecks: [],
      parents: [],
    };
    const stateId = encodeStateId(orphan);
    await storage.publishState(
      stateId,
      canonicalizeJson({ ...orphan, stateId })
    );

    await expect(loadMigrationGraph(storage)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
    });
  });

  test("refuses a storage listing that repeats a state id", async () => {
    const published = await publishLinear();
    const [id] = await published.storage.listStates();
    if (!id) throw new Error("expected a published state");
    const inner = published.storage;
    const duplicate = {
      readEstate: () => inner.readEstate(),
      listStates: async () => [id, id],
      listSnapshots: () => inner.listSnapshots(),
      listSql: () => inner.listSql(),
      readState: (stateId: typeof id) => inner.readState(stateId),
      readSnapshot: (hash: typeof id) => inner.readSnapshot(hash),
      readSql: (hash: typeof id) => inner.readSql(hash),
    };

    await expect(loadMigrationGraph(duplicate)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("listed more than once"),
    });
  });

  test("refuses dangling parent ids", async () => {
    const storage = new MemoryEstateStorage();
    const estate = encodeEstateDescriptor({ dialect: "sqlite" });
    const snapshot = encodeSnapshot(emptyManagedSnapshot());
    const blob = composeSqlBlob([]);
    await storage.publishEstate(estate.bytes);
    await storage.publishSql(blob.sqlHash, blob.bytes);
    const parent: Omit<MigrationParentTransitionV1, "transitionHash"> = {
      fromState: "1".repeat(64),
      originChecks: [],
      requestedForwardBoundary: null,
      operations: [],
      rollback: {
        kind: "irreversible",
        reason: "no parent",
      },
    };
    const encoded = encodeStateManifest({
      format: "1",
      estateHash: estate.estateHash,
      name: "dangling",
      snapshotHash: snapshot.snapshotHash,
      sqlHash: blob.sqlHash,
      destinationChecks: [],
      parents: [
        {
          ...parent,
          transitionHash: encodeTransitionHash(parent),
        },
      ],
    });
    await storage.publishState(encoded.stateId, encoded.bytes);

    await expect(loadMigrationGraph(storage)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
    });
  });
});
