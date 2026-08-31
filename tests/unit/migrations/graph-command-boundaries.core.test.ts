import { createClient } from "@client/client";
import { s } from "@schema";
import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { generateV1 } from "@src/migrations/generate-v1";
import {
  loadMigrationGraph,
  type MigrationGraph,
  parentTransition,
  requireStateSnapshot,
  resolveStateSelector,
  selectRoute,
} from "@src/migrations/graph";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import type { MigrationStorageReader } from "@src/migrations/storage/contract";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeStateManifest,
  encodeTransitionHash,
} from "@src/migrations/v1-parse";
import type {
  MigrationParentTransitionV1,
  MigrationStateManifestV1,
} from "@src/migrations/v1-types";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, test } from "vitest";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const SNAPSHOT_HASH = "e".repeat(64);
const SQL_HASH = "f".repeat(64);

function transition(
  fromState: string | null,
  transitionHash: string
): MigrationParentTransitionV1 {
  return {
    fromState,
    transitionHash,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [],
    rollback: { kind: "irreversible", reason: "selection fixture" },
  };
}

function state(
  stateId: string,
  name: string,
  parents: readonly MigrationParentTransitionV1[]
): MigrationStateManifestV1 {
  return {
    format: "1",
    estateHash: HASH_D,
    name,
    stateId,
    snapshotHash: SNAPSHOT_HASH,
    sqlHash: SQL_HASH,
    destinationChecks: [],
    parents,
  };
}

function selectionGraph(
  states: readonly MigrationStateManifestV1[],
  roots: readonly string[],
  leaves: readonly string[]
): MigrationGraph {
  return {
    estateHash: HASH_D,
    descriptor: {
      format: "1",
      target: { dialect: "sqlite" },
      hash: "sha256",
    },
    states: new Map(states.map((entry) => [entry.stateId, entry])),
    snapshots: new Map([[SNAPSHOT_HASH, emptyManagedSnapshot()]]),
    sql: new Map([[SQL_HASH, new Uint8Array()]]),
    roots,
    leaves,
    emptySnapshotHash: SNAPSHOT_HASH,
  };
}

function graphFixture(): MigrationGraph {
  const root = state(HASH_A, "duplicate", [transition(null, HASH_A)]);
  const left = state(HASH_B, "duplicate", [transition(HASH_A, HASH_B)]);
  const right = state(HASH_C, "right", [transition(HASH_A, HASH_C)]);
  const merge = state(HASH_D, "merge", [
    transition(HASH_B, `${HASH_B.slice(0, 63)}0`),
    transition(HASH_C, `${HASH_C.slice(0, 63)}0`),
  ]);
  return selectionGraph([root, left, right, merge], [HASH_A], [HASH_D]);
}

async function publishStateFixture(options: {
  readonly publishSnapshot?: boolean;
  readonly publishSql?: boolean;
  readonly stateEstate?: ReturnType<typeof encodeEstateDescriptor>;
}) {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  const stateEstate = options.stateEstate ?? estate;
  const snapshot = encodeSnapshot({
    tables: [],
    enums: [{ name: "fixture_status", values: ["on"] }],
  });
  const blob = composeSqlBlob([]);
  const parentBody: Omit<MigrationParentTransitionV1, "transitionHash"> = {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [],
    rollback: { kind: "irreversible", reason: "fixture" },
  };
  const encoded = encodeStateManifest({
    format: "1",
    estateHash: stateEstate.estateHash,
    name: "root",
    snapshotHash: snapshot.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [
      { ...parentBody, transitionHash: encodeTransitionHash(parentBody) },
    ],
  });
  await storage.publishEstate(estate.bytes);
  if (options.publishSnapshot !== false) {
    await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
  }
  if (options.publishSql !== false) {
    await storage.publishSql(blob.sqlHash, blob.bytes);
  }
  await storage.publishState(encoded.stateId, encoded.bytes);
  return { storage, estate, snapshot, blob, encoded };
}

const user = s.model({ id: s.string().id() });

function planningClient() {
  return createClient({
    schema: { user },
    driver: new PlanningDriver("sqlite"),
  });
}

