import { createClient } from "@client/client";
import { s } from "@schema";
import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { generateV1 } from "@src/migrations/generate-v1";
import {
  loadMigrationGraph,
  resolveStateSelector,
  selectRoute,
} from "@src/migrations/graph";
import type { Sha256 } from "@src/migrations/identity";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  encodeDispatchIdentity,
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeStateId,
  encodeStateManifest,
  encodeTransitionHash,
} from "@src/migrations/v1-parse";
import type {
  MigrationParentTransitionV1,
  MigrationStateManifestV1,
} from "@src/migrations/v1-types";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, expectTypeOf, test } from "vitest";

async function publishEstate() {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  const snapshot = encodeSnapshot(emptyManagedSnapshot());
  const blob = composeSqlBlob([]);
  await storage.publishEstate(estate.bytes);
  await storage.publishSql(blob.sqlHash, blob.bytes);
  return { storage, estate, snapshot, blob };
}

function parentFor(
  blob: ReturnType<typeof composeSqlBlob>,
  fromState: string | null
): MigrationParentTransitionV1 {
  const body: Omit<MigrationParentTransitionV1, "transitionHash"> = {
    fromState,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [
      {
        id: "empty",
        label: "empty",
        origin: "generated",
        risk: "safe",
        steps: [
          {
            retry: "opaque",
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
    rollback: { kind: "irreversible", reason: "merge fixture" },
  };
  return { ...body, transitionHash: encodeTransitionHash(body) };
}

async function publishState(
  published: Awaited<ReturnType<typeof publishEstate>>,
  name: string,
  parents: Array<string | null>
) {
  const encoded = encodeStateManifest({
    format: "1",
    estateHash: published.estate.estateHash,
    name,
    snapshotHash: published.snapshot.snapshotHash,
    sqlHash: published.blob.sqlHash,
    destinationChecks: [],
    parents: parents.map((from) => parentFor(published.blob, from)),
  });
  await published.storage.publishState(encoded.stateId, encoded.bytes);
  return encoded.stateId;
}

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});

describe("migration v1 graph merges", () => {
  test("a linear estate selects the unique leaf and an explicit target", async () => {
    const published = await publishEstate();
    const root = await publishState(published, "root", [null]);
    const child = await publishState(published, "child", [root]);
    const graph = await loadMigrationGraph(published.storage);
    expect(graph.roots).toEqual([root]);
    expect(graph.leaves).toEqual([child]);
    expect(selectRoute(graph, null, child)).toEqual([root, child]);
    expect(resolveStateSelector(graph, { id: child })).toBe(child);
    expect(resolveStateSelector(graph, { name: "child" })).toBe(child);
    expect(resolveStateSelector(graph, { prefix: child.slice(0, 8) })).toBe(
      child
    );
    expectTypeOf(graph.leaves).toMatchTypeOf<readonly string[]>();
  });

  test("a diamond merge requires via when two routes exist", async () => {
    const published = await publishEstate();
    const root = await publishState(published, "root", [null]);
    const left = await publishState(published, "left", [root]);
    const right = await publishState(published, "right", [root]);
    const merge = await publishState(published, "merge", [left, right]);
    const graph = await loadMigrationGraph(published.storage);
    expect(graph.leaves).toEqual([merge]);
    expect(selectRoute(graph, root, left)).toEqual([left]);
    try {
      selectRoute(graph, null, merge);
      throw new Error("expected via");
    } catch (error) {
      expect(error).toMatchObject({
        code: VibORMErrorCode.MIGRATION_PATH_REQUIRED,
      });
    }
    expect(selectRoute(graph, null, merge, [root, left, merge])).toEqual([
      root,
      left,
      merge,
    ]);
  });

  test("a three-parent merge loads and still requires via", async () => {
    const published = await publishEstate();
    const root = await publishState(published, "root", [null]);
    const a = await publishState(published, "a", [root]);
    const b = await publishState(published, "b", [root]);
    const c = await publishState(published, "c", [root]);
    const merge = await publishState(published, "merge", [a, b, c]);
    const graph = await loadMigrationGraph(published.storage);
    expect(graph.states.get(merge)?.parents).toHaveLength(3);
    expect(() => selectRoute(graph, root, merge)).toThrow();
    expect(selectRoute(graph, root, merge, [a, merge])).toEqual([a, merge]);
  });

  test("wrong, repeated, and incomplete via paths refuse", async () => {
    const published = await publishEstate();
    const root = await publishState(published, "root", [null]);
    const left = await publishState(published, "left", [root]);
    const right = await publishState(published, "right", [root]);
    const merge = await publishState(published, "merge", [left, right]);
    const graph = await loadMigrationGraph(published.storage);
    expect(() => selectRoute(graph, null, merge, [root, right])).toThrow();
    expect(() =>
      selectRoute(graph, null, merge, [root, left, left, merge])
    ).toThrow();
    expect(() =>
      selectRoute(graph, null, merge, [root, right, left, merge])
    ).toThrow();
    expect(() => selectRoute(graph, left, merge, [right, merge])).toThrow();
  });

  test("a custom or data leaf cannot be merged structurally without manualMigration", async () => {
    const storage = new MemoryEstateStorage();
    const client = createClient({
      schema: { user },
      driver: new PlanningDriver("sqlite"),
    });
    const init = await generateV1(client, storage, { name: "init" });
    expect(init.stateId).toBeTruthy();
    await generateV1(client, storage, {
      name: "left-data",
      from: init.stateId,
      manualMigration: {
        transitions: [
          {
            from: init.stateId,
            execution: "transactional",
            up: [sql`SELECT 1`],
            rollback: { kind: "irreversible", reason: "data left" },
          },
        ],
      },
    });
    await generateV1(client, storage, {
      name: "right-data",
      from: init.stateId,
      manualMigration: {
        transitions: [
          {
            from: init.stateId,
            execution: "transactional",
            up: [sql`SELECT 2`],
            rollback: { kind: "irreversible", reason: "data right" },
          },
        ],
      },
    });
    await expect(
      generateV1(client, storage, { name: "merge" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
    });
    await client.$disconnect();
  });

  test("same inputs produce the same state id; a changed name is a distinct child", async () => {
    const published = await publishEstate();
    const parent = parentFor(published.blob, null);
    const body: Omit<MigrationStateManifestV1, "stateId"> = {
      format: "1",
      estateHash: published.estate.estateHash,
      name: "same",
      snapshotHash: published.snapshot.snapshotHash,
      sqlHash: published.blob.sqlHash,
      destinationChecks: [],
      parents: [parent],
    };
    const first = encodeStateManifest(body);
    const second = encodeStateManifest(body);
    expect(first.stateId).toBe(second.stateId);
    expect(first.stateId).toBe(encodeStateId(body));
    const renamed = encodeStateManifest({ ...body, name: "other" });
    expect(renamed.stateId).not.toBe(first.stateId);
    const changed = encodeStateManifest({
      ...body,
      parents: [parentFor(published.blob, "0".repeat(64) as Sha256)],
    });
    expect(changed.stateId).not.toBe(first.stateId);
  });
});
