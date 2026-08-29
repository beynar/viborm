import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";

import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

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
  const db = new PGlite();
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
  return {
    state,
    engines: new Set(observed.operations.map((r) => r.boundary)),
  };
}

// ---------------------------------------------------------------------------
// Adopt-family CONNECT under a fresh create at depth (self-referential tree).
// ---------------------------------------------------------------------------
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
    .map("x1b_adopt_node");
  return { node };
})();

describe("X1b mechanism 4 — connect grandchild under a fresh create (global reparent)", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.node.create({ data: { id: "c0", name: "c0" } });
    await client.node.create({
      data: { id: "c1", name: "c1", parentId: "c0" },
    });
    // A committed row to be adopted, and a disjoint witness.
    await client.node.create({ data: { id: "adopt", name: "adopt" } });
    await client.node.create({ data: { id: "d0", name: "d0" } });
  };

  // update(c0) -> children.update(c1) -> children.create(g1{children:{connect: adopt}}):
  // g1 fresh under c1; g1.children.connect adopts the committed `adopt` row (global
  // reparent, ATOM §4). adopt.parentId must become g1, NOT c1.
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
                  children: { connect: { id: "adopt" } },
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
    return rows.map((r: any) => [r.id, r.parentId]);
  };

  const expected = [
    ["adopt", "g1"], // reparented onto the FRESH child
    ["c0", null],
    ["c1", "c0"],
    ["d0", null], // disjoint witness untouched
    ["g1", "c1"],
  ];

  for (const substrate of ["tx", "batch"] as const) {
    test(`${substrate}: the adoptee is reparented onto the fresh child, native Observed`, async () => {
      const { state, engines } = await runObserved(
        tree,
        substrate,
        seed,
        op,
        snap
      );
      expect(engines).toEqual(new Set(["production"]));
      expect(state).toEqual(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// M2M edge under a fresh create at depth.
// ---------------------------------------------------------------------------
const m2mSchema = (() => {
  const blog = s
    .model({
      id: s.string().id(),
      title: s.string(),
      posts: s.toMany(() => post),
    })
    .map("x1b_m2m_blogs");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      blogId: s.string().nullable(),
      blog: s
        .toOne(() => blog)
        .fields("blogId")
        .references("id"),
      tags: s.toMany(() => tag),
    })
    .map("x1b_m2m_posts");
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("x1b_m2m_tags");
  return { blog, post, tag };
})();

describe("X1b mechanism 4 — M2M edge under a fresh create at depth", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.blog.create({ data: { id: "b1", title: "b1" } });
    await client.tag.create({ data: { id: "t1", name: "t1" } });
    // Disjoint witness: a blog with its own post + tag membership, untouched.
    await client.blog.create({ data: { id: "b2", title: "b2" } });
    await client.tag.create({ data: { id: "t9", name: "t9" } });
    await client.post.create({
      data: {
        id: "p9",
        title: "p9",
        blogId: "b2",
        tags: { connect: { id: "t9" } },
      },
    });
  };

  // update(blog b1) -> posts.create({ tags: { connect: t1, create: t2 } }): a fresh
  // post p1 (blogId injected from b1) with an M2M connect to an existing tag and a
  // create of a new tag, both linked through the junction.
  const op = async (c: Record<string, any>) => {
    await c.blog.update({
      where: { id: "b1" },
      data: {
        posts: {
          create: {
            id: "p1",
            title: "p1",
            tags: {
              connect: { id: "t1" },
              create: { id: "t2", name: "t2" },
            },
          },
        },
      },
    });
  };

  const snap = async (c: AnyClient) => {
    const posts = await (c as any).post.findMany({
      orderBy: { id: "asc" },
      include: { tags: { orderBy: { id: "asc" } } },
    });
    return posts.map((p: any) => [
      p.id,
      p.blogId,
      p.tags.map((t: any) => t.id),
    ]);
  };

  const expected = [
    ["p1", "b1", ["t1", "t2"]], // fresh post linked to the connected + created tags
    ["p9", "b2", ["t9"]], // disjoint witness untouched
  ];

  for (const substrate of ["tx", "batch"] as const) {
    test(`${substrate}: the fresh post's M2M edges are created through the junction, native Observed`, async () => {
      const { state, engines } = await runObserved(
        m2mSchema,
        substrate,
        seed,
        op,
        snap
      );
      expect(engines).toEqual(new Set(["production"]));
      expect(state).toEqual(expected);
    });
  }
});
