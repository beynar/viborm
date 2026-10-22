import { createClient } from "@client/client";
import { s } from "@schema";
import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import {
  canonicalizeJson,
  canonicalizeJsonText,
} from "@src/migrations/canonical-json";
import { checkEstate } from "@src/migrations/check";
import { createMigrationClient } from "@src/migrations/client";
import { ArtifactCache, loadMigrationGraph } from "@src/migrations/graph";
import { domainHash, HASH_DOMAIN, utf8Bytes } from "@src/migrations/identity";
import { pruneV1 } from "@src/migrations/operators";
import {
  encodeSnapshotArtifact,
  MAX_SNAPSHOT_DELTA_DEPTH,
  resolveSnapshotArtifacts,
} from "@src/migrations/snapshot-artifacts";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import type { MigrationStorageReader } from "@src/migrations/storage/contract";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  MemoryConditionalObjectStore,
  ObjectStoreEstateStorage,
} from "@src/migrations/storage/object-store";
import type { SchemaSnapshot } from "@src/migrations/types";
import {
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeStateManifest,
  encodeTransitionHash,
  parseStateManifest,
} from "@src/migrations/v1-parse";
import type { MigrationStateManifestV1 } from "@src/migrations/v1-types";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, test } from "vitest";

function snapshot(version = 0, size = 12): SchemaSnapshot {
  return {
    enums: [],
    tables: Array.from({ length: size }, (_, index) => ({
      name: `entity_${index}`,
      columns: [
        { name: "id", type: "TEXT", nullable: false },
        {
          name: "title",
          type: "TEXT",
          nullable: false,
          default: `'${index === 0 ? version : 0}'`,
        },
      ],
      primaryKey: { columns: ["id"] },
      indexes: [],
      foreignKeys: [],
      uniqueConstraints: [],
    })),
  };
}

async function full(storage: MemoryEstateStorage, schema: SchemaSnapshot) {
  const encoded = encodeSnapshot(schema);
  await storage.publishSnapshot(encoded.snapshotHash, encoded.bytes);
  return encoded.snapshotHash;
}

async function delta(
  storage: MemoryEstateStorage,
  baseArtifactHash: string,
  schema: SchemaSnapshot,
  changes: unknown = [
    {
      op: "set",
      path: ["tables", 0, "columns", 1, "default"],
      value: schema.tables[0]?.columns[1]?.default,
    },
  ],
  extra: Record<string, unknown> = {}
) {
  const document = {
    format: "snapshot-delta-1",
    baseArtifactHash,
    snapshotHash: encodeSnapshot(schema).snapshotHash,
    changes,
    ...extra,
  };
  const bytes = canonicalizeJson(document);
  const hash = domainHash(HASH_DOMAIN.snapshotDelta, bytes);
  await storage.publishSnapshot(hash, bytes);
  return hash;
}

async function state(
  storage: MemoryEstateStorage,
  snapshotHash: string,
  snapshotArtifactHash?: string,
  fromState: string | null = null,
  name = "state"
) {
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  const blob = composeSqlBlob([]);
  await storage.publishEstate(estate.bytes);
  await storage.publishSql(blob.sqlHash, blob.bytes);
  const parent = {
    fromState,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [],
    rollback: { kind: "schema", operations: [] },
  } satisfies Omit<
    MigrationStateManifestV1["parents"][number],
    "transitionHash"
  >;
  const encoded = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name,
    snapshotHash,
    ...(snapshotArtifactHash ? { snapshotArtifactHash } : {}),
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
  });
  await storage.publishState(encoded.stateId, encoded.bytes);
  return encoded;
}

function schema(version = 0) {
  return {
    entity: s.model({
      id: s.string().id(),
      title: s.string().default(String(version)),
      payload: s.string(),
      count: s.int().default(0),
    }),
  };
}

function migrations(
  storage: MemoryEstateStorage | ObjectStoreEstateStorage,
  version = 0
) {
  return createMigrationClient(
    createClient({
      schema: schema(version),
      driver: new PlanningDriver("sqlite"),
    }),
    { storage }
  );
}

