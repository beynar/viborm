import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";

/**
 * X1 — THE DEPTH LIFT. A nested `create` under a LOCATED target may now carry its
 * own create-context grandchildren to ARBITRARY depth (a create SUBTREE). The
 * fresh child's own primary key is a construction-time literal, so it is a literal
 * parent for its grandchildren — the same `buildNestedTargetChildParts` seam, one
 * level deeper, with NO counter. Before X1 the located-target create leaf threw
 * `... nested relation writes in the create data ... one level deeper` for any
 * relation-carrying create arm; that depth-only refusal is now recursion.
 *
 * ORACLE MODEL (no Direct exists post-P6): a FIXED-EXPECTATION oracle. The expected
 * persisted state is PINNED here; tx and batch substrates must both produce it,
 * byte-identical, on a NATIVE Observed execution (engines === {production}, never a fallback).
 *
 * MULTI-PARENT WITNESS (mandatory): a disjoint second subtree that must stay
 * untouched, and every deep grandchild's `parentId` pinned to its IMMEDIATE
 * ancestor (g2 under g1, NOT under the located c1). The threading is load-bearing:
 * break `literalParentId(scalarData[pkField])` in
 * `buildFreshCreateGrandchildParts` (inject the located target's id instead of the
 * fresh child's own id) and the whole chain collapses onto c1 — the pinned
 * `parentId` map below diverges and this test fails. That is the standing
 * falsification.
 */

const tree = (() => {
  const node = s
    .model({
      id: s.string().id(),
      name: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
    })
    .map("x1_node");
  return { node };
})();

function makeClient(db: PGlite) {
  return createClient({
    schema: tree as never,
    driver: new PGliteDriver({ client: db }),
  });
}
type AnyClient = ReturnType<typeof makeClient>;

async function runObserved(
  substrate: "tx" | "batch",
  seed: (c: AnyClient) => Promise<void>,
  op: (c: Record<string, any>) => Promise<void>,
  snap: (c: AnyClient) => Promise<unknown>
): Promise<{ state: unknown; engines: Set<"direct" | "production"> }> {
  const db = new PGlite();
  const base = makeClient(db);
  await push(base as never, { force: true });
  await seed(base);
  const driver =
    substrate === "tx"
      ? new PGliteDriver({ client: db })
      : new BatchOnlyPGliteDriver({ client: db });
  const observed = observeClientOperations({
    schema: tree as never,
    driver,
  });
  await op(observed.client);
  const state = await snap(base);
  await base.$disconnect();
  return {
    state,
    engines: new Set(observed.operations.map((r) => r.boundary)),
  };
}

const snapParents = async (c: AnyClient) => {
  const rows = await (c as any).node.findMany({ orderBy: { id: "asc" } });
  return rows.map((r: any) => [r.id, r.parentId, r.name]);
};

// A create chain of `depth` fresh nodes under the deepest level, each nesting the
// next through `children.create` — the create-context recursion the leaf now folds.
function createChain(ids: readonly string[], index = 0): any {
  const id = ids[index]!;
  const data: any = { id, name: id };
  if (index < ids.length - 1) {
    data.children = { create: createChain(ids, index + 1) };
  }
  return data;
}

