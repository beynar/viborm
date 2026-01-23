/**
 * Client Operations Integration Tests
 *
 * Comprehensive tests for all VibORM client operations using PGlite.
 * Tests CRUD operations, queries, aggregations, transactions, and raw SQL.
 */

import { createClient as PGliteCreateClient } from "@drivers/pglite";
import { NotFoundError } from "@errors";
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

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
  age: s.int().nullable(),
  posts: s.oneToMany(() => post),
});

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    content: s.string().nullable(),
    published: s.boolean().default(false),
    views: s.int().default(0),
    authorId: s.string(),
    author: s
      .manyToOne(() => user)
      .fields("authorId")
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

// Helper to create test users
async function createTestUsers() {
  const alice = await client.user.create({
    data: { id: "user-1", name: "Alice", email: "alice@test.com", age: 30 },
  });
  const bob = await client.user.create({
    data: { id: "user-2", name: "Bob", email: "bob@test.com", age: 25 },
  });
  const charlie = await client.user.create({
    data: {
      id: "user-3",
      name: "Charlie",
      email: "charlie@test.com",
      age: null,
    },
  });
  return { alice, bob, charlie };
}

// Helper to create test posts
async function createTestPosts(authorId: string) {
  const post1 = await client.post.create({
    data: {
      id: "post-1",
      title: "First Post",
      content: "Content 1",
      published: true,
      views: 100,
      authorId,
    },
  });
  const post2 = await client.post.create({
    data: {
      id: "post-2",
      title: "Second Post",
      content: "Content 2",
      published: false,
      views: 50,
      authorId,
    },
  });
  const post3 = await client.post.create({
    data: {
      id: "post-3",
      title: "Third Post",
      content: null,
      published: true,
      views: 200,
      authorId,
    },
  });
  return { post1, post2, post3 };
}

// =============================================================================
// 1. FIND OPERATIONS
// =============================================================================

describe("Find Operations", () => {
  describe("findFirst", () => {
    test("returns null when no records exist", async () => {
      const result = await client.user.findFirst();
      expect(result).toBeNull();
    });

    test("returns first record when records exist", async () => {
      await createTestUsers();
      const result = await client.user.findFirst();
      expect(result).not.toBeNull();
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).toHaveProperty("email");
    });

    test("filters with where clause", async () => {
      await createTestUsers();
      const result = await client.user.findFirst({
        where: { name: "Alice" },
      });
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Alice");
    });

    test("orders results with orderBy", async () => {
      await createTestUsers();
      // Note: null values are sorted last in DESC order in PostgreSQL
      const result = await client.user.findFirst({
        where: { age: { not: null } }, // Filter out null ages for predictable ordering
        orderBy: { age: "desc" },
      });
      expect(result?.name).toBe("Alice"); // Alice is 30, Bob is 25
    });

    test("selects specific fields", async () => {
      await createTestUsers();
      const result = await client.user.findFirst({
        select: { id: true, name: true },
      });
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).not.toHaveProperty("email");
      expect(result).not.toHaveProperty("age");
    });

    test("includes relations", async () => {
      const { alice } = await createTestUsers();
      await createTestPosts(alice.id);

      const result = await client.user.findFirst({
        where: { id: alice.id },
        include: { posts: true },
      });
      expect(result).not.toBeNull();
      expect(result?.posts).toBeInstanceOf(Array);
      expect(result?.posts.length).toBe(3);
    });
  });

  describe("findFirstOrThrow", () => {
    test("returns record when found", async () => {
      await createTestUsers();
      const result = await client.user.findFirstOrThrow({
        where: { name: "Alice" },
      });
      expect(result.name).toBe("Alice");
    });

    test("throws NotFoundError when not found", async () => {
      try {
        await client.user.findFirstOrThrow({
          where: { name: "NonExistent" },
        });
        expect.unreachable("Should have thrown NotFoundError");
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundError);
      }
    });
  });

  describe("findMany", () => {
    test("returns empty array when no records exist", async () => {
      const result = await client.user.findMany();
      expect(result).toEqual([]);
    });

    test("returns all records", async () => {
      await createTestUsers();
      const result = await client.user.findMany();
      expect(result.length).toBe(3);
    });

    test("filters with where clause", async () => {
      await createTestUsers();
      const result = await client.user.findMany({
        where: { age: { gte: 28 } },
      });
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe("Alice");
    });

    test("orders results with orderBy", async () => {
      await createTestUsers();
      const result = await client.user.findMany({
        orderBy: { name: "asc" },
      });
      expect(result[0]?.name).toBe("Alice");
      expect(result[1]?.name).toBe("Bob");
      expect(result[2]?.name).toBe("Charlie");
    });

    test("paginates with take and skip", async () => {
      await createTestUsers();
      const result = await client.user.findMany({
        orderBy: { name: "asc" },
        take: 2,
        skip: 1,
      });
      expect(result.length).toBe(2);
      expect(result[0]?.name).toBe("Bob");
      expect(result[1]?.name).toBe("Charlie");
    });

    test("filters with multiple conditions (AND)", async () => {
      await createTestUsers();
      const result = await client.user.findMany({
        where: {
          AND: [{ age: { gte: 25 } }, { name: { startsWith: "A" } }],
        },
      });
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe("Alice");
    });

    test("filters with OR conditions", async () => {
      await createTestUsers();
      const result = await client.user.findMany({
        where: {
          OR: [{ name: "Alice" }, { name: "Bob" }],
        },
      });
      expect(result.length).toBe(2);
    });

    test("includes relations with nested filtering", async () => {
      const { alice } = await createTestUsers();
      await createTestPosts(alice.id);

      const result = await client.user.findMany({
        where: { id: alice.id },
        include: {
          posts: {
            where: { published: true },
          },
        },
      });
      expect(result.length).toBe(1);
      expect(result[0]?.posts.length).toBe(2); // Only published posts
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
      const { alice } = await createTestUsers();
      const result = await client.user.findUnique({
        where: { id: alice.id },
      });
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Alice");
    });

    test("finds by unique field", async () => {
      await createTestUsers();
      const result = await client.user.findUnique({
        where: { email: "bob@test.com" },
      });
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Bob");
    });
  });

  describe("findUniqueOrThrow", () => {
    test("returns record when found", async () => {
      const { alice } = await createTestUsers();
      const result = await client.user.findUniqueOrThrow({
        where: { id: alice.id },
      });
      expect(result.name).toBe("Alice");
    });

    test("throws NotFoundError when not found", async () => {
      try {
        await client.user.findUniqueOrThrow({
          where: { id: "nonexistent" },
        });
        expect.unreachable("Should have thrown NotFoundError");
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundError);
      }
    });
  });
});

