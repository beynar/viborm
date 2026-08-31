import { VibORMErrorCode } from "@src/errors";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import {
  loadMigrationGraph,
  type MigrationGraph,
  selectRoute,
} from "@src/migrations/graph";
import type { Sha256 } from "@src/migrations/identity";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeStateManifest,
  encodeTransitionHash,
} from "@src/migrations/v1-parse";
import type { MigrationParentTransitionV1 } from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";

/** A well-formed digest that no state in the fixture estate ever hashes to. */
const OUTSIDE_ESTATE: Sha256 = "9".repeat(64);

interface RouteEstate {
  readonly graph: MigrationGraph;
  readonly id: (name: string) => Sha256;
}

/**
 * The smallest estate a route question can be asked of: one empty SQL blob,
 * the empty snapshot, and states that differ only in name and parentage.
 */
async function linearEstate(): Promise<RouteEstate> {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  const snapshot = encodeSnapshot(emptyManagedSnapshot());
  const blob = composeSqlBlob([]);
  await storage.publishEstate(estate.bytes);
  await storage.publishSql(blob.sqlHash, blob.bytes);

  const ids = new Map<string, Sha256>();
  for (const [name, from] of [
    ["root", null],
    ["child", "root"],
  ] as const) {
    const parent: Omit<MigrationParentTransitionV1, "transitionHash"> = {
      fromState: from === null ? null : (ids.get(from) ?? null),
      originChecks: [],
      requestedForwardBoundary: null,
      operations: [],
      rollback: { kind: "irreversible", reason: "route fixture" },
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
    ids.set(name, encoded.stateId);
  }

  return {
    graph: await loadMigrationGraph(storage),
    id: (name) => {
      const found = ids.get(name);
      if (!found) throw new Error(`the fixture has no state named ${name}`);
      return found;
    },
  };
}

function refusalFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("the route was accepted but a refusal was expected");
}

describe("estate route boundaries", () => {
  test("a via step naming a state outside the estate is not a real edge", async () => {
    const estate = await linearEstate();
    const child = estate.id("child");

    expect(
      refusalFrom(() =>
        selectRoute(estate.graph, null, child, [OUTSIDE_ESTATE, child])
      )
    ).toMatchObject({
      code: VibORMErrorCode.MIGRATION_PATH_REQUIRED,
      message: expect.stringContaining("not a real estate edge"),
    });
  });

  test("a marker pointing outside the estate reaches no target", async () => {
    const estate = await linearEstate();

    expect(
      refusalFrom(() =>
        selectRoute(estate.graph, OUTSIDE_ESTATE, estate.id("child"))
      )
    ).toMatchObject({
      code: VibORMErrorCode.MIGRATION_NOT_FOUND,
      message: expect.stringContaining("No path exists"),
    });
  });

  test("the same graph still routes from the virtual root and from a real marker", async () => {
    const estate = await linearEstate();
    const root = estate.id("root");
    const child = estate.id("child");

    expect(selectRoute(estate.graph, null, child)).toEqual([root, child]);
    expect(selectRoute(estate.graph, root, child)).toEqual([child]);
    expect(selectRoute(estate.graph, null, child, [root, child])).toEqual([
      root,
      child,
    ]);
  });
});
