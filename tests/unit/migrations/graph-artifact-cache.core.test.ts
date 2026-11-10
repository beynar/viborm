/**
 * D3: loadMigrationGraph re-lists and re-reads a tenant's storage on every
 * command, but parses each artifact once per isolate, keyed by the artifact's
 * own content hash. Never by the estate hash: every tenant with the same
 * target shares estate.json.
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import "@src/migrations/dialects/all";
import { generateV1 } from "@src/migrations/generate-v1";
import { ArtifactCache, loadMigrationGraph } from "@src/migrations/graph";
import type { Sha256 } from "@src/migrations/identity";
import type * as SnapshotArtifacts from "@src/migrations/snapshot-artifacts";
import type { MigrationStorageReader } from "@src/migrations/storage/contract";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import type * as V1Parse from "@src/migrations/v1-parse";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { beforeAll, describe, expect, test, vi } from "vitest";

/**
 * Manifest and snapshot parses, counted without retaining their arguments.
 * SQL blobs are not parsed: re-hashing their bytes is their identity check.
 */
const parses = vi.hoisted(() => ({ count: 0 }));
// The vitest setup file registers every migration driver, which loads the
// module mocked below first; drop that cache so this file's imports see the mock.
vi.hoisted(() => vi.resetModules());

vi.mock("@src/migrations/v1-parse", async (importOriginal) => {
  const actual = await importOriginal<typeof V1Parse>();
  const counted =
    <A extends unknown[], R>(parser: (...args: A) => R) =>
    (...args: A): R => {
      parses.count++;
      return parser(...args);
    };
  return {
    ...actual,
    parseStateManifest: counted(actual.parseStateManifest),
  };
});

vi.mock("@src/migrations/snapshot-artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof SnapshotArtifacts>();
  return {
    ...actual,
    parseSnapshotArtifact: (
      ...args: Parameters<typeof actual.parseSnapshotArtifact>
    ) => {
      parses.count++;
      return actual.parseSnapshotArtifact(...args);
    },
  };
});

const SNAPSHOT_HASH_PROPERTY = /"snapshotHash":"[0-9a-f]{64}"/;

const MODELS = 20;
const STATES = 200;

/** Twenty 15-field models; state `i` adds one column to model `i % 20`. */
function schemaAt(step: number) {
  const schema: Record<string, ReturnType<typeof s.model>> = {};
  for (let m = 0; m < MODELS; m++) {
    const fields: Record<string, unknown> = {
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      bio: s.string().nullable(),
      age: s.int(),
      score: s.number(),
      active: s.boolean(),
      createdAt: s.dateTime(),
      updatedAt: s.dateTime().nullable(),
      rank: s.int().nullable(),
      slug: s.string(),
      note: s.string().nullable(),
      flag: s.boolean().nullable(),
      weight: s.number().nullable(),
      code: s.string(),
    };
    for (let i = m + MODELS; i <= step; i += MODELS) {
      fields[`extra${i}`] = s.string().nullable();
    }
    schema[`model${m}`] = s.model(fields as never);
  }
  return schema;
}

async function buildEstate(): Promise<MemoryEstateStorage> {
  const storage = new MemoryEstateStorage();
  for (let step = MODELS - 1; step < MODELS - 1 + STATES; step++) {
    const client = createClient({
      schema: schemaAt(step),
      driver: new PlanningDriver("sqlite"),
    });
    await generateV1(client, storage, { name: `s${step}` });
    await client.$disconnect();
  }
  return storage;
}

/** A tenant's storage that serves its own bytes for selected keys. */
function overriding(
  base: MigrationStorageReader,
  snapshots: ReadonlyMap<Sha256, Uint8Array>
): MigrationStorageReader {
  return {
    readEstate: () => base.readEstate(),
    listStates: () => base.listStates(),
    listSnapshots: () => base.listSnapshots(),
    listSql: () => base.listSql(),
    readState: (id) => base.readState(id),
    readSql: (hash) => base.readSql(hash),
    readSnapshot: async (hash) =>
      snapshots.get(hash)?.slice() ?? base.readSnapshot(hash),
  };
}