// =============================================================================
// 2. CREATE OPERATIONS
// =============================================================================

describe("Create Operations", () => {
  describe("create", () => {
    test("creates a record with all fields", async () => {
      const result = await client.user.create({
        data: {
          id: "user-1",
          name: "Test User",
          email: "test@test.com",
          age: 25,
        },
      });

      expect(result.id).toBe("user-1");
      expect(result.name).toBe("Test User");
      expect(result.email).toBe("test@test.com");
      expect(result.age).toBe(25);
    });

    test("creates a record with nullable field as null", async () => {
      const result = await client.user.create({
        data: {
          id: "user-1",
          name: "Test User",
          email: "test@test.com",
          age: null,
        },
      });

      expect(result.age).toBeNull();
    });

    test("creates a record with default values", async () => {
      const { alice } = await createTestUsers();
      const result = await client.post.create({
        data: {
          id: "post-1",
          title: "Test Post",
          authorId: alice.id,
        },
      });

      expect(result.published).toBe(false); // Default value
      expect(result.views).toBe(0); // Default value
    });

    test("returns created record with select", async () => {
      const result = await client.user.create({
        data: {
          id: "user-1",
          name: "Test User",
          email: "test@test.com",
        },
        select: { id: true, name: true },
      });

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).not.toHaveProperty("email");
    });

    test("returns created record with include", async () => {
      const { alice } = await createTestUsers();
      const result = await client.post.create({
        data: {
          id: "post-1",
          title: "Test Post",
          authorId: alice.id,
        },
        include: { author: true },
      });

      expect(result.author).not.toBeNull();
      expect(result.author.name).toBe("Alice");
    });
  });

  describe("createMany", () => {
    test("creates multiple records", async () => {
      const result = await client.user.createMany({
        data: [
          { id: "user-1", name: "User1", email: "user1@test.com" },
          { id: "user-2", name: "User 2", email: "user2@test.com" },
          { id: "user-3", name: "User 3", email: "user3@test.com" },
        ],
      });

      expect(result.count).toBe(3);
      const allUsers = await client.user.findMany();
      expect(allUsers.length).toBe(3);
    });

    test("returns BatchPayload with count", async () => {
      const result = await client.user.createMany({
        data: [{ id: "user-1", name: "User 1", email: "user1@test.com" }],
      });

      expect(result).toHaveProperty("count");
      expect(typeof result.count).toBe("number");
      expect(result.count).toBe(1);
    });
  });
});