describe("migration graph command boundaries", () => {
  test("state selectors report empty, missing, and ambiguous choices", () => {
    const graph = graphFixture();
    const empty = selectionGraph([], [], []);
    const multipleLeaves = selectionGraph(
      [...graph.states.values()],
      [HASH_A],
      [HASH_B, HASH_C, HASH_D]
    );

    expect(() => resolveStateSelector(empty, undefined)).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_NOT_FOUND })
    );
    expect(() => resolveStateSelector(multipleLeaves, undefined)).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_PATH_REQUIRED })
    );
    expect(() =>
      resolveStateSelector(graph, { id: "0".repeat(64) })
    ).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_NOT_FOUND })
    );
    expect(() => resolveStateSelector(graph, { prefix: "0" })).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_NOT_FOUND })
    );
    expect(() => resolveStateSelector(graph, { prefix: "" })).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_PATH_REQUIRED })
    );
    expect(() => resolveStateSelector(graph, { name: "missing" })).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_NOT_FOUND })
    );
    expect(() =>
      resolveStateSelector(graph, { name: "duplicate" })
    ).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_PATH_REQUIRED })
    );
  });

  test("route validation rejects wrong endpoints, repeats, missing edges, and absent routes", () => {
    const graph = graphFixture();
    expect(() => selectRoute(graph, null, HASH_D, [HASH_A])).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_PATH_REQUIRED })
    );
    expect(() =>
      selectRoute(graph, null, HASH_D, [HASH_A, HASH_B, HASH_B, HASH_D])
    ).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_PATH_REQUIRED })
    );
    expect(() =>
      selectRoute(graph, null, HASH_D, [HASH_A, HASH_D])
    ).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_PATH_REQUIRED })
    );
    expect(() => selectRoute(graph, HASH_D, HASH_A)).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_NOT_FOUND })
    );
    expect(() => parentTransition(graph, null, "0".repeat(64))).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_NOT_FOUND })
    );
    expect(() => parentTransition(graph, null, HASH_B)).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      })
    );
  });

  test("snapshot lookup rejects both an unknown state and a missing snapshot", () => {
    const graph = graphFixture();
    expect(() => requireStateSnapshot(graph, "0".repeat(64))).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_CORRUPTION })
    );
    const withoutSnapshot: MigrationGraph = {
      ...graph,
      snapshots: new Map(),
    };
    expect(() => requireStateSnapshot(withoutSnapshot, HASH_A)).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_CORRUPTION })
    );
  });

  test("graph loading refuses unreadable and cross-estate state records", async () => {
    const unreadable = await publishStateFixture({});
    const unreadableReader: MigrationStorageReader = {
      readEstate: () => unreadable.storage.readEstate(),
      listStates: () => Promise.resolve([unreadable.encoded.stateId]),
      listSnapshots: () => unreadable.storage.listSnapshots(),
      listSql: () => unreadable.storage.listSql(),
      readState: () => Promise.resolve(null),
      readSnapshot: (hash) => unreadable.storage.readSnapshot(hash),
      readSql: (hash) => unreadable.storage.readSql(hash),
    };
    await expect(loadMigrationGraph(unreadableReader)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("listed but unreadable"),
    });

    const otherEstate = encodeEstateDescriptor({
      dialect: "postgresql",
      namespace: "public",
    });
    const foreign = await publishStateFixture({ stateEstate: otherEstate });
    await expect(loadMigrationGraph(foreign.storage)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      message: expect.stringContaining("different estate"),
    });
  });

  test("graph loading refuses missing snapshots, missing SQL, and altered SQL bytes", async () => {
    const missingSnapshot = await publishStateFixture({
      publishSnapshot: false,
    });
    await expect(
      loadMigrationGraph(missingSnapshot.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("referenced but missing"),
    });

    const missingSql = await publishStateFixture({ publishSql: false });
    await expect(loadMigrationGraph(missingSql.storage)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("referenced but missing"),
    });

    const altered = await publishStateFixture({});
    const alteredReader: MigrationStorageReader = {
      readEstate: () => altered.storage.readEstate(),
      listStates: () => altered.storage.listStates(),
      listSnapshots: () => altered.storage.listSnapshots(),
      listSql: () => altered.storage.listSql(),
      readState: (id) => altered.storage.readState(id),
      readSnapshot: (hash) => altered.storage.readSnapshot(hash),
      readSql: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    };
    await expect(loadMigrationGraph(alteredReader)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("does not match its bytes"),
    });
  });

  test("graph loading rejects a parentless state at manifest admission", async () => {
    const published = await publishStateFixture({});
    const orphanBody: Omit<MigrationStateManifestV1, "stateId"> = {
      format: "1",
      estateHash: published.estate.estateHash,
      name: "orphan",
      snapshotHash: published.snapshot.snapshotHash,
      sqlHash: published.blob.sqlHash,
      destinationChecks: [],
      parents: [],
    };
    const orphan = encodeStateManifest(orphanBody);
    await published.storage.publishState(orphan.stateId, orphan.bytes);

    await expect(loadMigrationGraph(published.storage)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      message: expect.stringContaining("at least one parent transition"),
    });
  });

  test("generate rejects reader-only storage before schema work", async () => {
    const storage = new MemoryEstateStorage();
    const reader: MigrationStorageReader = {
      readEstate: () => storage.readEstate(),
      listStates: () => storage.listStates(),
      listSnapshots: () => storage.listSnapshots(),
      listSql: () => storage.listSql(),
      readState: (id) => storage.readState(id),
      readSnapshot: (hash) => storage.readSnapshot(hash),
      readSql: (hash) => storage.readSql(hash),
    };
    const client = planningClient();
    await expect(
      Reflect.apply(generateV1, undefined, [client, reader, {}])
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_STORAGE_REQUIRED,
    });
    await client.$disconnect();
  });

  test("generate covers skip-validation, generated naming, and explicit-parent refusals", async () => {
    const storage = new MemoryEstateStorage();
    const client = planningClient();
    const preview = await generateV1(client, storage, {
      dryRun: true,
      skipValidation: true,
    });
    expect(preview).toMatchObject({ outcome: "preview" });
    expect(preview.name).toBeTruthy();

    const published = await generateV1(client, storage, { name: "root" });
    await expect(
      generateV1(client, storage, { from: null, name: "second-root" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
    });
    await expect(
      generateV1(client, storage, {
        from: "0".repeat(64),
        name: "unknown-parent",
      })
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_NOT_FOUND });
    expect(published.stateId).toBeTruthy();
    await client.$disconnect();
  });

  test("manual generation rejects duplicate parents before compilation", async () => {
    const storage = new MemoryEstateStorage();
    const client = planningClient();
    await expect(
      generateV1(client, storage, {
        manualMigration: {
          transitions: [
            {
              from: null,
              execution: "transactional",
              up: [sql`SELECT 1`],
              rollback: { kind: "irreversible", reason: "fixture" },
            },
            {
              from: null,
              execution: "transactional",
              up: [sql`SELECT 2`],
              rollback: { kind: "irreversible", reason: "fixture" },
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      message: expect.stringContaining("more than once"),
    });
    await client.$disconnect();
  });
});

describe("coverage low value", () => {
  test("an empty estate has no default state snapshot", () => {
    expect(() =>
      requireStateSnapshot(selectionGraph([], [], []), HASH_A)
    ).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_CORRUPTION })
    );
  });
});
