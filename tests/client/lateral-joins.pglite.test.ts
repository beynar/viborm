/**
 * Lateral Joins - PGlite Execution Tests
 *
 * These tests execute real queries against in-memory PGlite to ensure:
 * - Deep nested includes generate VALID SQL (no missing aliases)
 * - Many-to-many includes work with the LATERAL strategy
 * - findUnique attaches required joins (same as findMany/findFirst)
 */

import { createClient as PGliteCreateClient } from "@drivers/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { sql } from "@sql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

// =============================================================================
// TEST SCHEMA
// =============================================================================

const Author = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.oneToMany(() => Post),
  })
  .map("lj_authors");

const Post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .manyToOne(() => Author)
      .fields("authorId")
      .references("id"),
    comments: s.oneToMany(() => Comment),
    tags: s
      .manyToMany(() => Tag)
      .through("lj_post_tag")
      .A("postId")
      .B("tagId"),
  })
  .map("lj_posts");

const Comment = s
  .model({
    id: s.string().id(),
    text: s.string(),
    postId: s.string(),
    post: s
      .manyToOne(() => Post)
      .fields("postId")
      .references("id"),
  })
  .map("lj_comments");

const Tag = s
  .model({
    id: s.string().id(),
    name: s.string().unique(),
    posts: s
      .manyToMany(() => Post)
      .through("lj_post_tag")
      .A("tagId")
      .B("postId"),
  })
  .map("lj_tags");

const schema = {
  author: Author,
  post: Post,
  comment: Comment,
  tag: Tag,
};

// =============================================================================
// TEST SETUP
// =============================================================================

let client: Awaited<
  ReturnType<typeof PGliteCreateClient<{ schema: typeof schema }>>
>;

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = new PGlite();
  client = await PGliteCreateClient({ schema, client: pglite });
  // Migration now automatically creates junction tables for many-to-many relations
  await push(client.$driver, schema, { force: true });
});

afterAll(async () => {
  await client.$disconnect();
});

beforeEach(async () => {
  // Clean up data between tests (junction table first)
  await client.$executeRaw(sql`DELETE FROM "lj_post_tag"`);
  await client.comment.deleteMany();
  await client.post.deleteMany();
  await client.tag.deleteMany();
  await client.author.deleteMany();
});

async function seedBasicGraph() {
  const author = await client.author.create({
    data: { id: "a1", name: "Alice" },
  });

  const post1 = await client.post.create({
    data: { id: "p1", title: "Post 1", authorId: author.id },
  });
  const post2 = await client.post.create({
    data: { id: "p2", title: "Post 2", authorId: author.id },
  });

  await client.comment.create({
    data: { id: "c1", text: "Comment 1", postId: post1.id },
  });
  await client.comment.create({
    data: { id: "c2", text: "Comment 2", postId: post1.id },
  });

  const tag1 = await client.tag.create({ data: { id: "t1", name: "tag-1" } });
  const tag2 = await client.tag.create({ data: { id: "t2", name: "tag-2" } });

  // Attach tags to post1 via junction table
  await client.$executeRaw(
    sql`INSERT INTO "lj_post_tag" ("postId", "tagId") VALUES (${post1.id}, ${tag1.id})`
  );
  await client.$executeRaw(
    sql`INSERT INTO "lj_post_tag" ("postId", "tagId") VALUES (${post1.id}, ${tag2.id})`
  );

  return { author, post1, post2, tag1, tag2 };
}

// =============================================================================
// TESTS
// =============================================================================

describe("Lateral Joins - PGlite execution", () => {
  test("findMany executes deep nested includes (author -> posts -> comments)", async () => {
    const { author } = await seedBasicGraph();

    const result = await client.author.findMany({
      where: { id: author.id },
      include: {
        posts: {
          include: {
            comments: true,
          },
        },
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.posts).toHaveLength(2);

    const p1 = result[0]!.posts.find((p) => p.id === "p1")!;
    expect(p1.comments).toHaveLength(2);
    expect(p1.comments[0]).toHaveProperty("id");
    expect(p1.comments[0]).toHaveProperty("text");
  });

  test("findUnique executes deep include (joins attached)", async () => {
    const { author } = await seedBasicGraph();

    const result = await client.author.findUnique({
      where: { id: author.id },
      include: {
        posts: {
          include: {
            comments: true,
          },
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result!.posts).toHaveLength(2);
  });

  test("findMany executes nested many-to-many include (author -> posts -> tags)", async () => {
    const { author } = await seedBasicGraph();

    const result = await client.author.findMany({
      where: { id: author.id },
      include: {
        posts: {
          include: {
            tags: true,
          },
        },
      },
    });

    expect(result).toHaveLength(1);
    const p1 = result[0]!.posts.find((p) => p.id === "p1")!;
    expect(p1.tags).toHaveLength(2);
    expect(p1.tags.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });

  test("findMany executes top-level many-to-many include (post -> tags)", async () => {
    await seedBasicGraph();

    const result = await client.post.findMany({
      where: { id: "p1" },
      include: { tags: true },
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.tags).toHaveLength(2);
  });
});
