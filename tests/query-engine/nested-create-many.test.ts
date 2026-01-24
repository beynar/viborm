/**
 * Nested CreateMany Integration Tests
 *
 * Tests for nested createMany operations within parent create operations.
 * Verifies that FK fields are optional in nested context and properly derived from parent.
 */

import { createClient as PGliteCreateClient } from "@drivers/pglite";
import { push } from "@migrations";
import { s } from "@schema";
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

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.oneToMany(() => post),
});

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    userId: s.string(),
    author: s
      .manyToOne(() => user)
      .fields("userId")
      .references("id"),
  })
  .map("posts");

const schema = { user, post };

// =============================================================================
// TEST SETUP
// =============================================================================

let client: Awaited<
  ReturnType<typeof PGliteCreateClient<{ schema: typeof schema }>>
>;

beforeAll(async () => {
  client = PGliteCreateClient({ schema });
  await push(client, { force: true });
});

afterAll(async () => {
  await client.$disconnect();
});

beforeEach(async () => {
  // Clean up data between tests
  await client.post.deleteMany();
  await client.user.deleteMany();
});

// =============================================================================
// NESTED CREATE MANY TESTS
// =============================================================================

describe("Nested CreateMany", () => {
  describe("basic functionality", () => {
    test("creates parent with nested createMany (FK omitted)", async () => {
      // This is the key test - userId should be optional in nested createMany
      const result = await client.user.create({
        data: {
          id: "user-1",
          name: "John",
          posts: {
            createMany: {
              data: [
                { id: "post-1", title: "First Post" },
                { id: "post-2", title: "Second Post" },
              ],
            },
          },
        },
      });

      expect(result.id).toBe("user-1");
      expect(result.name).toBe("John");

      // Verify posts were created with correct FK
      const posts = await client.post.findMany({
        where: { userId: "user-1" },
        orderBy: { id: "asc" },
      });

      expect(posts.length).toBe(2);
      expect(posts[0]?.title).toBe("First Post");
      expect(posts[0]?.userId).toBe("user-1");
      expect(posts[1]?.title).toBe("Second Post");
      expect(posts[1]?.userId).toBe("user-1");
    });

    test("creates parent with nested createMany (FK explicitly provided)", async () => {
      // FK can also be explicitly provided if desired
      const result = await client.user.create({
        data: {
          id: "user-1",
          name: "John",
          posts: {
            createMany: {
              data: [
                { id: "post-1", title: "First Post", userId: "user-1" },
                { id: "post-2", title: "Second Post", userId: "user-1" },
              ],
            },
          },
        },
      });

      expect(result.id).toBe("user-1");

      const posts = await client.post.findMany({
        where: { userId: "user-1" },
      });

      expect(posts.length).toBe(2);
    });

    test("creates parent with nested createMany and returns with include", async () => {
      const result = await client.user.create({
        data: {
          id: "user-1",
          name: "John",
          posts: {
            createMany: {
              data: [
                { id: "post-1", title: "First Post" },
                { id: "post-2", title: "Second Post" },
              ],
            },
          },
        },
        include: {
          posts: true,
        },
      });

      expect(result.id).toBe("user-1");
      expect(result.posts).toBeInstanceOf(Array);
      expect(result.posts.length).toBe(2);
    });

    test("creates parent with single item in createMany data array", async () => {
      await client.user.create({
        data: {
          id: "user-1",
          name: "John",
          posts: {
            createMany: {
              data: [{ id: "post-1", title: "Only Post" }],
            },
          },
        },
      });

      const posts = await client.post.findMany();
      expect(posts.length).toBe(1);
      expect(posts[0]?.title).toBe("Only Post");
      expect(posts[0]?.userId).toBe("user-1");
    });

    test("creates parent with empty createMany data array", async () => {
      await client.user.create({
        data: {
          id: "user-1",
          name: "John",
          posts: {
            createMany: {
              data: [],
            },
          },
        },
      });

      const user = await client.user.findUnique({ where: { id: "user-1" } });
      expect(user).not.toBeNull();

      const posts = await client.post.findMany();
      expect(posts.length).toBe(0);
    });
  });

  describe("combined with other nested operations", () => {
    test("createMany combined with create", async () => {
      await client.user.create({
        data: {
          id: "user-1",
          name: "John",
          posts: {
            create: { id: "post-single", title: "Single Create" },
            createMany: {
              data: [
                { id: "post-many-1", title: "Many 1" },
                { id: "post-many-2", title: "Many 2" },
              ],
            },
          },
        },
      });

      const posts = await client.post.findMany({
        where: { userId: "user-1" },
        orderBy: { id: "asc" },
      });

      expect(posts.length).toBe(3);
      expect(posts.map((p) => p.id).sort()).toEqual([
        "post-many-1",
        "post-many-2",
        "post-single",
      ]);
    });
  });

  describe("querying created data", () => {
    test("findMany with include returns nested createMany data", async () => {
      await client.user.create({
        data: {
          id: "user-1",
          name: "John",
          posts: {
            createMany: {
              data: [
                { id: "post-1", title: "First Post" },
                { id: "post-2", title: "Second Post" },
              ],
            },
          },
        },
      });

      const users = await client.user.findMany({
        include: { posts: true },
      });

      expect(users.length).toBe(1);
      expect(users[0]?.posts.length).toBe(2);
    });

    test("posts have correct author relation", async () => {
      await client.user.create({
        data: {
          id: "user-1",
          name: "John",
          posts: {
            createMany: {
              data: [{ id: "post-1", title: "First Post" }],
            },
          },
        },
      });

      const post = await client.post.findUnique({
        where: { id: "post-1" },
        include: { author: true },
      });

      expect(post).not.toBeNull();
      expect(post?.author.id).toBe("user-1");
      expect(post?.author.name).toBe("John");
    });
  });

  describe("multiple users with nested createMany", () => {
    test("creates multiple users each with posts", async () => {
      await client.user.create({
        data: {
          id: "user-1",
          name: "John",
          posts: {
            createMany: {
              data: [
                { id: "post-1", title: "John Post 1" },
                { id: "post-2", title: "John Post 2" },
              ],
            },
          },
        },
      });

      await client.user.create({
        data: {
          id: "user-2",
          name: "Jane",
          posts: {
            createMany: {
              data: [
                { id: "post-3", title: "Jane Post 1" },
                { id: "post-4", title: "Jane Post 2" },
                { id: "post-5", title: "Jane Post 3" },
              ],
            },
          },
        },
      });

      const johnPosts = await client.post.findMany({
        where: { userId: "user-1" },
      });
      const janePosts = await client.post.findMany({
        where: { userId: "user-2" },
      });

      expect(johnPosts.length).toBe(2);
      expect(janePosts.length).toBe(3);
    });
  });
});

