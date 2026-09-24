import { PGliteDriver } from "@drivers/pglite";
import { UniqueConstraintError } from "@errors";
import { s } from "@schema";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { droppedSkipWarning } from "@tests/fixtures/dropped-skip-warning";
import { describe, expect, test, vi } from "vitest";

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
 * FIXED-EXPECTATION oracle (no Direct exists post-P6): the persisted state is pinned on
 * a NATIVE Observed execution (engines === {production}). MULTI-PARENT + WRONG-ROW
 * witness: a disjoint subtree stays untouched, and each inserted child's `parentId` is
 * pinned to its IMMEDIATE ancestor (the located target / the fresh create), never a
 * sibling — the standing falsification for the injected FK.
 *
 * G3P-04: the two substrates do NOT answer the same thing here. Root-conflict
 * suppression is admitted only where the operation owns the member rollback region;
 * the batch route owns none, so there `createMany skipDuplicates` DROPS the skip
 * with one warning (owner decision 2026-09-24, "Warn, drop skipDuplicates"): the
 * colliding row fails with the ordinary unique-constraint error, and the database
 * keeps exactly what the same createMany without skipDuplicates keeps. The batch legs
 * pin that failure, the warning and that equivalence; the tx legs pin the composed
 * skip itself.
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

const getFamily = usePGliteSchemaFamily(tree);

type AnyClient = Record<string, any>;

/**
 * The batch leg, run twice from the same seed: once with the skip (which the
 * batch drops with one warning) and once without it. The caller pins that
 * both fail with the ordinary unique-constraint error and keep the same rows.
 */
async function runDroppedAndPlain(
  seed: (c: AnyClient) => Promise<void>,
  op: (skipDuplicates: boolean) => (c: Record<string, any>) => Promise<void>
) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  let dropped: unknown;
  let warnings: unknown[][];
  try {
    dropped = await runObserved("batch", seed, op(true), snap).catch(
      (error: unknown) => error
    );
    warnings = warn.mock.calls;
  } finally {
    warn.mockRestore();
  }
  const keptDropped = await snap(getFamily().client as AnyClient);
  await getFamily().reset();
  const plain = await runObserved("batch", seed, op(false), snap).catch(
    (error: unknown) => error
  );
  const keptPlain = await snap(getFamily().client as AnyClient);
  return { dropped, warnings, keptDropped, plain, keptPlain };
}

async function runObserved(
  substrate: "tx" | "batch",
  seed: (c: AnyClient) => Promise<void>,
  op: (c: Record<string, any>) => Promise<void>,
  snap: (c: AnyClient) => Promise<unknown>
): Promise<{ state: unknown; engines: Set<"direct" | "production"> }> {
  const family = getFamily();
  const base = family.client as AnyClient;
  await seed(base);
  // The observed client is a SECOND driver over the same database, so it must
  // name the schema the family provisioned; otherwise it would address `public`,
  // where this suite has no tables.
  const namespace = family.driver.adapter.namespace;
  const driver =
    substrate === "tx"
      ? new PGliteDriver({ client: family.database, namespace })
      : new BatchOnlyPGliteDriver({ client: family.database, namespace });
  const observed = observeClientOperations({
    schema: tree as never,
    driver,
  });
  await op(observed.client);
  const state = await snap(base);
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
  const update =
    (skipDuplicates: boolean) => async (c: Record<string, any>) => {
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
                    ...(skipDuplicates ? { skipDuplicates } : {}),
                  },
                },
              },
            },
          },
        },
      });
    };
  const op = update(true);

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

  // What the batch route keeps once the skip is dropped - the same rows the
  // plain createMany keeps: each row under a located target is its own
  // committed member, so g1 stays and the colliding g2 fails.
  const kept = [
    ["c0", null, "c0"],
    ["c1", "c0", "c1"],
    ["d0", null, "d0"],
    ["d1", "d0", "d1"],
    ["g1", "c1", "fresh"],
    ["t0", null, "taken"],
  ];

  test("tx: skip keeps the fresh child under c1, drops the duplicate, native Observed", async () => {
    const { state, engines } = await runObserved("tx", seed, op, snap);
    expect(engines).toEqual(new Set(["production"]));
    expect(state).toEqual(expected);
  });

  // G3P-04: the borrowed member has no operation-owned rollback region here.
  test("batch drops the skip with one warning and keeps what the plain createMany keeps", async () => {
    const outcome = await runDroppedAndPlain(seed, update);
    expect(outcome.dropped).toBeInstanceOf(UniqueConstraintError);
    expect(outcome.warnings).toEqual([
      [droppedSkipWarning("pglite", "node.update")],
    ]);
    expect(outcome.keptDropped).toEqual(kept);
    expect(outcome.plain).toBeInstanceOf(UniqueConstraintError);
    expect(outcome.keptPlain).toEqual(kept);
  });
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
  const update =
    (skipDuplicates: boolean) => async (c: Record<string, any>) => {
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
                        ...(skipDuplicates ? { skipDuplicates } : {}),
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
  const op = update(true);

  // g1 under c1; gg1 under g1 (its immediate ancestor); gg2 skipped.
  const expected = [
    ["c0", null, "c0"],
    ["c1", "c0", "c1"],
    ["g1", "c1", "g1"],
    ["gg1", "g1", "gg1"],
    ["t0", null, "taken"],
  ];

  // What the batch route keeps once the skip is dropped - the same rows the
  // plain createMany keeps: the fresh create g1 and its rows are one atomic
  // batch, so the colliding gg2 rolls g1 back with it.
  const kept = [
    ["c0", null, "c0"],
    ["c1", "c0", "c1"],
    ["t0", null, "taken"],
  ];

  test("tx: skip under a fresh create attaches survivors to the fresh child, native Observed", async () => {
    const { state, engines } = await runObserved("tx", seed, op, snap);
    expect(engines).toEqual(new Set(["production"]));
    expect(state).toEqual(expected);
  });

  // G3P-04: the borrowed member has no operation-owned rollback region here.
  test("batch drops the skip with one warning and keeps what the plain createMany keeps", async () => {
    const outcome = await runDroppedAndPlain(seed, update);
    expect(outcome.dropped).toBeInstanceOf(UniqueConstraintError);
    expect(outcome.warnings).toEqual([
      [droppedSkipWarning("pglite", "node.update")],
    ]);
    expect(outcome.keptDropped).toEqual(kept);
    expect(outcome.plain).toBeInstanceOf(UniqueConstraintError);
    expect(outcome.keptPlain).toEqual(kept);
  });
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