describe("incremental snapshot artifacts", () => {
  test("full roots, smaller deltas and reconstructed logical hashes", async () => {
    const storage = new MemoryEstateStorage();
    const original = snapshot();
    const root = encodeSnapshotArtifact(original, new Map(), []);
    expect(root.artifactHash).toBe(encodeSnapshot(original).snapshotHash);
    await storage.publishSnapshot(root.artifactHash, root.bytes!);
    const artifacts = await resolveSnapshotArtifacts(storage, [
      root.artifactHash,
    ]);
    const next = encodeSnapshotArtifact(snapshot(1), artifacts, [
      root.artifactHash,
    ]);
    expect(next.artifactHash).not.toBe(next.snapshotHash);
    expect(next.bytes!.length).toBeLessThan(root.bytes!.length / 5);
    await storage.publishSnapshot(next.artifactHash, next.bytes!);
    await resolveSnapshotArtifacts(storage, [next.artifactHash], artifacts);
    expect(artifacts.get(next.artifactHash)).toMatchObject({
      snapshot: snapshot(1),
      snapshotHash: next.snapshotHash,
      depth: 1,
    });
    expect(artifacts.get(root.artifactHash)?.snapshot).toEqual(original);
  });

  test("structural changes preserve order, appended and removed arrays, optional metadata and special names", async () => {
    const storage = new MemoryEstateStorage();
    let previous = await full(storage, snapshot());
    const variants = [
      snapshot(1, 13),
      snapshot(2, 10),
      snapshot(3, 10),
      snapshot(4, 10),
    ];
    variants[1]!.tables.reverse();
    variants[2]!.tables[0]!.columns[1] = {
      name: "__proto__",
      type: "TEXT",
      nullable: true,
    };
    variants[2]!.tables[0]!.indexes.push({
      name: "idx",
      columns: ["id"],
      unique: false,
      where: '"id" IS NOT NULL',
    });
    variants[3]!.enums = [{ name: "state", values: ["a", "b"] }];
    for (const desired of variants) {
      const artifacts = await resolveSnapshotArtifacts(storage, [previous]);
      const encoded = encodeSnapshotArtifact(desired, artifacts, [previous]);
      await storage.publishSnapshot(encoded.artifactHash, encoded.bytes!);
      const loaded = await resolveSnapshotArtifacts(storage, [
        encoded.artifactHash,
      ]);
      expect(loaded.get(encoded.artifactHash)?.snapshot).toEqual(desired);
      previous = encoded.artifactHash;
    }
  });

  test("small destinations retain full snapshots when a delta is larger", async () => {
    const storage = new MemoryEstateStorage();
    const base = await full(storage, snapshot());
    const artifacts = await resolveSnapshotArtifacts(storage, [base]);
    const desired = { tables: [] };
    const encoded = encodeSnapshotArtifact(desired, artifacts, [base]);
    expect(encoded.artifactHash).toBe(encodeSnapshot(desired).snapshotHash);
    expect(encoded.bytes).toEqual(encodeSnapshot(desired).bytes);
  });

  test("two siblings and a rejected child never change their shared cached base", async () => {
    const storage = new MemoryEstateStorage();
    const base = await full(storage, snapshot());
    const left = await delta(storage, base, snapshot(1));
    const right = await delta(storage, base, snapshot(2));
    const artifacts = await resolveSnapshotArtifacts(storage, [
      base,
      left,
      right,
    ]);
    const bad = await delta(storage, base, snapshot(3), [
      {
        op: "set",
        path: ["tables", 0, "columns", 1, "default"],
        value: "changed",
      },
      { op: "remove", path: ["tables", 0] },
    ]);
    await expect(
      resolveSnapshotArtifacts(storage, [bad], artifacts)
    ).rejects.toThrow("final element");
    expect(artifacts.has(bad)).toBe(false);
    expect(artifacts.get(base)?.snapshot).toEqual(snapshot());
    expect(artifacts.get(left)?.snapshot).toEqual(snapshot(1));
    expect(artifacts.get(right)?.snapshot).toEqual(snapshot(2));
  });

  test.each([
    null,
    { op: "unknown", path: ["tables"] },
    { op: "set", path: [], value: 1 },
    { op: "set", path: "tables", value: 1 },
    { op: "set", path: [-1], value: 1 },
    { op: "set", path: [0.5], value: 1 },
    { op: "set", path: [true], value: 1 },
    { op: "set", path: ["tables"], value: [], extra: true },
    { op: "remove", path: ["tables"], value: [] },
    { op: "set", path: ["tables"] },
    { op: "set", path: ["tables", "length"], value: 0 },
    { op: "set", path: ["tables", "named"], value: 0 },
    { op: "set", path: ["tables", 99], value: {} },
    { op: "remove", path: ["tables", 12] },
    { op: "remove", path: ["tables", 0] },
    { op: "remove", path: ["absent"] },
    { op: "set", path: ["absent", "child"], value: 1 },
    { op: "set", path: ["constructor", "prototype", "polluted"], value: true },
    { op: "set", path: ["__proto__", "polluted"], value: true },
    { op: "set", path: ["tables", 0, "name", "child"], value: 1 },
    { op: "set", path: [0], value: 1 },
    { op: "set", path: ["__proto__"], value: { polluted: true } },
  ])("rejects hostile path/change %j without mutating its base", async (change) => {
    const storage = new MemoryEstateStorage();
    const base = await full(storage, snapshot());
    const hash = await delta(storage, base, snapshot(1), [change]);
    const artifacts = await resolveSnapshotArtifacts(storage, [base]);
    await expect(
      resolveSnapshotArtifacts(storage, [hash], artifacts)
    ).rejects.toThrow();
    expect(artifacts.get(base)?.snapshot).toEqual(snapshot());
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
  });

  test.each([
    { format: "unknown" },
    { changes: {} },
    { baseArtifactHash: "bad" },
    { snapshotHash: "bad" },
    { extra: true },
  ])("rejects malformed envelope %j", async (extra) => {
    const storage = new MemoryEstateStorage();
    const base = await full(storage, snapshot());
    const hash = await delta(storage, base, snapshot(1), [], extra);
    await expect(resolveSnapshotArtifacts(storage, [hash])).rejects.toThrow();
  });

  test("rejects noncanonical or changed bytes before reading a base", async () => {
    const storage = new MemoryEstateStorage();
    const base = await full(storage, snapshot());
    const hash = await delta(storage, base, snapshot(1));
    const bytes = (await storage.readSnapshot(hash))!;
    for (const damaged of [
      utf8Bytes(`${new TextDecoder().decode(bytes)}\n`),
      canonicalizeJson({
        format: "snapshot-delta-1",
        baseArtifactHash: base,
        snapshotHash: "a".repeat(64),
        changes: [],
      }),
    ]) {
      const reads: string[] = [];
      const reader: MigrationStorageReader = {
        ...storage,
        readEstate: () => storage.readEstate(),
        listStates: () => storage.listStates(),
        listSnapshots: () => storage.listSnapshots(),
        listSql: () => storage.listSql(),
        readState: (id) => storage.readState(id),
        readSql: (id) => storage.readSql(id),
        readSnapshot: async (id) => {
          reads.push(id);
          return id === hash ? damaged : storage.readSnapshot(id);
        },
      };
      await expect(resolveSnapshotArtifacts(reader, [hash])).rejects.toThrow();
      expect(reads).toEqual([hash]);
    }
  });

  test("missing bases and mismatched reconstructed hashes refuse", async () => {
    const storage = new MemoryEstateStorage();
    const missing = await delta(storage, "a".repeat(64), snapshot(1));
    await expect(
      resolveSnapshotArtifacts(storage, [missing])
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_CORRUPTION });
    const base = await full(storage, snapshot());
    const wrong = await delta(storage, base, snapshot(1), []);
    await expect(
      resolveSnapshotArtifacts(storage, [wrong])
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_CORRUPTION });
  });

  test("32-link reconstruction works; cold and cached 33rd links refuse and generation checkpoints", async () => {
    const storage = new MemoryEstateStorage();
    let hash = await full(storage, snapshot());
    for (let index = 1; index <= MAX_SNAPSHOT_DELTA_DEPTH; index++)
      hash = await delta(storage, hash, snapshot(index));
    const artifacts = await resolveSnapshotArtifacts(storage, [hash]);
    expect(artifacts.get(hash)?.depth).toBe(32);
    const tooDeep = await delta(storage, hash, snapshot(33));
    await expect(resolveSnapshotArtifacts(storage, [tooDeep])).rejects.toThrow(
      "32 links"
    );
    await expect(
      resolveSnapshotArtifacts(storage, [tooDeep], artifacts)
    ).rejects.toThrow("32 links");
    const checkpoint = encodeSnapshotArtifact(snapshot(33), artifacts, [hash]);
    expect(checkpoint.artifactHash).toBe(checkpoint.snapshotHash);
    await storage.publishSnapshot(checkpoint.artifactHash, checkpoint.bytes!);
    const loaded = await resolveSnapshotArtifacts(storage, [
      checkpoint.artifactHash,
    ]);
    expect(loaded.get(checkpoint.artifactHash)?.depth).toBe(0);
    const next = encodeSnapshotArtifact(snapshot(34), loaded, [
      checkpoint.artifactHash,
    ]);
    expect(next.artifactHash).not.toBe(next.snapshotHash);
  });

  test("reuse and smallest-base selection ignore map and candidate insertion order", async () => {
    const storage = new MemoryEstateStorage();
    const base = await full(storage, snapshot());
    const same = await delta(storage, base, snapshot(), []);
    const artifacts = await resolveSnapshotArtifacts(storage, [same, base]);
    const reverse = new Map([...artifacts].reverse());
    const reused = encodeSnapshotArtifact(snapshot(), artifacts, [base]);
    expect(reused.bytes).toBeNull();
    expect(reused.artifactHash).toBe([same, base].sort()[0]);
    expect(encodeSnapshotArtifact(snapshot(), reverse, [same])).toEqual(reused);
    expect(
      encodeSnapshotArtifact(snapshot(1), artifacts, [same, base])
    ).toEqual(encodeSnapshotArtifact(snapshot(1), reverse, [base, same]));
  });
});

