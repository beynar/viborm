import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
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
        .manyToOne(() => node)
        .fields("parentId")
        .references("id")
        .optional(),
      children: s.oneToMany(() => node),
    })
    .map("x1ss_node");
  return { node };
})();

// An auto-increment (database-generated) self-ref tree, to witness the
// generated-PK fresh-child narrower boundary.
const genTree = (() => {
  const node = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      parentId: s.int().nullable(),
      parent: s
        .manyToOne(() => node)
        .fields("parentId")
        .references("id")
        .optional(),
      children: s.oneToMany(() => node),
    })
    .map("x1ss_gen");
  return { node };
})();

function makeClient(schema: any, db: PGlite) {
  return createClient({
    schema,
    driver: new PGliteDriver({ client: db }),
  }) as any;
}

async function withClient(schema: any, fn: (c: any) => Promise<void>) {
  const db = new PGlite();
  const client = makeClient(schema, db);
  await push(client, { force: true });
  await fn(client);
  await client.$disconnect();
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
    await withClient(tree, async (c) => {
      const msg = await messageOf(() =>
        c.node.create({ data: { id: "r", name: "r", children: ownWriteLeaf } })
      );
      expect(msg).toContain("Split these operations into separate queries");
      expect(msg).toContain("depends on an earlier 'create' target write");
    });
  });

  test("depth-4 lifted create-context chain rejects with the SAME own-write message", async () => {
    await withClient(tree, async (c) => {
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
    await withClient(tree, async (c) => {
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

describe("X1 create-context narrower boundaries — byte-stable declines", () => {
  test("an adopt-family (connect) grandchild under a fresh create declines", async () => {
    await withClient(tree, async (c) => {
      await c.node.create({ data: { id: "c0", name: "c0" } });
      await c.node.create({ data: { id: "c1", name: "c1", parentId: "c0" } });
      await c.node.create({ data: { id: "adopt", name: "adopt" } });
      const msg = await messageOf(() =>
        c.node.update({
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
                      children: { connect: { id: "adopt" } },
                    },
                  },
                },
              },
            },
          },
        })
      );
      expect(msg).toContain(
        "does not support a nested 'connect' on relation 'children' in the create data of relation 'children' one level deeper"
      );
    });
  });

  test("a database-generated (auto-increment) fresh child carrying its own relations declines", async () => {
    await withClient(genTree, async (c) => {
      await c.node.create({ data: { name: "c0" } }); // id 1
      await c.node.create({ data: { name: "c1", parentId: 1 } }); // id 2
      // update(c0) -> children.update(c1) -> children.create({ name, children:{create} }):
      // the fresh grandchild's PK is DB-generated, so it is not a construction-time
      // literal parent for its own grandchildren — a documented narrower boundary
      // (needs a backward Ref, the root create-tree mechanism), not a depth cap.
      const msg = await messageOf(() =>
        c.node.update({
          where: { id: 1 },
          data: {
            children: {
              update: {
                where: { id: 2 },
                data: {
                  children: {
                    create: {
                      name: "g1",
                      children: { create: { name: "g2" } },
                    },
                  },
                },
              },
            },
          },
        })
      );
      expect(msg).toContain("is database-generated one level deeper");
    });
  });
});