// =============================================================================
// 3. UPDATE OPERATIONS
// =============================================================================

describe("Update Operations", () => {
  describe("update", () => {
    test("updates a record by id", async () => {
      const { alice } = await createTestUsers();

      const result = await client.user.update({
        where: { id: alice.id },
        data: { name: "Alice Updated" },
      });

      expect(result.name).toBe("Alice Updated");
      expect(result.email).toBe("alice@test.com"); // Unchanged
    });

    test("updates multiple fields", async () => {
      const { alice } = await createTestUsers();

      const result = await client.user.update({
        where: { id: alice.id },
        data: {
          name: "Alice Updated",
          age: 31,
        },
      });

      expect(result.name).toBe("Alice Updated");
      expect(result.age).toBe(31);
    });

    test("updates nullable field to null", async () => {
      const { alice } = await createTestUsers();

      const result = await client.user.update({
        where: { id: alice.id },
        data: { age: null },
      });

      expect(result.age).toBeNull();
    });

    test("returns updated record with select", async () => {
      const { alice } = await createTestUsers();

      const result = await client.user.update({
        where: { id: alice.id },
        data: { name: "Alice Updated" },
        select: { id: true, name: true },
      });

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).not.toHaveProperty("email");
    });
  });

  describe("updateMany", () => {
    test("updates multiple records matching where", async () => {
      await createTestUsers();

      const result = await client.user.updateMany({
        where: { age: { gte: 25 } },
        data: { name: "Updated" },
      });

      expect(result.count).toBe(2); // Alice and Bob
      const updated = await client.user.findMany({
        where: { name: "Updated" },
      });
      expect(updated.length).toBe(2);
    });

    test("updates all records when no where", async () => {
      await createTestUsers();

      const result = await client.user.updateMany({
        data: { age: 99 },
      });

      expect(result.count).toBe(3);
      const all = await client.user.findMany({
        where: { age: 99 },
      });
      expect(all.length).toBe(3);
    });

    test("returns BatchPayload with count", async () => {
      await createTestUsers();

      const result = await client.user.updateMany({
        where: { name: "Alice" },
        data: { age: 35 },
      });

      expect(result).toHaveProperty("count");
      expect(result.count).toBe(1);
    });
  });
});

// =============================================================================
// 4. DELETE OPERATIONS
// =============================================================================

describe("Delete Operations", () => {
  describe("delete", () => {
    test("deletes a record by id", async () => {
      const { alice, bob } = await createTestUsers();

      const result = await client.user.delete({
        where: { id: alice.id },
      });

      expect(result.id).toBe(alice.id);

      // Verify deletion
      const remaining = await client.user.findMany();
      expect(remaining.length).toBe(2);
      expect(remaining.find((u) => u.id === alice.id)).toBeUndefined();
    });

    test("returns deleted record", async () => {
      const { alice } = await createTestUsers();

      const result = await client.user.delete({
        where: { id: alice.id },
      });

      expect(result.name).toBe("Alice");
      expect(result.email).toBe("alice@test.com");
    });

    test("returns deleted record with select", async () => {
      const { alice } = await createTestUsers();

      const result = await client.user.delete({
        where: { id: alice.id },
        select: { id: true, name: true },
      });

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).not.toHaveProperty("email");
    });
  });

  describe("deleteMany", () => {
    test("deletes multiple records matching where", async () => {
      await createTestUsers();

      const result = await client.user.deleteMany({
        where: { age: { gte: 25 } },
      });

      expect(result.count).toBe(2); // Alice and Bob
      const remaining = await client.user.findMany();
      expect(remaining.length).toBe(1);
      expect(remaining[0]?.name).toBe("Charlie");
    });

    test("deletes all records when no where", async () => {
      await createTestUsers();

      const result = await client.user.deleteMany();

      expect(result.count).toBe(3);
      const remaining = await client.user.findMany();
      expect(remaining.length).toBe(0);
    });

    test("returns BatchPayload with count zero when no matches", async () => {
      await createTestUsers();

      const result = await client.user.deleteMany({
        where: { name: "NonExistent" },
      });

      expect(result.count).toBe(0);
    });
  });
});

// =============================================================================
// 5. AGGREGATE OPERATIONS
// =============================================================================

