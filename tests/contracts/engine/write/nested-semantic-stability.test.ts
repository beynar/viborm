import { s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * X1 semantic-stability witnesses. THE DEPTH LIFT lifts DEPTH-ONLY refusals; a
 * SEMANTIC refusal (own-write independence, validation, and the new create-context
 * narrower boundaries) must fire byte-IDENTICALLY at every depth. The own-write
 * preflight and validation run on the whole payload TREE before any Part is built
 * (UpdateOperation runs `OwnWritePreflight.assertUpdate` before `interpretRelation`),
 * so lifting the create leaf cannot let an illegal interplay through at depth. These
 * witnesses embed a depth-1-illegal shape deep inside a lifted create-context chain
 * and assert the SAME typed message a depth-1 shape produces.
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

async function messageOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a rejection, got success");
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

describe("X1 semantic stability — own-write 'split these operations' at depth", () => {
  // A create + connectOrCreate for the SAME key on one to-many relation is an
  // own-write dependency (the connectOrCreate's decision read overlaps the create's
  // target write). Illegal at depth-1; must stay illegal, same message, at depth.
  const ownWriteLeaf = {
    create: { id: "z1", name: "z1" },
    connectOrCreate: {
      where: { id: "z1" },
      create: { id: "z1", name: "z1" },
    },
  };

  test("depth-1 root create rejects with the own-write message", async () => {
    await withClient(async (c) => {
      const msg = await messageOf(() =>
        c.node.create({ data: { id: "r", name: "r", children: ownWriteLeaf } })
      );
      expect(msg).toContain("Split these operations into separate queries");
      expect(msg).toContain("depends on an earlier 'create' target write");
    });
  });

  test("depth-4 lifted create-context chain rejects with the SAME own-write message", async () => {
    await withClient(async (c) => {
      await c.node.create({ data: { id: "c0", name: "c0" } });
      await c.node.create({ data: { id: "c1", name: "c1", parentId: "c0" } });
      const msg = await messageOf(() =>
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
      );
      expect(msg).toContain("Split these operations into separate queries");
      expect(msg).toContain("depends on an earlier 'create' target write");
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
// The SEMANTIC refusals above (own-write "Split these operations", validation) are
// unchanged and still fire byte-identically at depth — that is this file's charter.
//
