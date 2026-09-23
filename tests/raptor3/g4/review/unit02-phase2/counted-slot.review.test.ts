/**
 * G4-02 phase-2 review — the ONE counted-slot owner (§P.4.3, decision E-c).
 *
 * `countedMemberships` now answers every arm of a variant carrier and
 * `correlatedCount` sums them. Two things the author's Q-O04 cell does not
 * reach:
 *   1. the `where` a `_count: { select: { slot: { where } } }` carries is
 *      prepared against ONE arm's target and then lowered inside EVERY arm's
 *      subquery;
 *   2. the slot lookup `this.schema.index.get(model)!.get(relation)!` asserts a
 *      resolved entry for a name the caller spelled.
 * Both are compared with the shipped engine, which is the parity the witness
 * estate pins for every other read.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  relationWorldSchema,
  seedJunctions,
  seedRelationWorld,
} from "../../read-schema";
import { createWitnessWorld, type WitnessWorld } from "../../witness-world";

async function world(): Promise<WitnessWorld> {
  return await createWitnessWorld(relationWorldSchema(), {
    seed: (database) => {
      seedRelationWorld(database);
      seedJunctions(database);
    },
  });
}

async function observe(
  invoke: () => Promise<unknown>
): Promise<{ value?: unknown; error?: Error }> {
  try {
    return { value: await invoke() };
  } catch (failure) {
    return { error: failure as Error };
  }
}

describe("G4-02 review — the counted slot over a variant carrier", () => {
  it("counts a variant carrier's arms with no `where`, as the shipped engine does", async () => {
    const live = await world();
    try {
      const args = {
        orderBy: { id: "asc" },
        select: { id: true, _count: { select: { items: true } } },
      };
      const shipped = await observe(() =>
        Promise.resolve(live.shipped.board?.findMany?.(args))
      );
      const candidate = await observe(() =>
        live.candidate.execute("board", "findMany", args)
      );
      assert.deepEqual(
        candidate.value ?? String(candidate.error),
        shipped.value ?? String(shipped.error),
        `candidate ${JSON.stringify(candidate.value) ?? candidate.error?.message} vs shipped ${JSON.stringify(shipped.value) ?? shipped.error?.message}`
      );
    } finally {
      await live.close();
    }
  });

  it("answers a filtered variant `_count` the way the shipped engine does", async () => {
    const live = await world();
    try {
      // `views` is a column of the POST arm only; the TAG arm has no such
      // column. One prepared selector, two arms.
      const args = {
        where: { id: 1 },
        select: {
          id: true,
          _count: { select: { items: { where: { views: { gt: 5 } } } } },
        },
      };
      const shipped = await observe(() =>
        Promise.resolve(live.shipped.board?.findMany?.(args))
      );
      const candidate = await observe(() =>
        live.candidate.execute("board", "findMany", args)
      );
      assert.equal(
        candidate.error?.constructor.name,
        shipped.error?.constructor.name,
        `candidate ${candidate.error ? `${candidate.error.constructor.name}: ${candidate.error.message}` : JSON.stringify(candidate.value)} vs shipped ${shipped.error ? `${shipped.error.constructor.name}: ${shipped.error.message}` : JSON.stringify(shipped.value)}`
      );
      if (!shipped.error)
        assert.deepEqual(candidate.value, shipped.value);
    } finally {
      await live.close();
    }
  });

  it("refuses a `_count` over a name that is not a relation, as the shipped engine does", async () => {
    const live = await world();
    try {
      const args = {
        where: { id: 1 },
        select: { id: true, _count: { select: { title: true } } },
      };
      const shipped = await observe(() =>
        Promise.resolve(live.shipped.board?.findMany?.(args))
      );
      const candidate = await observe(() =>
        live.candidate.execute("board", "findMany", args)
      );
      assert.equal(
        candidate.error?.constructor.name,
        shipped.error?.constructor.name,
        `candidate ${candidate.error ? `${candidate.error.constructor.name}: ${candidate.error.message}` : JSON.stringify(candidate.value)} vs shipped ${shipped.error ? `${shipped.error.constructor.name}: ${shipped.error.message}` : JSON.stringify(shipped.value)}`
      );
    } finally {
      await live.close();
    }
  });

  it("orders by a variant carrier's `_count` the way the shipped engine does", async () => {
    const live = await world();
    try {
      const args = {
        orderBy: [{ items: { _count: "desc" } }, { id: "asc" }],
        select: { id: true },
      };
      const shipped = await observe(() =>
        Promise.resolve(live.shipped.board?.findMany?.(args))
      );
      const candidate = await observe(() =>
        live.candidate.execute("board", "findMany", args)
      );
      assert.deepEqual(
        candidate.value ?? String(candidate.error),
        shipped.value ?? String(shipped.error)
      );
    } finally {
      await live.close();
    }
  });
});
