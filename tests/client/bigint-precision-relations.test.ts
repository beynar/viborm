/**
 * BigInt Precision in Relations Test
 *
 * This test verifies that BigInt values preserve their full precision
 * when fetched through relations using JSON aggregation.
 *
 * The issue: When using include/select on relations, the ORM uses database
 * JSON functions (json_agg, JSON_ARRAYAGG, json_group_array) to aggregate
 * related data. BigInt values in JSON lose precision because JSON numbers
 * are limited to Number.MAX_SAFE_INTEGER (2^53 - 1).
 *
 * The fix: Cast BigInt fields to TEXT in SQL before JSON aggregation,
 * then convert back to BigInt during result parsing.
 */

import { createClient as PGliteCreateClient } from "@drivers/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// =============================================================================
// TEST CONSTANTS
// =============================================================================

// Values that WILL lose precision without the fix
const LARGE_BIGINT_1 = 9007199254740993n; // MAX_SAFE_INTEGER + 2
const LARGE_BIGINT_2 = 9223372036854775807n; // Max signed 64-bit integer
const LARGE_BIGINT_3 = 1234567890123456789n; // Random large value
const LARGE_BIGINT_NEGATIVE = -9007199254740993n; // Negative large value

// Value that fits in safe range (control)
const SAFE_BIGINT = 9007199254740991n; // MAX_SAFE_INTEGER

// =============================================================================
// MODEL DEFINITIONS
// =============================================================================

const author = s.model({
  id: s.string().id(),
  name: s.string(),
  // BigInt fields that will be fetched through relations
  followerCount: s.bigInt(),
  totalViews: s.bigInt().nullable(),
  posts: s.oneToMany(() => post),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  // BigInt field on the child model
  viewCount: s.bigInt(),
  likeCount: s.bigInt().nullable(),
  // Foreign key
  authorId: s.string(),
  author: s
    .manyToOne(() => author)
    .fields("authorId")
    .references("id"),
});

const schema = { author, post };

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
  await push(client, { force: true });
});

afterAll(async () => {
  await client.$disconnect();
});

// =============================================================================
// BIGINT PRECISION TESTS
// =============================================================================

