/**
 * What the shared contracts cannot state in SurrealQL's terms: keys and relations
 * under mapped names, a key compared with a plain column, and how deep a read may
 * nest before the server's parser refuses it. Gated on SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const post = s
  .model({
    id: s.string().id().map("post_pk"),
    slug: s.string().map("post_slug"),
    parentId: s.string().nullable().map("parent_fk"),
    parent: s
      .toOne(() => post)
      .name("thread")
      .fields("parentId")
      .references("id")
      .onDelete("setNull"),
    replies: s.toMany(() => post).name("thread"),
    tags: s
      .toMany(() => tag)
      .through("mapped_post_tags")
      .source("postId")
      .target("tagId"),
  })
  .map("mapped_posts");
const tag = s
  .model({
    id: s.string().id().map("tag_pk"),
    name: s.string().map("tag_name"),
    posts: s.toMany(() => post),
  })
  .map("mapped_tags");

describe.skipIf(!surrealUrl)("SurrealDB keys under mapped names", () => {
  const db: any = createClient({
    schema: { post, tag },
    driver: createSurrealTestDriver(),
  });

  beforeAll(async () => {
    await syncLiveSchema(db);
    await db.tag.create({ data: { id: "t1", name: "orm" } });
    await db.post.create({
      data: { id: "p1", slug: "p1", tags: { connect: { id: "t1" } } },
    });
    await db.post.create({ data: { id: "p2", slug: "other" } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("an include reads through a named junction", async () => {
    const rows = await db.post.findMany({
      orderBy: { id: "asc" },
      include: { tags: true },
    });
    expect(rows.map((row: { tags: unknown[] }) => row.tags)).toEqual([
      [{ id: "t1", name: "orm" }],
      [],
    ]);
  });

  it("a relation filter reads it, from both sides", async () => {
    const posts = await db.post.findMany({
      where: { tags: { some: { name: "orm" } } },
    });
    expect(posts.map((row: { id: string }) => row.id)).toEqual(["p1"]);
    const tags = await db.tag.findMany({
      where: { posts: { every: { slug: "p1" } } },
    });
    expect(tags.map((row: { id: string }) => row.id)).toEqual(["t1"]);
  });

  it("a key compared with a plain column reads the key's text", async () => {
    const rows = await db.post.findMany({
      where: {
        id: { equals: (ctx: { fields: { slug: unknown } }) => ctx.fields.slug },
      },
      select: { id: true },
    });
    expect(rows).toEqual([{ id: "p1" }]);
    const other = await db.post.findMany({
      where: {
        slug: { equals: (ctx: { fields: { id: unknown } }) => ctx.fields.id },
      },
      select: { id: true },
    });
    expect(other).toEqual([{ id: "p1" }]);
  });

  it("a key changed under a nested write moves its record and its links", async () => {
    await db.tag.create({
      data: { id: "t2", name: "moved", posts: { connect: { id: "p2" } } },
    });
    await db.post.update({
      where: { id: "p2" },
      data: { tags: { update: { where: { id: "t2" }, data: { id: "t3" } } } },
    });
    const read = await db.post.findUnique({
      where: { id: "p2" },
      select: { tags: { select: { id: true } } },
    });
    expect(read.tags).toEqual([{ id: "t3" }]);
    expect(await db.tag.findUnique({ where: { id: "t2" } })).toBeNull();
  });

  it.each([
    2, 4, 6, 8, 10, 14,
  ])("a read nesting %i levels of to-many parses", async (depth) => {
    let select: Record<string, unknown> = { id: true };
    for (let level = 0; level < depth; level += 1)
      select = {
        id: true,
        replies: { where: { slug: { not: "x" } }, select },
      };
    await expect(
      db.post.findFirst({ where: { id: "p1" }, select })
    ).resolves.toMatchObject({ id: "p1" });
  });

  it.each([
    1, 3, 5, 6, 7, 8, 10, 14,
  ])("a filter nesting %i levels of to-many parses", async (depth) => {
    let where: Record<string, unknown> = { slug: "never" };
    for (let level = 0; level < depth; level += 1)
      where = { replies: { some: where } };
    await expect(db.post.findMany({ where })).resolves.toEqual([]);
  });
});
