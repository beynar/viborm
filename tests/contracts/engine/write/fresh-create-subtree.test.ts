import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";

import { s } from "@schema";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import {
  closeTestPGlite,
  openTestPGlite as openBorrowedPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

type Schema = Record<string, ReturnType<typeof s.model>>;

function makeClient(schema: Schema, db: PGlite) {
  return createClient({
    schema: schema as never,
    driver: new PGliteDriver({ client: db }),
  });
}
type AnyClient = ReturnType<typeof makeClient>;

async function runObserved(
  schema: Schema,
  substrate: "tx" | "batch",
  seed: (c: AnyClient) => Promise<void>,
  op: (c: Record<string, any>) => Promise<void>,
  snap: (c: AnyClient) => Promise<unknown>
): Promise<{ state: unknown; engines: Set<"direct" | "production"> }> {
  const db = openBorrowedPGlite();
  const base = makeClient(schema, db);
  await syncLiveSchema(base as never);
  await seed(base);
  const driver =
    substrate === "tx"
      ? new PGliteDriver({ client: db })
      : new BatchOnlyPGliteDriver({ client: db });
  const observed = observeClientOperations({
    schema: schema as never,
    driver,
  });
  await op(observed.client);
  const state = await snap(base);
  await base.$disconnect();
  await closeTestPGlite(db);
  return {
    state,
    engines: new Set(observed.operations.map((r) => r.boundary)),
  };
}

// ---------------------------------------------------------------------------
// MECHANISM 2 — a database-generated (auto-increment) fresh child at depth.
// ---------------------------------------------------------------------------
const genTree = (() => {
  const node = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      parentId: s.int().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
    })
    .map("x1b_gen_node");
  return { node };
})();

describe("X1b mechanism 2 — generated-PK fresh child carries its own grandchildren", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.node.create({ data: { name: "c0" } }); // id 1
    await client.node.create({ data: { name: "c1", parentId: 1 } }); // id 2
    await client.node.create({ data: { name: "d0" } }); // id 3 (disjoint witness)
  };

  // update(c0) -> children.update(c1) -> children.create(g1{children:{create:g2}}):
  // g1's PK is DB-generated (id 4); g2's FK must REF g1's produced id (4), not c1 (2).
  const op = async (c: Record<string, any>) => {
    await c.node.update({
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
    });
  };

  const snap = async (c: AnyClient) => {
    const rows = await (c as any).node.findMany({ orderBy: { id: "asc" } });
    return rows.map((r: any) => [r.id, r.parentId, r.name]);
  };

  // g1 (id 4) under c1 (2); g2 (id 5) under g1's PRODUCED id (4). d0 untouched.
  const expected = [
    [1, null, "c0"],
    [2, 1, "c1"],
    [3, null, "d0"],
    [4, 2, "g1"],
    [5, 4, "g2"],
  ];

  test("tx: the produced id threads to the grandchild (backward Ref), native Observed", async () => {
    const { state, engines } = await runObserved(genTree, "tx", seed, op, snap);
    expect(engines).toEqual(new Set(["production"]));
    expect(state).toEqual(expected);
  });

  test("batch: the produced id threads to the grandchild", async () => {
    const { state, engines } = await runObserved(
      genTree,
      "batch",
      seed,
      op,
      snap
    );
    expect(engines).toEqual(new Set(["production"]));
    expect(state).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// MECHANISM 1 (fresh projection) — a parent-held-FK to-one grandchild that must be
// created BEFORE the fresh child, its (generated) id folded into the fresh child's
// own FK column. The T1 before-parent pattern, one level deep under a located target.
// ---------------------------------------------------------------------------
const blogSchema = (() => {
  const blog = s
    .model({
      id: s.string().id(),
      title: s.string(),
      posts: s.toMany(() => post),
    })
    .map("x1b_blogs");
  const author = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("x1b_authors");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      blogId: s.string().nullable(),
      blog: s
        .toOne(() => blog)
        .fields("blogId")
        .references("id"),
      authorId: s.int().nullable(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map("x1b_posts");
  return { blog, author, post };
})();

describe("X1b mechanism 1 (fresh) — a parent-held to-one grandchild of a fresh create", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.blog.create({ data: { id: "b1", title: "b1" } });
    await client.blog.create({ data: { id: "b2", title: "b2" } });
    await client.author.create({ data: { name: "existing" } }); // id 1
    // Disjoint witness post under b2 with the existing author — must stay untouched.
    await client.post.create({
      data: { id: "p9", title: "p9", blogId: "b2", authorId: 1 },
    });
  };

  // update(blog b1) -> posts.create({ author: { create } }): the fresh post's blogId
  // is injected from b1; its authorId comes from a BEFORE-PARENT create of the author
  // (id 2, generated), folded into the post INSERT as a backward Ref.
  const op = async (c: Record<string, any>) => {
    await c.blog.update({
      where: { id: "b1" },
      data: {
        posts: {
          create: {
            id: "p1",
            title: "p1",
            author: { create: { name: "fresh-author" } },
          },
        },
      },
    });
  };

  const snap = async (c: AnyClient) => {
    const posts = await (c as any).post.findMany({ orderBy: { id: "asc" } });
    const authors = await (c as any).author.findMany({
      orderBy: { id: "asc" },
    });
    return {
      posts: posts.map((p: any) => [p.id, p.blogId, p.authorId]),
      authors: authors.map((a: any) => [a.id, a.name]),
    };
  };

  // p1 under b1 (injected) with authorId 2 (the fresh before-parent author). p9 untouched.
  const expected = {
    posts: [
      ["p1", "b1", 2],
      ["p9", "b2", 1],
    ],
    authors: [
      [1, "existing"],
      [2, "fresh-author"],
    ],
  };

  test("tx: the before-parent author id folds into the fresh post's FK, native Observed", async () => {
    const { state, engines } = await runObserved(
      blogSchema,
      "tx",
      seed,
      op,
      snap
    );
    expect(engines).toEqual(new Set(["production"]));
    expect(state).toEqual(expected);
  });

  test("batch: the generated author identity folds into the fresh post", async () => {
    const { state, engines } = await runObserved(
      blogSchema,
      "batch",
      seed,
      op,
      snap
    );
    expect(engines).toEqual(new Set(["production"]));
    expect(state).toEqual(expected);
  });
});
