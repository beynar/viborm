import { UniqueConstraintError } from "@errors";
import { s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * X1 semantic-stability witnesses. THE DEPTH LIFT lifts DEPTH-ONLY refusals; what a
 * payload MEANS must not depend on how deep it sits. These witnesses embed one shape
 * at depth 1 and the same shape at the bottom of a lifted create-context chain, and
 * assert both answer IDENTICALLY.
 *
 * D-51 changed one of the two answers, not the charter. The own-write pair below
 * (`create` + `connectOrCreate` naming one key on one to-many relation) used to be
 * vetoed before execution by the retired design's uniform own-write preflight
 * (`engine-unification/DESIGN.md:876-921`), which D-51 reverses by name: any nesting
 * of nested writes EXECUTES. The relation body runs its canonical verb order —
 * `connectOrCreate` before `create` — so `connectOrCreate` finds no `z1`, creates it,
 * and the later `create` of the same key collides. The answer is now the database's
 * own integrity fact, and integrity facts are the operation's failure with nothing
 * committed. Validation, the other witness here, still answers before execution.
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
    .map("x1ss_node");
  return { node };
})();

const getTreeFamily = usePGliteSchemaFamily(tree);

async function withClient(fn: (c: any) => Promise<void>) {
  await fn(getTreeFamily().client);
}

async function failureOf(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection, got success");
}

async function messageOf(fn: () => Promise<unknown>): Promise<string> {
  return ((await failureOf(fn)) as Error).message;
}

// A create-context chain that BOTTOMS OUT in an arbitrary leaf payload on `children`.
function chainInto(ids: readonly string[], leaf: any, index = 0): any {
  const id = ids[index]!;
  const data: any = { id, name: id };
  if (index < ids.length - 1) {
    data.children = { create: chainInto(ids, leaf, index + 1) };
  } else {
    data.children = leaf;
  }
  return data;
}

describe("X1 semantic stability — the own-write pair at depth", () => {
  // A create + connectOrCreate for the SAME key on one to-many relation. The
  // retired design vetoed this before execution as an own-write dependency; D-51
  // reverses that veto by name, so it now EXECUTES in the relation body's canonical
  // verb order — `connectOrCreate` (which finds no `z1` and creates it) before
  // `create` (which collides on the primary key). Answered at depth-1; must be
  // answered the same way, by the same fact, at depth.
  const ownWriteLeaf = {
    create: { id: "z1", name: "z1" },
    connectOrCreate: {
      where: { id: "z1" },
      create: { id: "z1", name: "z1" },
    },
  };

  /** The one answer both depths must give, spelled from the failure itself. */
  function violation(failure: unknown): Record<string, unknown> {
    if (!(failure instanceof UniqueConstraintError))
      throw new Error(
        `Expected a UniqueConstraintError, received ${String(failure)}`
      );
    const { message } = failure;
    const { table, constraint } = failure.meta;
    return { constraint, message, table };
  }

  const THE_COLLISION = {
    constraint: "x1ss_node_pkey",
    message: "Unique constraint violation",
    table: "x1ss_node",
  };

  // D-51: pinned the retired own-write veto ("Split these operations into separate
  // queries" / "depends on an earlier 'create' target write"); the pair now executes
  // and the collision the execution reaches is the answer.
  test("depth-1 root create rejects with the collision the execution reaches", async () => {
    await withClient(async (c) => {
      expect(
        violation(
          await failureOf(() =>
            c.node.create({
              data: { id: "r", name: "r", children: ownWriteLeaf },
            })
          )
        )
      ).toEqual(THE_COLLISION);
      // Nothing commits: neither the root nor the leaf the connectOrCreate made.
      await expect(
        c.node.findMany({ where: { id: { in: ["r", "z1"] } } })
      ).resolves.toEqual([]);
    });
  });

  // D-51: same former veto, same new answer — that identity is this file's charter.
  test("depth-4 lifted create-context chain rejects with the SAME violation", async () => {
    await withClient(async (c) => {
      await c.node.create({ data: { id: "c0", name: "c0" } });
      await c.node.create({ data: { id: "c1", name: "c1", parentId: "c0" } });
      const depth4 = violation(
        await failureOf(() =>
          c.node.update({
            where: { id: "c0" },
            data: {
              children: {
                update: {
                  where: { id: "c1" },
                  data: {
                    children: {
                      create: chainInto(["g1", "g2", "g3"], ownWriteLeaf),
                    },
                  },
                },
              },
            },
          })
        )
      );
      // The SAME answer as depth-1, spelled from the same three values, and the
      // whole lifted chain rolled back with it.
      const depth1 = violation(
        await failureOf(() =>
          c.node.create({
            data: { id: "r", name: "r", children: ownWriteLeaf },
          })
        )
      );
      expect(depth4).toEqual(THE_COLLISION);
      expect(depth4).toEqual(depth1);
      await expect(
        c.node.findMany({
          orderBy: { id: "asc" },
          where: { id: { in: ["g1", "g2", "g3", "z1", "r"] } },
        })
      ).resolves.toEqual([]);
    });
  });
});

describe("X1 semantic stability — validation error at depth", () => {
  test("an unknown nested key rejects at depth-1 and depth-4 alike", async () => {
    await withClient(async (c) => {
      const d1 = await messageOf(() =>
        c.node.create({
          data: {
            id: "r",
            name: "r",
            children: { create: { id: "x", name: "x", bogus: 1 } },
          },
        })
      );
      expect(d1).toContain("Validation failed");

      await c.node.create({ data: { id: "c0", name: "c0" } });
      await c.node.create({ data: { id: "c1", name: "c1", parentId: "c0" } });
      const d4 = await messageOf(() =>
        c.node.update({
          where: { id: "c0" },
          data: {
            children: {
              update: {
                where: { id: "c1" },
                data: {
                  children: {
                    create: chainInto(["g1", "g2", "g3"], {
                      create: { id: "x", name: "x", bogus: 1 },
                    }),
                  },
                },
              },
            },
          },
        })
      );
      expect(d4).toContain("Validation failed");
    });
  });
});

// AUTHORIZED RETARGET (X1b — the depth lift finished). The two shapes this block
// pinned as "byte-stable declines" — an adopt-family (connect) grandchild under a
// fresh create, and a database-generated fresh child carrying its own relations —
// were CAPABILITY boundaries (a distinct dataflow the fresh-parent leaf did not
// carry), NOT semantic refusals. X1b lifts them by delegating a relation-carrying
// fresh create at depth to the create-ROOT machinery (mechanisms 1, 2, 4), so they
// now EXECUTE natively at any depth. Their positive fixed-expectation oracles (with
// multi-parent + wrong-row witnesses) live in `fresh-create-subtree.test.ts`.
// The own-write pair above is no longer a refusal at all (D-51), and validation still
// answers before execution: both give the SAME answer at depth-1 and at depth-4, which
// is what this file's charter has always been about.
//
