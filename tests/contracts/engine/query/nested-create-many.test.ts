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
  posts: s.toMany(() => post),
});

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    userId: s.string(),
    author: s
      .toOne(() => user)
      .fields("userId")
      .references("id"),
    comments: s.toMany(() => comment),
  })
  .map("posts");

const comment = s
  .model({
    id: s.string().id(),
    body: s.string(),
    postId: s.string(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
  })
  .map("nested_create_many_comments");

const incrementParent = s
  .model({
    id: s.int().id().increment(),
    name: s.string(),
    children: s.toMany(() => incrementChild),
  })
  .map("nested_increment_parents");

const incrementChild = s
  .model({
    id: s.int().id().increment(),
    label: s.string().nullable(),
    parentId: s.int(),
    parent: s
      .toOne(() => incrementParent)
      .fields("parentId")
      .references("id"),
    grandchildren: s.toMany(() => incrementGrandchild),
  })
  .map("nested_increment_children");

const incrementGrandchild = s
  .model({
    id: s.int().id().increment(),
    marker: s.string(),
    childId: s.int(),
    child: s
      .toOne(() => incrementChild)
      .fields("childId")
      .references("id"),
  })
  .map("nested_increment_grandchildren");

const schema = {
  user,
  post,
  comment,
  incrementParent,
  incrementChild,
  incrementGrandchild,
};

// =============================================================================
// TEST SETUP
// =============================================================================

let client: Awaited<
  ReturnType<
    typeof PGliteCreateClient<typeof schema, { schema: typeof schema }>
  >
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
  await client.comment.deleteMany();
  await client.incrementGrandchild.deleteMany();
  await client.incrementChild.deleteMany();
  await client.incrementParent.deleteMany();
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

    test("rejects the enclosing membership scalar inside nested createMany", async () => {
      const args = {
        data: {
          id: "user-1",
          name: "John",
          posts: {
            createMany: {
              data: [{ id: "post-1", title: "First Post", userId: "user-1" }],
            },
          },
        },
      } as unknown as Parameters<typeof client.user.create>[0];

      await expect(client.user.create(args)).rejects.toThrow();
      await expect(client.user.findMany()).resolves.toEqual([]);
      await expect(client.post.findMany()).resolves.toEqual([]);
    });

    test("relation-bearing rows run complete fresh subtrees left to right", async () => {
      await client.user.create({ data: { id: "resident", name: "Resident" } });
      await client.post.create({
        data: {
          id: "post-existing",
          title: "Existing",
          userId: "resident",
        },
      });

      await client.user.create({
        data: {
          id: "user-1",
          name: "John",
          posts: {
            createMany: {
              skipDuplicates: true,
              data: [
                {
                  id: "post-existing",
                  title: "Skipped",
                  comments: {
                    create: { id: "comment-skipped", body: "must roll back" },
                  },
                },
                {
                  id: "post-new",
                  title: "Inserted",
                  comments: {
                    create: { id: "comment-new", body: "kept" },
                  },
                },
              ],
            },
          },
        },
      });

      await expect(
        client.post.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            title: true,
            userId: true,
            comments: { orderBy: { id: "asc" } },
          },
        })
      ).resolves.toEqual([
        {
          id: "post-existing",
          title: "Existing",
          userId: "resident",
          comments: [],
        },
        {
          id: "post-new",
          title: "Inserted",
          userId: "user-1",
          comments: [{ id: "comment-new", body: "kept", postId: "post-new" }],
        },
      ]);
    });

    test("later relation-bearing rows observe a target created by an earlier row", async () => {
      await client.user.create({
        data: {
          id: "user-1",
          name: "John",
          posts: {
            createMany: {
              data: [
                {
                  id: "post-1",
                  title: "First",
                  comments: {
                    connectOrCreate: {
                      where: { id: "shared-comment" },
                      create: { id: "shared-comment", body: "Shared" },
                    },
                  },
                },
                {
                  id: "post-2",
                  title: "Second",
                  comments: {
                    connectOrCreate: {
                      where: { id: "shared-comment" },
                      create: { id: "shared-comment", body: "Must not run" },
                    },
                  },
                },
              ],
            },
          },
        },
      });

      await expect(client.comment.findMany()).resolves.toEqual([
        { id: "shared-comment", body: "Shared", postId: "post-2" },
      ]);
    });

    test("selected parent update composes relation-bearing createMany rows", async () => {
      await client.user.create({
        data: { id: "user-1", name: "John" },
      });

      await client.user.update({
        where: { id: "user-1" },
        data: {
          posts: {
            createMany: {
              data: [
                {
                  id: "post-1",
                  title: "First",
                  comments: {
                    create: { id: "comment-1", body: "First comment" },
                  },
                },
                {
                  id: "post-2",
                  title: "Second",
                  comments: {
                    create: { id: "comment-2", body: "Second comment" },
                  },
                },
              ],
            },
          },
        },
      });

      await expect(
        client.comment.findMany({ orderBy: { id: "asc" } })
      ).resolves.toEqual([
        { id: "comment-1", body: "First comment", postId: "post-1" },
        { id: "comment-2", body: "Second comment", postId: "post-2" },
      ]);
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

    test("preserves generation when another nested createMany row supplies an increment id", async () => {
      const parent = await client.incrementParent.create({
        data: {
          name: "Parent",
          children: {
            createMany: {
              data: [{ id: 10, label: "explicit" }, { label: "generated" }],
            },
          },
        },
      });

      const children = await client.incrementChild.findMany({
        where: { parentId: parent.id },
      });
      const idsByLabel = new Map(
        children.map((child) => [child.label, child.id])
      );

      expect(idsByLabel.get("explicit")).toBe(10);
      expect(idsByLabel.get("generated")).not.toBe(0);
      expect(idsByLabel.get("generated")).not.toBe(10);
    });

    test("skipDuplicates accepts a relation-bearing row with only derived root scalars", async () => {
      const parent = await client.incrementParent.create({
        data: {
          name: "Parent",
          children: {
            createMany: {
              skipDuplicates: true,
              data: [
                {
                  grandchildren: {
                    create: { marker: "kept" },
                  },
                },
              ],
            },
          },
        },
      });

      const [child] = await client.incrementChild.findMany({
        where: { parentId: parent.id },
      });
      expect(child).toEqual({
        id: expect.any(Number),
        label: null,
        parentId: parent.id,
      });
      await expect(client.incrementGrandchild.findMany()).resolves.toEqual([
        { id: expect.any(Number), marker: "kept", childId: child?.id },
      ]);
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

  describe("upsert branches", () => {
    test("upsert runs nested writes from the create branch", async () => {
      const result = await client.user.upsert({
        where: { id: "user-1" },
        create: {
          id: "user-1",
          name: "John",
          posts: {
            create: { id: "post-1", title: "Created from upsert create" },
          },
        },
        update: { name: "Updated John" },
        include: { posts: true },
      });

      expect(result.id).toBe("user-1");
      expect(result.name).toBe("John");
      expect(result.posts).toHaveLength(1);
      expect(result.posts[0]?.title).toBe("Created from upsert create");

      const posts = await client.post.findMany({
        where: { userId: "user-1" },
      });
      expect(posts).toHaveLength(1);
      expect(posts[0]?.userId).toBe("user-1");
    });

    test("upsert update branch executes nested createMany", async () => {
      await client.user.create({
        data: { id: "user-1", name: "John" },
      });

      const result = await client.user.upsert({
        where: { id: "user-1" },
        create: { id: "user-1", name: "New John" },
        update: {
          posts: {
            createMany: {
              data: [
                { id: "post-1", title: "First from update branch" },
                { id: "post-2", title: "Second from update branch" },
              ],
            },
          },
        },
        include: { posts: true },
      });

      expect(result.name).toBe("John");
      expect(result.posts).toHaveLength(2);

      const posts = await client.post.findMany({
        where: { userId: "user-1" },
        orderBy: { id: "asc" },
      });
      expect(posts.map((post) => post.title)).toEqual([
        "First from update branch",
        "Second from update branch",
      ]);
    });
  });

  describe("validation before execution", () => {
    /**
     * DELIVERED BY PACKAGE J (relation-bearing `createMany`), corrected here.
     *
     * This test used to assert that a relation envelope in a top-level `createMany`
     * row is REJECTED before writing. That was true until Package J widened the bulk
     * create element to the ordinary create surface and routed a relation-bearing row
     * to `CreateManyRecordSeries`. The assertion had been red since that landing and
     * nothing ran it — the package gates run focused files and the layer projects, and
     * this file is `extended-local`. Package N found it and measured it: the failure
     * reproduces with N's own validation changes reverted, so it is J's delivery, not
     * N's regression.
     *
     * What the position is FOR — "nothing is written unless the whole payload is
     * legal" — is kept, and moved to the shape J's own refusal still covers.
     */
    test("accepts a relation envelope in a top-level createMany row (Package J)", async () => {
      await client.user.createMany({
        data: [
          {
            id: "user-1",
            name: "John",
            posts: { create: { id: "post-1", title: "Written" } },
          },
        ],
      });

      const [users, posts] = await Promise.all([
        client.user.findMany(),
        client.post.findMany(),
      ]);
      expect(users).toHaveLength(1);
      expect(posts).toEqual([
        { id: "post-1", title: "Written", userId: "user-1" },
      ]);
    });

    test("skipDuplicates suppresses the complete duplicate root subtree", async () => {
      await client.user.create({ data: { id: "user-1", name: "Existing" } });

      await expect(
        client.user.createMany({
          data: [
            {
              id: "user-1",
              name: "Duplicate",
              posts: { create: { id: "post-skipped", title: "Skipped" } },
            },
            {
              id: "user-2",
              name: "Inserted",
              posts: { create: { id: "post-kept", title: "Kept" } },
            },
          ],
          skipDuplicates: true,
        })
      ).resolves.toEqual({ count: 1 });

      const [users, posts] = await Promise.all([
        client.user.findMany({ orderBy: { id: "asc" } }),
        client.post.findMany(),
      ]);
      expect(users).toEqual([
        { id: "user-1", name: "Existing" },
        { id: "user-2", name: "Inserted" },
      ]);
      expect(posts).toEqual([
        { id: "post-kept", title: "Kept", userId: "user-2" },
      ]);
    });

    test("missing nested update target rolls back parent mutation", async () => {
      await client.user.create({
        data: { id: "user-1", name: "John" },
      });

      await expect(
        client.user.update({
          where: { id: "user-1" },
          data: {
            name: "Changed",
            posts: {
              update: {
                where: { id: "post-1" },
                data: { title: "Ignored" },
              },
            },
          },
        })
      ).rejects.toThrow(
        "Cannot update relation 'posts': target record was not found for this parent."
      );

      const [user, posts] = await Promise.all([
        client.user.findUnique({
          where: { id: "user-1" },
        }),
        client.post.findMany(),
      ]);
      expect(user?.name).toBe("John");
      expect(posts).toHaveLength(0);
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

    test("runs nested writes from the update branch", async () => {
      await client.user.create({
        data: { id: "user-1", name: "John" },
      });

      const result = await client.user.upsert({
        where: { id: "user-1" },
        create: { id: "user-1", name: "New" },
        update: {
          name: "Updated",
          posts: {
            create: { id: "post-1", title: "Created from upsert update" },
          },
        },
      });

      expect(result.name).toBe("Updated");

      const posts = await client.post.findMany({
        where: { userId: "user-1" },
      });

      expect(posts).toHaveLength(1);
      expect(posts[0]?.title).toBe("Created from upsert update");
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