// =============================================================================
// BASIC QUERY OPERATIONS TESTS
// =============================================================================

describe("Basic Query Operations", () => {
  describe("findMany", () => {
    test("returns empty array when no records exist", async () => {
      const result = await client.user.findMany();
      expect(result).toEqual([]);
    });

    test("returns all records", async () => {
      await client.user.create({
        data: { id: "user-1", name: "John" },
      });
      await client.user.create({
        data: { id: "user-2", name: "Jane" },
      });

      const result = await client.user.findMany();
      expect(result.length).toBe(2);
    });

    test("filters with where clause", async () => {
      await client.user.create({
        data: { id: "user-1", name: "John" },
      });
      await client.user.create({
        data: { id: "user-2", name: "Jane" },
      });

      const result = await client.user.findMany({
        where: { name: "John" },
      });

      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe("John");
    });
  });

  describe("findUnique", () => {
    test("returns null when not found", async () => {
      const result = await client.user.findUnique({
        where: { id: "nonexistent" },
      });
      expect(result).toBeNull();
    });

    test("finds by id", async () => {
      await client.user.create({
        data: { id: "user-1", name: "John" },
      });

      const result = await client.user.findUnique({
        where: { id: "user-1" },
      });

      expect(result).not.toBeNull();
      expect(result?.name).toBe("John");
    });
  });

  describe("findFirst", () => {
    test("returns null when no records exist", async () => {
      const result = await client.user.findFirst();
      expect(result).toBeNull();
    });

    test("returns first record", async () => {
      await client.user.create({
        data: { id: "user-1", name: "John" },
      });

      const result = await client.user.findFirst();
      expect(result).not.toBeNull();
      expect(result?.name).toBe("John");
    });
  });

  describe("create", () => {
    test("creates a record", async () => {
      const result = await client.user.create({
        data: { id: "user-1", name: "John" },
      });

      expect(result.id).toBe("user-1");
      expect(result.name).toBe("John");
    });

    test("creates with nested relation using create", async () => {
      const result = await client.user.create({
        data: {
          id: "user-1",
          name: "John",
          posts: {
            create: { id: "post-1", title: "Hello World" },
          },
        },
        include: { posts: true },
      });

      expect(result.id).toBe("user-1");
      expect(result.posts.length).toBe(1);
      expect(result.posts[0]?.title).toBe("Hello World");
    });
  });

  describe("update", () => {
    test("updates a record", async () => {
      await client.user.create({
        data: { id: "user-1", name: "John" },
      });

      const result = await client.user.update({
        where: { id: "user-1" },
        data: { name: "John Updated" },
      });

      expect(result.name).toBe("John Updated");
    });
  });

  describe("delete", () => {
    test("deletes a record", async () => {
      await client.user.create({
        data: { id: "user-1", name: "John" },
      });

      const result = await client.user.delete({
        where: { id: "user-1" },
      });

      expect(result.id).toBe("user-1");

      const remaining = await client.user.findMany();
      expect(remaining.length).toBe(0);
    });
  });

  describe("upsert", () => {
    test("creates when record does not exist", async () => {
      const result = await client.user.upsert({
        where: { id: "user-1" },
        create: { id: "user-1", name: "John" },
        update: { name: "Updated" },
      });

      expect(result.id).toBe("user-1");
      expect(result.name).toBe("John");
    });

    test("updates when record exists", async () => {
      await client.user.create({
        data: { id: "user-1", name: "John" },
      });

      const result = await client.user.upsert({
        where: { id: "user-1" },
        create: { id: "user-1", name: "New" },
        update: { name: "Updated" },
      });

      expect(result.name).toBe("Updated");
    });
  });

  describe("count", () => {
    test("counts all records", async () => {
      await client.user.create({
        data: { id: "user-1", name: "John" },
      });
      await client.user.create({
        data: { id: "user-2", name: "Jane" },
      });

      const result = await client.user.count();
      expect(result).toBe(2);
    });

    test("counts with where filter", async () => {
      await client.user.create({
        data: { id: "user-1", name: "John" },
      });
      await client.user.create({
        data: { id: "user-2", name: "Jane" },
      });

      const result = await client.user.count({
        where: { name: "John" },
      });
      expect(result).toBe(1);
    });
  });
});

