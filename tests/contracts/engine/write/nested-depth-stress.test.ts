import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * X1 depth STRESS — the engine's construction-time recursion has no depth
 * constraint. A self-referential tree lets a nested `create` / `update` chain go
 * arbitrarily deep; the same seam builds level N and level N+1, so a chain of 5–12
 * levels folds into a plain step list with no counter and no cliff. (Pre-X1 the
 * child-held create/update chains ALREADY recursed unbounded; X1 added the
 * create-context grandchild arm — a `create` under a located target carrying its
 * own nested creates — so a mixed update→…→create chain is now unbounded too.)
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
    .map("x1ds_node");
  return { node };
})();

function makeClient(db: PGlite) {
  return createClient({
    schema: tree as never,
    driver: new PGliteDriver({ client: db }),
  }) as any;
}

function nestedCreate(depth: number, level = 1): any {
  const data: any = { id: `c${level}`, name: `n${level}` };
  if (level < depth) data.children = { create: nestedCreate(depth, level + 1) };
  return data;
}

function nestedUpdate(depth: number, level = 1): any {
  const data: any = { name: `u${level}` };
  if (level < depth) {
    data.children = {
      update: {
        where: { id: `c${level + 1}` },
        data: nestedUpdate(depth, level + 1),
      },
    };
  }
  return data;
}

async function seedChain(client: any, depth: number) {
  await client.node.create({
    data: { id: "c0", name: "root", children: { create: nestedCreate(depth) } },
  });
}

describe("X1 depth stress — unbounded nested create / update chains", () => {
  for (const depth of [5, 8, 12]) {
    test(`nested create chain of ${depth} levels executes`, async () => {
      const db = new PGlite();
      const client = makeClient(db);
      await push(client, { force: true });
      await seedChain(client, depth);
      const count = await client.node.count();
      await client.$disconnect();
      expect(count).toBe(depth + 1); // c0 + c1..c{depth}
    });

    test(`nested update chain of ${depth} levels executes`, async () => {
      const db = new PGlite();
      const client = makeClient(db);
      await push(client, { force: true });
      await seedChain(client, depth);
      await client.node.update({
        where: { id: "c0" },
        data: {
          children: {
            update: { where: { id: "c1" }, data: nestedUpdate(depth) },
          },
        },
      });
      const renamed = await client.node.count({
        where: { name: { startsWith: "u" } },
      });
      await client.$disconnect();
      expect(renamed).toBe(depth); // c1..c{depth} renamed to u1..u{depth}
    });
  }

  test("mixed update→…→create chain of 6 levels grafts a fresh subtree at the bottom (X1)", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await seedChain(client, 5); // c0..c5 exist
    // Walk update c1→c4, then create a fresh 3-deep chain under c4.
    function walk(level = 1): any {
      const data: any = { name: `w${level}` };
      if (level < 4) {
        data.children = {
          update: { where: { id: `c${level + 1}` }, data: walk(level + 1) },
        };
      } else {
        data.children = { create: nestedCreateFresh(["f1", "f2", "f3"]) };
      }
      return data;
    }
    await client.node.update({
      where: { id: "c0" },
      data: { children: { update: { where: { id: "c1" }, data: walk() } } },
    });
    const fresh = await client.node.findMany({
      where: { id: { in: ["f1", "f2", "f3"] } },
      orderBy: { id: "asc" },
    });
    await client.$disconnect();
    expect(fresh.map((r: any) => [r.id, r.parentId])).toEqual([
      ["f1", "c4"],
      ["f2", "f1"],
      ["f3", "f2"],
    ]);
  });
});

function nestedCreateFresh(ids: readonly string[], index = 0): any {
  const id = ids[index]!;
  const data: any = { id, name: id };
  if (index < ids.length - 1) {
    data.children = { create: nestedCreateFresh(ids, index + 1) };
  }
  return data;
}