describe("BigInt Precision in Relations", () => {
  test("setup: create test data with large BigInt values", async () => {
    // Create author with large BigInt values
    await client.author.create({
      data: {
        id: "author-1",
        name: "Popular Author",
        followerCount: LARGE_BIGINT_1,
        totalViews: LARGE_BIGINT_2,
      },
    });

    await client.author.create({
      data: {
        id: "author-2",
        name: "Another Author",
        followerCount: SAFE_BIGINT,
        totalViews: null,
      },
    });

    // Create posts with large BigInt values
    await client.post.create({
      data: {
        id: "post-1",
        title: "Viral Post",
        viewCount: LARGE_BIGINT_3,
        likeCount: LARGE_BIGINT_NEGATIVE,
        authorId: "author-1",
      },
    });

    await client.post.create({
      data: {
        id: "post-2",
        title: "Another Post",
        viewCount: LARGE_BIGINT_1,
        likeCount: SAFE_BIGINT,
        authorId: "author-1",
      },
    });
  });

  test("oneToMany: BigInt precision preserved when fetching children", async () => {
    const authorWithPosts = await client.author.findUnique({
      where: { id: "author-1" },
      include: { posts: true },
    });

    expect(authorWithPosts).not.toBeNull();
    if (!authorWithPosts) throw new Error("Author not found");

    // Verify children BigInt values have exact precision
    expect(authorWithPosts.posts.length).toBe(2);

    const post1 = authorWithPosts.posts.find((p) => p.id === "post-1")!;
    const post2 = authorWithPosts.posts.find((p) => p.id === "post-2")!;

    // These assertions would FAIL without the fix
    expect(post1.viewCount).toBe(LARGE_BIGINT_3);
    expect(post1.likeCount).toBe(LARGE_BIGINT_NEGATIVE);
    expect(post2.viewCount).toBe(LARGE_BIGINT_1);
    expect(post2.likeCount).toBe(SAFE_BIGINT);

    // Verify they are actual BigInt type
    expect(typeof post1.viewCount).toBe("bigint");
    expect(typeof post1.likeCount).toBe("bigint");
    expect(typeof post2.viewCount).toBe("bigint");
    expect(typeof post2.likeCount).toBe("bigint");
  });

  test("manyToOne: BigInt precision preserved when fetching parent", async () => {
    const postWithAuthor = await client.post.findUnique({
      where: { id: "post-1" },
      include: { author: true },
    });

    expect(postWithAuthor).not.toBeNull();
    if (!postWithAuthor) throw new Error("Post not found");

    // Verify parent BigInt values have exact precision
    // These assertions would FAIL without the fix
    expect(postWithAuthor.author.followerCount).toBe(LARGE_BIGINT_1);
    expect(postWithAuthor.author.totalViews).toBe(LARGE_BIGINT_2);

    // Verify they are actual BigInt type
    expect(typeof postWithAuthor.author.followerCount).toBe("bigint");
    expect(typeof postWithAuthor.author.totalViews).toBe("bigint");
  });

  test("nested relations: BigInt precision preserved through multiple levels", async () => {
    const authorWithPosts = await client.author.findUnique({
      where: { id: "author-1" },
      include: {
        posts: {
          include: { author: true },
        },
      },
    });

    expect(authorWithPosts).not.toBeNull();
    if (!authorWithPosts) throw new Error("Author not found");

    // First level: author BigInt
    expect(authorWithPosts.followerCount).toBe(LARGE_BIGINT_1);
    expect(typeof authorWithPosts.followerCount).toBe("bigint");

    // Second level: posts BigInt
    const post1 = authorWithPosts.posts.find((p) => p.id === "post-1")!;
    expect(post1.viewCount).toBe(LARGE_BIGINT_3);
    expect(typeof post1.viewCount).toBe("bigint");

    // Third level: nested author BigInt (back reference)
    expect(post1.author.followerCount).toBe(LARGE_BIGINT_1);
    expect(typeof post1.author.followerCount).toBe("bigint");
  });

  test("findMany with include: BigInt precision preserved across multiple results", async () => {
    const allPosts = await client.post.findMany({
      include: { author: true },
    });

    expect(allPosts.length).toBe(2);

    for (const post of allPosts) {
      // Post BigInt values
      expect(typeof post.viewCount).toBe("bigint");

      // Author BigInt values through relation
      expect(typeof post.author.followerCount).toBe("bigint");
    }

    // Verify specific values
    const post1 = allPosts.find((p) => p.id === "post-1")!;
    expect(post1.viewCount).toBe(LARGE_BIGINT_3);
    expect(post1.author.followerCount).toBe(LARGE_BIGINT_1);
  });

  test("select with include: BigInt precision preserved with field selection", async () => {
    const result = await client.author.findUnique({
      where: { id: "author-1" },
      select: {
        id: true,
        followerCount: true,
        posts: {
          select: {
            id: true,
            viewCount: true,
          },
        },
      },
    });

    expect(result).not.toBeNull();
    if (!result) throw new Error("Result not found");

    // Parent BigInt with select
    expect(result.followerCount).toBe(LARGE_BIGINT_1);
    expect(typeof result.followerCount).toBe("bigint");

    // Children BigInt with nested select
    const post1 = result.posts.find((p) => p.id === "post-1")!;
    expect(post1.viewCount).toBe(LARGE_BIGINT_3);
    expect(typeof post1.viewCount).toBe("bigint");
  });

  test("nullable BigInt: null values handled correctly in relations", async () => {
    const authorWithNullBigInt = await client.author.findUnique({
      where: { id: "author-2" },
    });

    expect(authorWithNullBigInt).not.toBeNull();
    if (!authorWithNullBigInt) throw new Error("Author not found");

    // Nullable BigInt that is null
    expect(authorWithNullBigInt.totalViews).toBeNull();

    // Verify through relation too
    const postWithAuthor = await client.post.findUnique({
      where: { id: "post-1" },
      include: { author: true },
    });

    expect(postWithAuthor?.author.totalViews).toBe(LARGE_BIGINT_2);
  });

  test("edge case: MAX_SAFE_INTEGER boundary values", async () => {
    // Create test data at the boundary
    await client.author.create({
      data: {
        id: "author-boundary",
        name: "Boundary Test",
        followerCount: BigInt(Number.MAX_SAFE_INTEGER), // Exactly MAX_SAFE_INTEGER
        totalViews: BigInt(Number.MAX_SAFE_INTEGER) + 1n, // Just over MAX_SAFE_INTEGER
      },
    });

    await client.post.create({
      data: {
        id: "post-boundary",
        title: "Boundary Post",
        viewCount: BigInt(Number.MAX_SAFE_INTEGER) + 2n,
        authorId: "author-boundary",
      },
    });

    const result = await client.post.findUnique({
      where: { id: "post-boundary" },
      include: { author: true },
    });

    expect(result).not.toBeNull();
    if (!result) throw new Error("Result not found");

    // These would be corrupted without the fix
    expect(result.viewCount).toBe(BigInt(Number.MAX_SAFE_INTEGER) + 2n);
    expect(result.author.followerCount).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect(result.author.totalViews).toBe(BigInt(Number.MAX_SAFE_INTEGER) + 1n);

    // Verify exact numeric equality (this catches precision loss)
    expect(result.viewCount === BigInt(Number.MAX_SAFE_INTEGER) + 2n).toBe(
      true
    );
    expect(
      result.author.totalViews === BigInt(Number.MAX_SAFE_INTEGER) + 1n
    ).toBe(true);
  });
});
