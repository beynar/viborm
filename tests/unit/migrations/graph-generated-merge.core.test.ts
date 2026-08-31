import { s } from "@schema";
import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { generateV1 } from "@src/migrations/generate-v1";
import { loadMigrationGraph, selectRoute } from "@src/migrations/graph";
import type { Sha256 } from "@src/migrations/identity";
import type { MigrationClient } from "@src/migrations/push/planner";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import type { AnyModel } from "@src/schema/model";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, test } from "vitest";

const user = s.model({ id: s.string().id(), email: s.string().unique() });
const post = s.model({ id: s.string().id(), title: s.string() });
const tag = s.model({ id: s.string().id(), label: s.string() });

const driver = new PlanningDriver("sqlite");

function clientFor(schema: Record<string, AnyModel>): MigrationClient {
  return { $driver: driver, $schema: schema };
}

function requireState(id: Sha256 | null): Sha256 {
  if (!id) throw new Error("generate did not publish a state");
  return id;
}

describe("generated estate merges", () => {
  test("two generated branches converge into one state with both parents", async () => {
    const storage = new MemoryEstateStorage();
    const init = requireState(
      (await generateV1(clientFor({ user }), storage, { name: "init" })).stateId
    );
    const left = requireState(
      (
        await generateV1(clientFor({ user, post }), storage, {
          name: "left",
          from: init,
        })
      ).stateId
    );
    const right = requireState(
      (
        await generateV1(clientFor({ user, tag }), storage, {
          name: "right",
          from: init,
        })
      ).stateId
    );

    const merged = await generateV1(clientFor({ user, post, tag }), storage, {
      name: "merge",
    });
    const mergeId = requireState(merged.stateId);

    expect(merged.outcome).toBe("published");
    const graph = await loadMigrationGraph(storage);
    expect(graph.leaves).toEqual([mergeId]);
    const parents = (graph.states.get(mergeId)?.parents ?? []).map(
      (parent) => parent.fromState
    );
    expect([...parents].sort()).toEqual([left, right].sort());
    expect(selectRoute(graph, left, mergeId)).toEqual([mergeId]);
    expect(selectRoute(graph, right, mergeId)).toEqual([mergeId]);
  });

  test("an explicit virtual-root parent is accepted only while the estate is empty", async () => {
    const storage = new MemoryEstateStorage();
    const root = await generateV1(clientFor({ user }), storage, {
      name: "root",
      from: null,
    });
    const rootId = requireState(root.stateId);

    expect(root.outcome).toBe("published");
    const graph = await loadMigrationGraph(storage);
    expect(graph.roots).toEqual([rootId]);

    await expect(
      generateV1(clientFor({ user, post }), storage, {
        name: "second-root",
        from: null,
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      message: expect.stringContaining("second virtual-root transition"),
    });
  });

  test("a manual transition cannot introduce a second virtual root", async () => {
    const storage = new MemoryEstateStorage();
    await generateV1(clientFor({ user }), storage, { name: "init" });

    await expect(
      generateV1(clientFor({ user }), storage, {
        name: "manual-root",
        manualMigration: {
          transitions: [
            {
              from: null,
              execution: "transactional",
              up: [sql`SELECT 1`],
              rollback: { kind: "irreversible", reason: "manual root" },
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      message: expect.stringContaining("second virtual-root transition"),
    });
  });
});
