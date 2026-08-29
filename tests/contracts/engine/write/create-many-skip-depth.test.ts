import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";

import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * X1b MECHANISM 3 — createMany skipDuplicates at depth.
 *
 * The T4a composed skipDuplicates leaf (SQL `ON CONFLICT DO NOTHING` /
 * `INSERT OR IGNORE`, or a `recoverableUniqueError` per-row `onUniqueConflict`
 * effect on MySQL) now composes under a nested fresh write — a `createMany` under
 * a LOCATED update target, and one level further under a fresh `create`. Before
 * X1b the depth `createMany` leaf threw `does not support nested createMany
 * skipDuplicates … one level deeper`; that depth-only refusal is now the same
 * composed skip the create root has used since T4a.
 *
 * FIXED-EXPECTATION oracle (no Direct exists post-P6): the persisted state is pinned;
 * tx and batch substrates must both produce it, byte-identical, on a NATIVE Observed
 * execution (engines === {production}). MULTI-PARENT + WRONG-ROW witness: a disjoint
 * subtree stays untouched, and each inserted child's `parentId` is pinned to its
 * IMMEDIATE ancestor (the located target / the fresh create), never a sibling —
 * the standing falsification for the injected FK.
 */

const tree = (() => {
  const node = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      name: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
    })
    .map("x1b_cm_node");
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
  await syncLiveSchema(base as never);
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

const snap = async (c: AnyClient) => {
  const rows = await (c as any).node.findMany({ orderBy: { id: "asc" } });
  return rows.map((r: any) => [r.id, r.parentId, r.code]);
};

describe("X1b mechanism 3 — createMany skipDuplicates under a located update target", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.node.create({ data: { id: "c0", code: "c0", name: "c0" } });
    await client.node.create({
      data: { id: "c1", code: "c1", name: "c1", parentId: "c0" },
    });
    // A global row that owns the unique code "taken" — the skip target.
    await client.node.create({ data: { id: "t0", code: "taken", name: "t0" } });
    // Disjoint witness subtree; must stay untouched.
    await client.node.create({ data: { id: "d0", code: "d0", name: "d0" } });
    await client.node.create({
      data: { id: "d1", code: "d1", name: "d1", parentId: "d0" },
    });
  };

  // update(c0) -> children.update(c1) -> children.createMany({..skipDuplicates})
  const op = async (c: Record<string, any>) => {
    await c.node.update({
      where: { id: "c0" },
      data: {
        children: {
          update: {
            where: { id: "c1" },
            data: {
              children: {
                createMany: {
                  data: [
                    { id: "g1", code: "fresh", name: "g1" },
                    { id: "g2", code: "taken", name: "g2" },
                  ],
                  skipDuplicates: true,
                },
              },
            },
          },
        },
      },
    });
  };

  // g1 lands under c1 (its immediate ancestor); g2 skipped (code "taken" collides
  // with t0). The disjoint d-subtree and t0 are untouched.
  const expected = [
    ["c0", null, "c0"],
    ["c1", "c0", "c1"],
    ["d0", null, "d0"],
    ["d1", "d0", "d1"],
    ["g1", "c1", "fresh"],
    ["t0", null, "taken"],
  ];

  for (const substrate of ["tx", "batch"] as const) {
    test(`${substrate}: skip keeps the fresh child under c1, drops the duplicate, native Observed`, async () => {
      const { state, engines } = await runObserved(substrate, seed, op, snap);
      expect(engines).toEqual(new Set(["production"]));
      expect(state).toEqual(expected);
    });
  }
});

describe("X1b mechanism 3 — createMany skipDuplicates under a fresh create at depth", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.node.create({ data: { id: "c0", code: "c0", name: "c0" } });
    await client.node.create({
      data: { id: "c1", code: "c1", name: "c1", parentId: "c0" },
    });
    await client.node.create({ data: { id: "t0", code: "taken", name: "t0" } });
  };

  // update(c0) -> children.update(c1) -> children.create(g1) ->
  //   children.createMany({..skipDuplicates}) : the createMany hangs off a FRESH
  //   create (g1), whose own literal PK is the createMany rows' parent.
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
                  code: "g1",
                  name: "g1",
                  children: {
                    createMany: {
                      data: [
                        { id: "gg1", code: "gg1", name: "gg1" },
                        { id: "gg2", code: "taken", name: "gg2" },
                      ],
                      skipDuplicates: true,
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

  // g1 under c1; gg1 under g1 (its immediate ancestor); gg2 skipped.
  const expected = [
    ["c0", null, "c0"],
    ["c1", "c0", "c1"],
    ["g1", "c1", "g1"],
    ["gg1", "g1", "gg1"],
    ["t0", null, "taken"],
  ];

  for (const substrate of ["tx", "batch"] as const) {
    test(`${substrate}: skip under a fresh create attaches survivors to the fresh child, native Observed`, async () => {
      const { state, engines } = await runObserved(substrate, seed, op, snap);
      expect(engines).toEqual(new Set(["production"]));
      expect(state).toEqual(expected);
    });
  }
});

describe("X1b mechanism 3 — the skip is load-bearing (falsification)", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.node.create({ data: { id: "c0", code: "c0", name: "c0" } });
    await client.node.create({
      data: { id: "c1", code: "c1", name: "c1", parentId: "c0" },
    });
    await client.node.create({ data: { id: "t0", code: "taken", name: "t0" } });
  };

  // The identical depth createMany WITHOUT skipDuplicates: the colliding "taken"
  // row is now a genuine unique violation the whole operation must surface — proof
  // that the composed skip (not a silent drop of every duplicate) is what makes the
  // positive oracle pass. Break the skip composition and the positive test would
  // throw here too.
  const op = async (c: Record<string, any>) => {
    await c.node.update({
      where: { id: "c0" },
      data: {
        children: {
          update: {
            where: { id: "c1" },
            data: {
              children: {
                createMany: {
                  data: [
                    { id: "g1", code: "fresh", name: "g1" },
                    { id: "g2", code: "taken", name: "g2" },
                  ],
                },
              },
            },
          },
        },
      },
    });
  };

  for (const substrate of ["tx", "batch"] as const) {
    test(`${substrate}: without skip, the duplicate is a hard unique violation`, async () => {
      await expect(runObserved(substrate, seed, op, snap)).rejects.toThrow();
    });
  }
});