describe("X1 depth lift — create-context chain under a located update target", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    // Target subtree: c0 -> c1.
    await client.node.create({ data: { id: "c0", name: "c0" } });
    await client.node.create({
      data: { id: "c1", name: "c1", parentId: "c0" },
    });
    // Disjoint witness subtree: d0 -> d1 -> dd1, must stay untouched.
    await client.node.create({ data: { id: "d0", name: "d0" } });
    await client.node.create({
      data: { id: "d1", name: "d1", parentId: "d0" },
    });
    await client.node.create({
      data: { id: "dd1", name: "dd1", parentId: "d1" },
    });
  };

  // update(c0) -> children.update(c1) -> children.create(g1{...g5}) : a 5-deep
  // create chain grafted under the located c1.
  const op = async (c: Record<string, any>) => {
    await c.node.update({
      where: { id: "c0" },
      data: {
        children: {
          update: {
            where: { id: "c1" },
            data: {
              children: {
                create: createChain(["g1", "g2", "g3", "g4", "g5"]),
              },
            },
          },
        },
      },
    });
  };

  // The PINNED oracle: each gN attaches to its IMMEDIATE ancestor; the disjoint
  // d-subtree is untouched.
  const expected = [
    ["c0", null, "c0"],
    ["c1", "c0", "c1"],
    ["d0", null, "d0"],
    ["d1", "d0", "d1"],
    ["dd1", "d1", "dd1"],
    ["g1", "c1", "g1"],
    ["g2", "g1", "g2"],
    ["g3", "g2", "g3"],
    ["g4", "g3", "g4"],
    ["g5", "g4", "g5"],
  ];

  for (const substrate of ["tx", "batch"] as const) {
    test(`${substrate}: 5-deep create chain grafts under c1, native Observed, multi-parent witness`, async () => {
      const { state, engines } = await runObserved(
        substrate,
        seed,
        op,
        snapParents
      );
      expect(engines).toEqual(new Set(["production"]));
      expect(state).toEqual(expected);
    });
  }
});

describe("X1 depth lift — branching + mixed create/createMany subtree at depth", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.node.create({ data: { id: "c0", name: "c0" } });
    await client.node.create({
      data: { id: "c1", name: "c1", parentId: "c0" },
    });
  };

  // A branching create subtree three levels deep, with a createMany leaf — every
  // fresh row is a literal parent for the next.
  const op = async (c: Record<string, any>) => {
    await c.node.update({
      where: { id: "c0" },
      data: {
        children: {
          update: {
            where: { id: "c1" },
            data: {
              children: {
                create: {
                  id: "g1",
                  name: "g1",
                  children: {
                    create: {
                      id: "g2",
                      name: "g2",
                      children: {
                        createMany: {
                          data: [
                            { id: "g3a", name: "g3a" },
                            { id: "g3b", name: "g3b" },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  };

  const expected = [
    ["c0", null, "c0"],
    ["c1", "c0", "c1"],
    ["g1", "c1", "g1"],
    ["g2", "g1", "g2"],
    ["g3a", "g2", "g3a"],
    ["g3b", "g2", "g3b"],
  ];

  for (const substrate of ["tx", "batch"] as const) {
    test(`${substrate}: branching create + createMany leaf at depth`, async () => {
      const { state, engines } = await runObserved(
        substrate,
        seed,
        op,
        snapParents
      );
      expect(engines).toEqual(new Set(["production"]));
      expect(state).toEqual(expected);
    });
  }
});

describe("X1 depth lift — create-context chain under a PLANNED parent-held target", () => {
  // update(c1) -> parent.update(c0) -> children.create(chain): the located target
  // (c0) is read by a PLANNED probe; the fresh grandchildren still correlate to
  // their OWN literal PKs, one step past the planned-parent leaf.
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.node.create({ data: { id: "c0", name: "c0" } });
    await client.node.create({
      data: { id: "c1", name: "c1", parentId: "c0" },
    });
    // disjoint witness
    await client.node.create({ data: { id: "e0", name: "e0" } });
  };
  const op = async (c: Record<string, any>) => {
    await c.node.update({
      where: { id: "c1" },
      data: {
        parent: {
          update: {
            name: "c0-renamed",
            children: { create: createChain(["h1", "h2", "h3"]) },
          },
        },
      },
    });
  };
  const expected = [
    ["c0", null, "c0-renamed"],
    ["c1", "c0", "c1"],
    ["e0", null, "e0"],
    ["h1", "c0", "h1"],
    ["h2", "h1", "h2"],
    ["h3", "h2", "h3"],
  ];
  for (const substrate of ["tx", "batch"] as const) {
    test(`${substrate}: create chain under a planned parent-held target`, async () => {
      const { state, engines } = await runObserved(
        substrate,
        seed,
        op,
        snapParents
      );
      expect(engines).toEqual(new Set(["production"]));
      expect(state).toEqual(expected);
    });
  }
});