describe("migration graph artifact cache", () => {
  let storage: MemoryEstateStorage;

  beforeAll(async () => {
    storage = await buildEstate();
  }, 300_000);

  test("a second command on a 200-state estate parses no artifact again", async () => {
    const first = await loadMigrationGraph(storage);
    expect(first.states.size).toBe(STATES);
    const reads = vi.spyOn(storage, "readSnapshot");
    parses.count = 0;

    const second = await loadMigrationGraph(storage);

    expect(parses.count).toBe(0);
    // Storage stays the source of truth: every artifact is still read.
    expect(reads).toHaveBeenCalledTimes(STATES);
    expect([...second.states.keys()]).toEqual([...first.states.keys()]);
    expect(second.snapshots).toEqual(first.snapshots);
    reads.mockRestore();
  });

  test("a bound below the estate keeps the held bytes under it and re-parses", async () => {
    const bound = 1024 * 1024;
    const cache = new ArtifactCache(bound);
    await loadMigrationGraph(storage, cache);
    expect(cache.heldBytes).toBeGreaterThan(bound / 2);
    expect(cache.heldBytes).toBeLessThanOrEqual(bound);
    parses.count = 0;
    await loadMigrationGraph(storage, cache);
    expect(parses.count).toBeGreaterThan(0);
    expect(cache.heldBytes).toBeLessThanOrEqual(bound);
  });

  test("cached artifacts are immutable", async () => {
    const graph = await loadMigrationGraph(storage);
    const [stateId, manifest] = [...graph.states][0]!;
    const snapshot = graph.snapshots.get(manifest.snapshotHash)!;
    expect(() => {
      (snapshot.tables as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      (manifest as { name: string }).name = "renamed";
    }).toThrow(TypeError);
    expect((await loadMigrationGraph(storage)).states.get(stateId)?.name).toBe(
      manifest.name
    );
  });

  test("tampered bytes under a cached name are refused, never served", async () => {
    const graph = await loadMigrationGraph(storage);
    const state = [...graph.states.values()][STATES - 1]!;
    const hash = state.snapshotArtifactHash ?? state.snapshotHash;
    const bytes = (await storage.readSnapshot(hash))!;
    const tampered = new TextEncoder().encode(
      state.snapshotArtifactHash
        ? new TextDecoder()
            .decode(bytes)
            .replace(
              SNAPSHOT_HASH_PROPERTY,
              `"snapshotHash":"${"0".repeat(64)}"`
            )
        : new TextDecoder().decode(bytes).replace('"model0"', '"model9"')
    );
    expect(tampered).not.toEqual(bytes);
    const outcome = await loadMigrationGraph(
      overriding(storage, new Map([[hash, tampered]]))
    ).then(
      () => "loaded",
      (error: { code?: unknown }) => error.code
    );
    expect(outcome).toBe(VibORMErrorCode.MIGRATION_CORRUPTION);
    // The refusal leaves the honest tenant's cached parses intact.
    parses.count = 0;
    await expect(loadMigrationGraph(storage)).resolves.toBeDefined();
    expect(parses.count).toBe(0);
  });

  test("two tenants with the same estate.json share only identical artifacts", async () => {
    const left = await loadMigrationGraph(storage);
    const other = new MemoryEstateStorage();
    const client = createClient({
      schema: { only: s.model({ id: s.string().id() }) },
      driver: new PlanningDriver("sqlite"),
    });
    await generateV1(client, other, { name: "other" });
    await client.$disconnect();
    expect(await other.readEstate()).toEqual(await storage.readEstate());

    const right = await loadMigrationGraph(other);

    expect(right.estateHash).toBe(left.estateHash);
    expect(right.states.size).toBe(1);
    for (const id of right.states.keys()) {
      expect(left.states.has(id)).toBe(false);
    }
    expect(right.leaves).not.toEqual(left.leaves);
  });
});
