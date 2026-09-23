/**
 * G4-02 phase-2 review — the tagged variant collection quantifier (§P.4.4,
 * Q-W10). The unit fixed `some`/`none`/`every` over a tagged arm and added the
 * "only `every` also states the other arms" rule. The witness cell pins four
 * shapes; this matrix asks the shipped engine for twenty more, including the
 * combinations the new AND-of-`none` arm could over- or under-match:
 * two quantifiers in one slot, `isNot`, a negated wrapper, an empty collection,
 * and `every` over the arm a board does NOT hold.
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

async function outcome(invoke: () => Promise<unknown>): Promise<string> {
  try {
    return `ok:${JSON.stringify(await invoke())}`;
  } catch (error) {
    return `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
}

const CASES: [string, unknown][] = [
  ["some post", { some: { type: "post" } }],
  ["some tag", { some: { type: "tag" } }],
  ["some post with is", { some: { type: "post", is: { views: { gt: 15 } } } }],
  ["some post with unsatisfiable is", { some: { type: "post", is: { views: { gt: 1000 } } } }],
  ["some post with isNot", { some: { type: "post", isNot: { views: { gt: 15 } } } }],
  ["none post", { none: { type: "post" } }],
  ["none tag", { none: { type: "tag" } }],
  ["none post with is", { none: { type: "post", is: { views: { gt: 15 } } } }],
  ["none tag with is", { none: { type: "tag", is: { weight: { gt: 4 } } } }],
  ["every post", { every: { type: "post" } }],
  ["every tag", { every: { type: "tag" } }],
  ["every post with is", { every: { type: "post", is: { views: { gt: 5 } } } }],
  ["every post with unsatisfiable is", { every: { type: "post", is: { views: { gt: 1000 } } } }],
  ["every post with isNot", { every: { type: "post", isNot: { views: { gt: 1000 } } } }],
  ["some post and none tag", { some: { type: "post" }, none: { type: "tag" } }],
  ["some post and every post", { some: { type: "post" }, every: { type: "post", is: { views: { gt: 5 } } } }],
];

describe("G4-02 review — tagged variant quantifiers against the shipped engine", () => {
  for (const [name, items] of CASES) {
    it(`${name}`, async () => {
      const live = await world();
      try {
        const args = {
          where: { items },
          orderBy: { id: "asc" },
          select: { id: true },
        };
        const shipped = await outcome(() =>
          Promise.resolve(live.shipped.board?.findMany?.(args))
        );
        const candidate = await outcome(() =>
          live.candidate.execute("board", "findMany", args)
        );
        assert.equal(
          candidate,
          shipped,
          `candidate ${candidate}\nshipped   ${shipped}`
        );
      } finally {
        await live.close();
      }
    });
  }

  it("under a NOT wrapper", async () => {
    const live = await world();
    try {
      const args = {
        where: { NOT: { items: { every: { type: "post" } } } },
        orderBy: { id: "asc" },
        select: { id: true },
      };
      const shipped = await outcome(() =>
        Promise.resolve(live.shipped.board?.findMany?.(args))
      );
      const candidate = await outcome(() =>
        live.candidate.execute("board", "findMany", args)
      );
      assert.equal(candidate, shipped, `candidate ${candidate}\nshipped   ${shipped}`);
    } finally {
      await live.close();
    }
  });

  it("over a board whose collection is empty", async () => {
    const live = await world();
    try {
      for (const items of [
        { every: { type: "post" } },
        { none: { type: "post" } },
        { some: { type: "post" } },
      ]) {
        const args = {
          where: { AND: [{ id: 2 }, { items }] },
          select: { id: true },
        };
        const shipped = await outcome(() =>
          Promise.resolve(live.shipped.board?.findMany?.(args))
        );
        const candidate = await outcome(() =>
          live.candidate.execute("board", "findMany", args)
        );
        assert.equal(
          candidate,
          shipped,
          `${JSON.stringify(items)}\ncandidate ${candidate}\nshipped   ${shipped}`
        );
      }
    } finally {
      await live.close();
    }
  });
});