describe("Aggregate Operations", () => {
  describe("count", () => {
    test("counts all records", async () => {
      await createTestUsers();
      const result = await client.user.count();
      expect(result).toBe(3);
    });

    test("counts with where filter", async () => {
      await createTestUsers();
      const result = await client.user.count({
        where: { age: { gte: 25 } },
      });
      expect(result).toBe(2); // Alice and Bob
    });

    test("returns 0 when no records", async () => {
      const result = await client.user.count();
      expect(result).toBe(0);
    });
  });

  describe("aggregate", () => {
    test("calculates _sum", async () => {
      const { alice } = await createTestUsers();
      await createTestPosts(alice.id);

      const result = await client.post.aggregate({
        _sum: { views: true },
      });

      expect(result._sum.views).toBe(350); // 100 + 50 + 200
    });

    test("calculates _avg", async () => {
      const { alice } = await createTestUsers();
      await createTestPosts(alice.id);

      const result = await client.post.aggregate({
        _avg: { views: true },
      });

      // Average of 100, 50, 200 = 116.67
      expect(result._avg.views).toBeCloseTo(116.67, 1);
    });

    test("calculates _min and _max", async () => {
      const { alice } = await createTestUsers();
      await createTestPosts(alice.id);

      const result = await client.post.aggregate({
        _min: { views: true },
        _max: { views: true },
      });

      expect(result._min.views).toBe(50);
      expect(result._max.views).toBe(200);
    });

    test("calculates _count", async () => {
      const { alice } = await createTestUsers();
      await createTestPosts(alice.id);

      const result = await client.post.aggregate({
        _count: true,
      });

      expect(result._count).toBe(3);
    });

    test("aggregates with where filter", async () => {
      const { alice } = await createTestUsers();
      await createTestPosts(alice.id);

      const result = await client.post.aggregate({
        where: { published: true },
        _sum: { views: true },
        _count: true,
      });

      expect(result._count).toBe(2); // Only published posts
      expect(result._sum.views).toBe(300); // 100 + 200
    });
  });

  describe("groupBy", () => {
    test("groups by single field", async () => {
      const { alice, bob } = await createTestUsers();
      await createTestPosts(alice.id);
      await client.post.create({
        data: {
          id: "post-4",
          title: "Bob Post",
          published: true,
          views: 75,
          authorId: bob.id,
        },
      });

      const result = await client.post.groupBy({
        by: ["authorId"],
        _count: true,
      });

      expect(result.length).toBe(2);
      const aliceGroup = result.find((g) => g.authorId === alice.id);
      const bobGroup = result.find((g) => g.authorId === bob.id);
      expect(aliceGroup?._count).toBe(3);
      expect(bobGroup?._count).toBe(1);
    });

    test("groups with aggregates", async () => {
      const { alice } = await createTestUsers();
      await createTestPosts(alice.id);

      const result = await client.post.groupBy({
        by: ["published"],
        _sum: { views: true },
        _count: true,
      });

      expect(result.length).toBe(2);
      const publishedGroup = result.find((g) => g.published === true);
      const unpublishedGroup = result.find((g) => g.published === false);
      expect(publishedGroup?._sum.views).toBe(300); // 100 + 200
      expect(unpublishedGroup?._sum.views).toBe(50);
    });
  });
});

// =============================================================================
// 6. UTILITY OPERATIONS
// =============================================================================

describe("Utility Operations", () => {
  describe("upsert", () => {
    test("creates when record does not exist", async () => {
      const result = await client.user.upsert({
        where: { id: "user-new" },
        create: {
          id: "user-new",
          name: "New User",
          email: "new@test.com",
        },
        update: { name: "Updated User" },
      });

      expect(result.id).toBe("user-new");
      expect(result.name).toBe("New User");
    });

    test("updates when record exists", async () => {
      const { alice } = await createTestUsers();

      const result = await client.user.upsert({
        where: { id: alice.id },
        create: {
          id: alice.id,
          name: "Should Not Create",
          email: "shouldnot@test.com",
        },
        update: { name: "Upserted Alice" },
      });

      expect(result.id).toBe(alice.id);
      expect(result.name).toBe("Upserted Alice");
      expect(result.email).toBe("alice@test.com"); // Original email
    });
  });

  describe("exist", () => {
    test("returns true when record exists", async () => {
      await createTestUsers();
      const result = await client.user.exist({ where: { name: "Alice" } });
      expect(result).toBe(true);
    });

    test("returns false when record does not exist", async () => {
      await createTestUsers();
      const result = await client.user.exist({
        where: { name: "NonExistent" },
      });
      expect(result).toBe(false);
    });

    test("returns false when no records", async () => {
      const result = await client.user.exist({ where: { name: "Anyone" } });
      expect(result).toBe(false);
    });
  });
});

// =============================================================================
// 7. TRANSACTION & RAW SQL
// =============================================================================