describe("incremental snapshot graph and generation", () => {
  test("an evicted parse still returns a frozen reconstructed graph", async () => {
    const storage = new MemoryEstateStorage();
    const base = await full(storage, snapshot());
    const child = await delta(storage, base, snapshot(1));
    await state(storage, encodeSnapshot(snapshot(1)).snapshotHash, child);
    const cache = new ArtifactCache(0);
    const graph = await loadMigrationGraph(storage, cache);
    expect(cache.heldBytes).toBe(0);
    const resolved = graph.snapshotArtifacts.get(child)!.snapshot;
    expect(Object.isFrozen(resolved.tables[0]!.columns)).toBe(true);
    expect(
      Reflect.set(resolved.tables[0]!.columns[1]!, "default", "'bad'")
    ).toBe(false);
    expect(resolved).toEqual(snapshot(1));
  });

  test.each([
    {
      property: "dateTime",
      value: 1,
      message: "dateTime must name a DateTime physical form",
    },
    {
      property: "geoPointEncoding",
      value: "binary64",
      message: "geoPointEncoding contradicts its physical type",
    },
  ])("reconstruction refuses an invalid $property annotation", async ({
    property,
    value,
    message,
  }) => {
    const storage = new MemoryEstateStorage();
    const base = await full(storage, snapshot());
    const child = await delta(storage, base, snapshot(1), [
      { op: "set", path: ["tables", 0, "columns", 1, property], value },
    ]);
    await expect(
      resolveSnapshotArtifacts(storage, [child])
    ).rejects.toMatchObject({
      message: expect.stringContaining(message),
    });
  });

  test("frozen cached deltas detach set objects before a later change edits them", async () => {
    const storage = new MemoryEstateStorage();
    const base = await full(storage, snapshot());
    const child = await delta(storage, base, snapshot(1), [
      {
        op: "set",
        path: ["tables", 0, "columns", 1],
        value: snapshot().tables[0]!.columns[1],
      },
      { op: "set", path: ["tables", 0, "columns", 1, "default"], value: "'1'" },
    ]);
    await state(storage, encodeSnapshot(snapshot(1)).snapshotHash, child);
    const cache = new ArtifactCache(1024 * 1024);
    for (let attempt = 0; attempt < 2; attempt++) {
      const graph = await loadMigrationGraph(storage, cache);
      expect(graph.snapshotArtifacts.get(child)?.snapshot).toEqual(snapshot(1));
      expect(
        Object.isFrozen(graph.snapshotArtifacts.get(child)?.snapshot)
      ).toBe(true);
    }
  });

  test("an authored checkpoint is full and prune retains transitive physical dependencies of later states", async () => {
    const storage = new MemoryEstateStorage();
    await migrations(storage).generate({ name: "root" });
    await migrations(storage, 1).generate({ name: "next" });
    const checkpoint = await migrations(storage, 1).generate({
      from: null,
      name: "checkpoint",
    });
    const graph = await loadMigrationGraph(storage);
    expect(
      graph.states.get(checkpoint.stateId!)?.snapshotArtifactHash
    ).toBeUndefined();
    expect(await storage.readSnapshot(checkpoint.snapshotHash!)).not.toBeNull();

    const history = new MemoryEstateStorage();
    const base = await full(history, snapshot());
    const root = await state(history, base, undefined, null, "root");
    const child = await delta(history, base, snapshot(1));
    await state(
      history,
      encodeSnapshot(snapshot(1)).snapshotHash,
      child,
      root.stateId,
      "old"
    );
    const fullCheckpoint = await full(history, snapshot(1));
    const anchored = await state(
      history,
      fullCheckpoint,
      undefined,
      null,
      "checkpoint"
    );
    const following = await delta(history, child, snapshot(2));
    const after = await state(
      history,
      encodeSnapshot(snapshot(2)).snapshotHash,
      following,
      anchored.stateId,
      "after"
    );
    const into = new MemoryEstateStorage();
    await pruneV1(history, { checkpoint: { id: anchored.stateId }, into });
    expect(await into.listStates()).toEqual(
      [anchored.stateId, after.stateId].sort()
    );
    expect(await into.listSnapshots()).toEqual(
      [base, child, fullCheckpoint, following].sort()
    );
    expect(await checkEstate(into)).toEqual({ ok: true, findings: [] });
  });

  test("prune refuses a snapshot changed after graph authentication", async () => {
    class ChangingStorage extends MemoryEstateStorage {
      reads = new Map<string, number>();
      override async readSnapshot(hash: string) {
        const reads = (this.reads.get(hash) ?? 0) + 1;
        this.reads.set(hash, reads);
        return reads === 1 ? super.readSnapshot(hash) : utf8Bytes("{}");
      }
    }
    const storage = new ChangingStorage();
    const base = await full(storage, snapshot());
    const root = await state(storage, base);
    const into = new MemoryEstateStorage();
    await expect(
      pruneV1(storage, { checkpoint: { id: root.stateId }, into })
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_CORRUPTION });
    expect(await into.listStates()).toEqual([]);
  });

  test("prune refuses a dependency that disappears after authentication", async () => {
    class VanishingStorage extends MemoryEstateStorage {
      reads = 0;
      override async readSnapshot(hash: string) {
        return ++this.reads === 1 ? super.readSnapshot(hash) : null;
      }
    }
    const storage = new VanishingStorage();
    const base = await full(storage, snapshot());
    const root = await state(storage, base);
    const into = new MemoryEstateStorage();
    await expect(
      pruneV1(storage, { checkpoint: { id: root.stateId }, into })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("vanished"),
    });
    expect(await into.listStates()).toEqual([]);
  });

  test("prune preserves an explicitly stored virtual empty snapshot", async () => {
    const storage = new MemoryEstateStorage();
    const hash = await full(storage, { tables: [], enums: [] });
    const root = await state(storage, hash);
    const into = new MemoryEstateStorage();
    await pruneV1(storage, { checkpoint: { id: root.stateId }, into });
    expect(await into.readSnapshot(hash)).toEqual(
      await storage.readSnapshot(hash)
    );
    expect(await checkEstate(into)).toEqual({ ok: true, findings: [] });
  });

  test("concurrent equal destinations from different bases publish separate authenticated artifacts", async () => {
    class BarrierStorage extends MemoryEstateStorage {
      blocked = false;
      arrivals = 0;
      release = () => {
        // Replaced synchronously by the promise constructor below.
      };
      readonly barrier = new Promise<void>((resolve) => {
        this.release = resolve;
      });
      override async publishState(id: string, bytes: Uint8Array) {
        if (this.blocked) {
          this.arrivals++;
          if (this.arrivals === 2) this.release();
          await this.barrier;
        }
        return super.publishState(id, bytes);
      }
    }
    const storage = new BarrierStorage();
    const root = await migrations(storage).generate({ name: "root" });
    const left = await migrations(storage, 1).generate({
      name: "left",
      from: root.stateId!,
    });
    const right = await migrations(storage, 2).generate({
      name: "right",
      from: root.stateId!,
    });
    storage.blocked = true;
    const [fromLeft, fromRight] = await Promise.all([
      migrations(storage, 3).generate({
        name: "left-destination",
        from: left.stateId!,
      }),
      migrations(storage, 3).generate({
        name: "right-destination",
        from: right.stateId!,
      }),
    ]);
    expect(storage.arrivals).toBe(2);
    expect(fromLeft.outcome).toBe("published");
    expect(fromRight.outcome).toBe("published");
    expect(fromLeft.snapshotHash).toBe(fromRight.snapshotHash);
    const graph = await loadMigrationGraph(storage);
    const leftArtifact = graph.states.get(fromLeft.stateId!)!
      .snapshotArtifactHash!;
    const rightArtifact = graph.states.get(fromRight.stateId!)!
      .snapshotArtifactHash!;
    expect(leftArtifact).toBeDefined();
    expect(rightArtifact).toBeDefined();
    expect(leftArtifact).not.toBe(rightArtifact);
    expect(graph.snapshotArtifacts.get(leftArtifact)?.snapshot).toEqual(
      graph.snapshotArtifacts.get(rightArtifact)?.snapshot
    );
    expect([...graph.leaves].sort()).toEqual(
      [fromLeft.stateId, fromRight.stateId].sort()
    );
  });

  test("branches converge with a complete transition from each parent and reuse returning schemas", async () => {
    const storage = new MemoryEstateStorage();
    const root = await migrations(storage).generate({ name: "root" });
    const left = await migrations(storage, 1).generate({
      from: root.stateId!,
      name: "left",
    });
    const right = await migrations(storage, 2).generate({
      from: root.stateId!,
      name: "right",
    });
    const merge = await migrations(storage, 3).generate({ name: "merge" });
    const graph = await loadMigrationGraph(storage);
    const merged = graph.states.get(merge.stateId!)!;
    expect(merged.parents.map((parent) => parent.fromState).sort()).toEqual(
      [left.stateId, right.stateId].sort()
    );
    const artifact = merged.snapshotArtifactHash!;
    expect(artifact).toBeDefined();
    expect(await migrations(storage, 3).check()).toEqual({
      ok: true,
      findings: [],
    });
    const inventory = await storage.listSnapshots();
    const returned = await migrations(storage).generate({ name: "returned" });
    expect(returned.snapshotHash).toBe(root.snapshotHash);
    expect(await storage.listSnapshots()).toEqual(inventory);
  });

  test("a non-root empty parent still reuses an earlier delta", async () => {
    const storage = new MemoryEstateStorage();
    await migrations(storage).generate({ name: "root" });
    const earlier = await migrations(storage, 1).generate({ name: "earlier" });
    const before = await loadMigrationGraph(storage);
    const emptied = await state(
      storage,
      before.emptySnapshotHash,
      undefined,
      earlier.stateId!,
      "empty"
    );
    const inventory = await storage.listSnapshots();
    const returned = await migrations(storage, 1).generate({
      name: "returned",
    });
    const graph = await loadMigrationGraph(storage);
    const earlierArtifact = graph.states.get(
      earlier.stateId!
    )!.snapshotArtifactHash;
    expect(earlierArtifact).toBeDefined();
    expect(emptied.manifest.snapshotHash).toBe(graph.emptySnapshotHash);
    expect(graph.states.get(returned.stateId!)!.parents[0]!.fromState).toBe(
      emptied.stateId
    );
    expect(graph.states.get(returned.stateId!)!.snapshotArtifactHash).toBe(
      earlierArtifact
    );
    expect(await storage.listSnapshots()).toEqual(inventory);
    expect(await checkEstate(storage)).toEqual({ ok: true, findings: [] });
  });

  test("manual delta bases come from actual transition parents rather than the automatic leaf", async () => {
    const storage = new MemoryEstateStorage();
    const root = await migrations(storage).generate({ name: "root" });
    await migrations(storage, 1).generate({ name: "leaf" });
    const manual = await migrations(storage, 2).generate({
      name: "manual-branch",
      manualMigration: {
        transitions: [
          {
            from: root.stateId!,
            execution: "transactional",
            up: [sql`SELECT 1`],
            rollback: { kind: "irreversible", reason: "fixture" },
          },
        ],
      },
    });
    const graph = await loadMigrationGraph(storage);
    const artifactHash = graph.states.get(manual.stateId!)!
      .snapshotArtifactHash!;
    const bytes = (await storage.readSnapshot(artifactHash))!;
    expect(new TextDecoder().decode(bytes)).toContain(
      `"baseArtifactHash":"${root.snapshotHash}"`
    );
  });

  test("missing or corrupt delta dependencies fail apply before provider work", async () => {
    class DamagedStorage extends MemoryEstateStorage {
      damaged: string | null = null;
      corrupt = false;
      override async readSnapshot(hash: string) {
        if (hash === this.damaged) return this.corrupt ? utf8Bytes("{}") : null;
        return super.readSnapshot(hash);
      }
    }
    const storage = new DamagedStorage();
    const root = await migrations(storage).generate({ name: "root" });
    await migrations(storage, 1).generate({ name: "next" });
    await loadMigrationGraph(storage);
    storage.damaged = root.snapshotHash;
    await expect(migrations(storage, 1).apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
    });
    storage.corrupt = true;
    await expect(migrations(storage, 1).apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
    });
  });

  test.each([
    "memory",
    "object",
  ])("public generation/check/dry-run/reuse on %s storage", async (kind) => {
    const storage =
      kind === "memory"
        ? new MemoryEstateStorage()
        : new ObjectStoreEstateStorage(new MemoryConditionalObjectStore());
    const root = await migrations(storage).generate({ name: "root" });
    const before = await storage.listSnapshots();
    const preview = await migrations(storage, 1).generate({
      name: "next",
      dryRun: true,
    });
    expect(await storage.listSnapshots()).toEqual(before);
    const next = await migrations(storage, 1).generate({ name: "next" });
    expect(next.stateId).toBe(preview.stateId);
    const graph = await loadMigrationGraph(storage);
    const target = graph.states.get(next.stateId!)!;
    expect(target.snapshotArtifactHash).toBeDefined();
    expect(graph.snapshots.get(next.snapshotHash!)).not.toEqual(
      graph.snapshots.get(root.snapshotHash!)
    );
    expect(await migrations(storage, 1).check()).toEqual({
      ok: true,
      findings: [],
    });
    expect((await migrations(storage, 1).generate()).outcome).toBe("noop");
    const inventory = await storage.listSnapshots();
    await migrations(storage, 1).generate({
      name: "data",
      manualMigration: {
        transitions: [
          {
            from: next.stateId!,
            execution: "transactional",
            up: [sql`SELECT 1`],
            rollback: { kind: "irreversible", reason: "fixture" },
          },
        ],
      },
    });
    expect(await storage.listSnapshots()).toEqual(inventory);
  });

  test("every physical representation and every manifest binding is authenticated, including empty schemas", async () => {
    const storage = new MemoryEstateStorage();
    const base = await full(storage, snapshot());
    const root = await state(storage, base);
    const badHash = "b".repeat(64);
    await state(storage, base, badHash, root.stateId, "missing-representation");
    await expect(loadMigrationGraph(storage)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
    });
    const other = new MemoryEstateStorage();
    const actual = await full(other, snapshot());
    await state(
      other,
      encodeSnapshot({ tables: [], enums: [] }).snapshotHash,
      actual
    );
    await expect(loadMigrationGraph(other)).rejects.toThrow(
      "identity does not match"
    );
  });

  test("manifest physical references are canonical and state-ID authenticated; absent references retain historical identity", async () => {
    const storage = new MemoryEstateStorage();
    const hash = await full(storage, snapshot());
    const original = await state(storage, hash);
    expect(canonicalizeJsonText(original.manifest)).not.toContain(
      "snapshotArtifactHash"
    );
    const withArtifact = encodeStateManifest({
      ...original.manifest,
      snapshotArtifactHash: hash,
    });
    expect(withArtifact.stateId).not.toBe(original.stateId);
    expect(
      parseStateManifest(withArtifact.bytes, withArtifact.stateId)
    ).toEqual(withArtifact.manifest);
    expect(() =>
      parseStateManifest(
        canonicalizeJson({
          ...withArtifact.manifest,
          snapshotArtifactHash: "bad",
        }),
        withArtifact.stateId
      )
    ).toThrow();
    expect(() =>
      parseStateManifest(
        canonicalizeJson({
          ...withArtifact.manifest,
          snapshotArtifactHash: "a".repeat(64),
        }),
        withArtifact.stateId
      )
    ).toThrow();
  });

  test("check includes transitive bases and does not mistake orphan validation for references", async () => {
    const storage = new MemoryEstateStorage();
    const base = await full(storage, snapshot());
    const child = await delta(storage, base, snapshot(1));
    await state(storage, encodeSnapshot(snapshot(1)).snapshotHash, child);
    expect(await checkEstate(storage)).toEqual({ ok: true, findings: [] });
    const orphanBase = await full(storage, snapshot(8));
    const orphan = await delta(storage, orphanBase, snapshot(9));
    const checked = await checkEstate(storage);
    expect(checked.ok).toBe(true);
    expect(checked.findings.map((finding) => finding.message).sort()).toEqual(
      [orphanBase, orphan]
        .map((hash) => `Snapshot ${hash} is not referenced by any state`)
        .sort()
    );
    await delta(storage, "a".repeat(64), snapshot(10));
    expect((await checkEstate(storage)).ok).toBe(false);
  });

  test("a listed but unreadable orphan fails check", async () => {
    class MissingInventoryStorage extends MemoryEstateStorage {
      override async listSnapshots() {
        return ["a".repeat(64)];
      }
    }
    const storage = new MissingInventoryStorage();
    await state(
      storage,
      encodeSnapshot({ tables: [], enums: [] }).snapshotHash
    );
    expect((await checkEstate(storage)).ok).toBe(false);
  });
});