// =============================================================================
// RELATION QUERY TESTS
// =============================================================================

describe("Relation Queries", () => {
  test("includes to-many relation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "John",
        posts: {
          createMany: {
            data: [
              { id: "post-1", title: "Post 1" },
              { id: "post-2", title: "Post 2" },
            ],
          },
        },
      },
    });

    const result = await client.user.findUnique({
      where: { id: "user-1" },
      include: { posts: true },
    });

    expect(result?.posts.length).toBe(2);
  });

  test("includes to-one relation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "John",
        posts: {
          createMany: {
            data: [{ id: "post-1", title: "Post 1" }],
          },
        },
      },
    });

    const result = await client.post.findUnique({
      where: { id: "post-1" },
      include: { author: true },
    });

    expect(result?.author.name).toBe("John");
  });

  test("filters relations in include", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "John",
        posts: {
          createMany: {
            data: [
              { id: "post-1", title: "Alpha" },
              { id: "post-2", title: "Beta" },
            ],
          },
        },
      },
    });

    const result = await client.user.findUnique({
      where: { id: "user-1" },
      include: {
        posts: {
          where: { title: "Alpha" },
        },
      },
    });

    expect(result?.posts.length).toBe(1);
    expect(result?.posts[0]?.title).toBe("Alpha");
  });
});