describe("Transaction & Raw SQL", () => {
  describe("$transaction", () => {
    test("commits multiple operations", async () => {
      await client.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "tx-user-1", name: "TX User 1", email: "tx1@test.com" },
        });
        await tx.user.create({
          data: { id: "tx-user-2", name: "TX User 2", email: "tx2@test.com" },
        });
      });

      const users = await client.user.findMany();
      expect(users.length).toBe(2);
    });

    test("rolls back on error", async () => {
      try {
        await client.$transaction(async (tx) => {
          await tx.user.create({
            data: { id: "tx-user-1", name: "TX User 1", email: "tx1@test.com" },
          });
          // This should fail due to duplicate email unique constraint
          await tx.user.create({
            data: { id: "tx-user-2", name: "TX User 2", email: "tx1@test.com" },
          });
        });
      } catch {
        // Expected to fail
      }

      // Verify rollback - no users should exist
      const users = await client.user.findMany();
      expect(users.length).toBe(0);
    });

    test("returns transaction result", async () => {
      const result = await client.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { id: "tx-user-1", name: "TX User", email: "tx@test.com" },
        });
        return user;
      });

      expect(result.name).toBe("TX User");
    });
  });

  describe("$executeRaw", () => {
    test("executes raw SQL query", async () => {
      await createTestUsers();

      const result = await client.$executeRaw<{ name: string }>(
        sql`SELECT "name" FROM "user" WHERE "name" = ${"Alice"}`
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0]?.name).toBe("Alice");
    });

    test("returns rowCount for mutations", async () => {
      await createTestUsers();

      const result = await client.$executeRaw(
        sql`UPDATE "user" SET "age" = ${99} WHERE "age" IS NOT NULL`
      );

      expect(result.rowCount).toBe(2); // Alice and Bob
    });
  });

  describe("$queryRaw", () => {
    test("executes raw SQL string with params", async () => {
      await createTestUsers();

      const result = await client.$queryRaw<{ name: string }>(
        'SELECT "name" FROM "user" WHERE "age" >= $1',
        [25]
      );

      expect(result.rows.length).toBe(2); // Alice (30) and Bob (25)
    });

    test("returns all rows", async () => {
      await createTestUsers();

      const result = await client.$queryRaw<{ id: string; name: string }>(
        'SELECT "id", "name" FROM "user" ORDER BY "name" ASC'
      );

      expect(result.rows.length).toBe(3);
      expect(result.rows[0]?.name).toBe("Alice");
      expect(result.rows[1]?.name).toBe("Bob");
      expect(result.rows[2]?.name).toBe("Charlie");
    });
  });
});

// =============================================================================
// 8. RELATION QUERIES
// =============================================================================

describe("Relation Queries", () => {
  test("includes to-many relation", async () => {
    const { alice } = await createTestUsers();
    await createTestPosts(alice.id);

    const result = await client.user.findFirst({
      where: { id: alice.id },
      include: { posts: true },
    });

    expect(result?.posts.length).toBe(3);
  });

  test("includes to-one relation", async () => {
    const { alice } = await createTestUsers();
    const { post1 } = await createTestPosts(alice.id);

    const result = await client.post.findFirst({
      where: { id: post1.id },
      include: { author: true },
    });

    expect(result?.author.name).toBe("Alice");
  });

  test("filters by relation (some)", async () => {
    const { alice, bob } = await createTestUsers();
    await createTestPosts(alice.id);

    const result = await client.user.findMany({
      where: {
        posts: {
          some: { published: true },
        },
      },
    });

    expect(result.length).toBe(1);
    expect(result[0]?.name).toBe("Alice");
  });

  test("nested select on relation", async () => {
    const { alice } = await createTestUsers();
    await createTestPosts(alice.id);

    const result = await client.user.findFirst({
      where: { id: alice.id },
      select: {
        name: true,
        posts: {
          select: { title: true },
        },
      },
    });

    expect(result).toHaveProperty("name");
    expect(result).not.toHaveProperty("id");
    expect(result?.posts[0]).toHaveProperty("title");
    expect(result?.posts[0]).not.toHaveProperty("id");
    expect(result?.posts[0]).not.toHaveProperty("content");
  });

  test("orders and limits relation", async () => {
    const { alice } = await createTestUsers();
    await createTestPosts(alice.id);

    const result = await client.user.findFirst({
      where: { id: alice.id },
      include: {
        posts: {
          orderBy: { views: "desc" },
          take: 2,
        },
      },
    });

    expect(result?.posts.length).toBe(2);
    expect(result?.posts[0]?.views).toBe(200); // Third Post
    expect(result?.posts[1]?.views).toBe(100); // First Post
  });
});
