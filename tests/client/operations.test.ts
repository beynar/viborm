/**
 * Client Operations Integration Tests
 *
 * Comprehensive tests for all VibORM client operations using PGlite.
 * Tests CRUD operations, queries, aggregations, transactions, and raw SQL.
 */

import { createClient as PGliteCreateClient } from "@drivers/pglite";
import { NotFoundError, ValidationError } from "@errors";
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
import { clientUserPostSchema } from "../fixtures/user-post-schema";
import {
  createStandardUserPostPosts,
  createStandardUserPostUsers,
} from "../fixtures/user-post-seed";

// =============================================================================
// TEST SCHEMA
// =============================================================================

const membership = s
  .model({
    orgId: s.string(),
    memberId: s.string(),
    email: s.string(),
    tenantId: s.string(),
    role: s.string(),
  })
  .id(["orgId", "memberId"])
  .unique(["email", "tenantId"]);

const schema = { ...clientUserPostSchema, membership };

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
  await client.membership.deleteMany();
});

async function createTestMemberships() {
  await client.membership.create({
    data: {
      orgId: "org-1",
      memberId: "member-1",
      email: "a@example.com",
      tenantId: "tenant-1",
      role: "owner",
    },
  });
  await client.membership.create({
    data: {
      orgId: "org-1",
      memberId: "member-2",
      email: "b@example.com",
      tenantId: "tenant-1",
      role: "admin",
    },
  });
  await client.membership.create({
    data: {
      orgId: "org-2",
      memberId: "member-1",
      email: "c@example.com",
      tenantId: "tenant-1",
      role: "viewer",
    },
  });
}

/**
 * Capture the error produced by an operation regardless of whether the client
 * throws synchronously (eager validation) or rejects the awaited promise.
 */
async function captureThrown(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
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
      await createStandardUserPostUsers(client);
      const result = await client.user.findFirst();
      expect(result).not.toBeNull();
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).toHaveProperty("email");
    });

    test("filters with where clause", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findFirst({
        where: { name: "Alice" },
      });
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Alice");
    });

    test("orders results with orderBy", async () => {
      await createStandardUserPostUsers(client);
      // Note: null values are sorted last in DESC order in PostgreSQL
      const result = await client.user.findFirst({
        where: { age: { not: null } }, // Filter out null ages for predictable ordering
        orderBy: { age: "desc" },
      });
      expect(result?.name).toBe("Alice"); // Alice is 30, Bob is 25
    });

    test("selects specific fields", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findFirst({
        select: { id: true, name: true },
      });
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).not.toHaveProperty("email");
      expect(result).not.toHaveProperty("age");
    });

    test("includes relations", async () => {
      const { alice } = await createStandardUserPostUsers(client);
      await createStandardUserPostPosts(client, alice.id);

      const result = await client.user.findFirst({
        where: { id: alice.id },
        include: { posts: true },
      });
      expect(result).not.toBeNull();
      expect(result?.posts).toBeInstanceOf(Array);
      expect(result?.posts.length).toBe(3);
    });

    // Regression witness: the old code hardcoded LIMIT 1 and ignored take, so
    // take: -1 returned the FIRST row of the asc window (Bob) instead of the
    // last (Alice), and take: 0 returned a row instead of null.
    test("take -1 returns the last row of the orderBy window", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findFirst({
        where: { age: { not: null } },
        orderBy: { age: "asc" },
        take: -1,
      });
      expect(result?.name).toBe("Alice"); // Alice is 30, Bob is 25
    });

    test("take -1 applies the where filter before taking from the end", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findFirst({
        where: { name: { in: ["Alice", "Bob"] } },
        orderBy: { name: "asc" },
        take: -1,
      });
      expect(result?.name).toBe("Bob");
    });

    test("take 0 returns null even when rows match", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findFirst({ take: 0 });
      expect(result).toBeNull();
    });

    test("positive take still returns the first row", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findFirst({
        orderBy: { name: "asc" },
        take: 5,
      });
      expect(result?.name).toBe("Alice");
    });
  });

  describe("findFirstOrThrow", () => {
    test("returns record when found", async () => {
      await createStandardUserPostUsers(client);
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
        expect(error).toHaveProperty(
          "message",
          "No user record found for findFirstOrThrow"
        );
      }
    });

    test("take -1 returns the last row of the orderBy window", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findFirstOrThrow({
        where: { age: { not: null } },
        orderBy: { age: "asc" },
        take: -1,
      });
      expect(result.name).toBe("Alice"); // Alice is 30, Bob is 25
    });

    test("take 0 throws NotFoundError even when rows match", async () => {
      await createStandardUserPostUsers(client);
      const error = await captureThrown(() =>
        client.user.findFirstOrThrow({ take: 0 })
      );
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toHaveProperty(
        "message",
        "No user record found for findFirstOrThrow"
      );
    });
  });

  describe("findMany", () => {
    test("returns empty array when no records exist", async () => {
      const result = await client.user.findMany();
      expect(result).toEqual([]);
    });

    test("returns all records", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findMany();
      expect(result.length).toBe(3);
    });

    test("filters with where clause", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findMany({
        where: { age: { gte: 28 } },
      });
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe("Alice");
    });

    test("orders results with orderBy", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findMany({
        orderBy: { name: "asc" },
      });
      expect(result[0]?.name).toBe("Alice");
      expect(result[1]?.name).toBe("Bob");
      expect(result[2]?.name).toBe("Charlie");
    });

    test("paginates with take and skip", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findMany({
        orderBy: { name: "asc" },
        take: 2,
        skip: 1,
      });
      expect(result.length).toBe(2);
      expect(result[0]?.name).toBe("Bob");
      expect(result[1]?.name).toBe("Charlie");
    });

    test("cursor includes cursor row by default", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findMany({
        cursor: { id: "user-2" },
        orderBy: { id: "asc" },
        take: 2,
      });

      expect(result.map((record) => record.id)).toEqual(["user-2", "user-3"]);
    });

    test("skip 1 excludes cursor row", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findMany({
        cursor: { id: "user-2" },
        orderBy: { id: "asc" },
        skip: 1,
        take: 1,
      });

      expect(result.map((record) => record.id)).toEqual(["user-3"]);
    });

    test("cursor without orderBy uses deterministic default ordering", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findMany({
        cursor: { id: "user-2" },
        take: 2,
      });

      expect(result.map((record) => record.id)).toEqual(["user-2", "user-3"]);
    });

    test("negative take pages backward in logical order", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findMany({
        cursor: { id: "user-3" },
        orderBy: { id: "asc" },
        skip: 1,
        take: -2,
      });

      expect(result.map((record) => record.id)).toEqual(["user-1", "user-2"]);
    });

    test("negative take honors explicit orderBy without cursor", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findMany({
        orderBy: { name: "desc" },
        take: -2,
      });

      expect(result.map((record) => record.name)).toEqual(["Bob", "Alice"]);
    });

    test("compound unique cursor paginates by compound fields", async () => {
      await createTestMemberships();
      const result = await client.membership.findMany({
        cursor: {
          email_tenantId: { email: "b@example.com", tenantId: "tenant-1" },
        },
        skip: 1,
        take: 1,
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        orgId: "org-2",
        memberId: "member-1",
      });
    });

    test("invalid pagination values reject during validation", async () => {
      await expect(
        client.user.findMany({ take: 1.5 as number })
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(client.user.findMany({ skip: -1 })).rejects.toBeInstanceOf(
        ValidationError
      );
      await expect(
        client.user.findMany({ take: Number.NaN })
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        client.user.findMany({ take: Number.POSITIVE_INFINITY })
      ).rejects.toBeInstanceOf(ValidationError);
    });

    test("filters with multiple conditions (AND)", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findMany({
        where: {
          AND: [{ age: { gte: 25 } }, { name: { startsWith: "A" } }],
        },
      });
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe("Alice");
    });

    test("filters with OR conditions", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findMany({
        where: {
          OR: [{ name: "Alice" }, { name: "Bob" }],
        },
      });
      expect(result.length).toBe(2);
    });

    test("includes relations with nested filtering", async () => {
      const { alice } = await createStandardUserPostUsers(client);
      await createStandardUserPostPosts(client, alice.id);

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
      const { alice } = await createStandardUserPostUsers(client);
      const result = await client.user.findUnique({
        where: { id: alice.id },
      });
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Alice");
    });

    test("finds by unique field", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.findUnique({
        where: { email: "bob@test.com" },
      });
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Bob");
    });

    test("rejects empty where before preparing operation", () => {
      expect(() => {
        // @ts-expect-error runtime guard covers invalid empty unique selector
        client.user.findUnique({ where: {} });
      }).toThrow(ValidationError);
    });
  });

  describe("findUniqueOrThrow", () => {
    test("returns record when found", async () => {
      const { alice } = await createStandardUserPostUsers(client);
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
        expect(error).toHaveProperty(
          "message",
          "No user record found for findUniqueOrThrow"
        );
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
      const { alice } = await createStandardUserPostUsers(client);
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
      const { alice } = await createStandardUserPostUsers(client);
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
      const { alice } = await createStandardUserPostUsers(client);

      const result = await client.user.update({
        where: { id: alice.id },
        data: { name: "Alice Updated" },
      });

      expect(result.name).toBe("Alice Updated");
      expect(result.email).toBe("alice@test.com"); // Unchanged
    });

    test("updates multiple fields", async () => {
      const { alice } = await createStandardUserPostUsers(client);

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
      const { alice } = await createStandardUserPostUsers(client);

      const result = await client.user.update({
        where: { id: alice.id },
        data: { age: null },
      });

      expect(result.age).toBeNull();
    });

    test("returns updated record with select", async () => {
      const { alice } = await createStandardUserPostUsers(client);

      const result = await client.user.update({
        where: { id: alice.id },
        data: { name: "Alice Updated" },
        select: { id: true, name: true },
      });

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).not.toHaveProperty("email");
    });

    test("throws NotFoundError when target row does not exist", async () => {
      await expect(
        client.user.update({
          where: { id: "nonexistent" },
          data: { name: "Missing User" },
        })
      ).rejects.toThrow(NotFoundError);

      await expect(
        client.user.update({
          where: { id: "nonexistent" },
          data: { name: "Missing User" },
        })
      ).rejects.toThrow("No user record found for update");
    });

    test("rejects empty where before preparing operation", () => {
      expect(() => {
        client.user.update({
          // @ts-expect-error runtime guard covers invalid empty unique selector
          where: {},
          data: { name: "Alice Updated" },
        });
      }).toThrow(ValidationError);
    });
  });

  describe("updateMany", () => {
    test("updates multiple records matching where", async () => {
      await createStandardUserPostUsers(client);

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
      await createStandardUserPostUsers(client);

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
      await createStandardUserPostUsers(client);

      const result = await client.user.updateMany({
        where: { name: "Alice" },
        data: { age: 35 },
      });

      expect(result).toHaveProperty("count");
      expect(result.count).toBe(1);
    });

    test("returns BatchPayload with count zero when no matches", async () => {
      await createStandardUserPostUsers(client);

      const result = await client.user.updateMany({
        where: { name: "NonExistent" },
        data: { age: 35 },
      });

      expect(result).toEqual({ count: 0 });
    });

    test("rejects relation data alongside scalars and leaves the DB unchanged", async () => {
      const { alice } = await createStandardUserPostUsers(client);

      const error = await captureThrown(() =>
        client.user.updateMany({
          where: { id: alice.id },
          // NOTE: no @ts-expect-error here — nested excess-property checking
          // does not fire through the client's generic signature when another
          // valid key is present (pre-existing surface-wide TS limitation, it
          // affects typo'd scalar keys on every operation too). The runtime
          // parse boundary is the enforced rejection for this shape; the
          // relation-only test below proves the type-level exclusion.
          data: {
            name: "Smuggler",
            posts: {
              create: {
                id: "post-smuggled",
                title: "Smuggled",
                authorId: alice.id,
              },
            },
          },
        })
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toContain("posts");

      // Neither the scalar update nor the nested create was applied.
      const user = await client.user.findUnique({ where: { id: alice.id } });
      expect(user?.name).toBe("Alice");
      const smuggled = await client.post.findUnique({
        where: { id: "post-smuggled" },
      });
      expect(smuggled).toBeNull();
    });

    test("rejects relation-only data with a ValidationError naming the key", async () => {
      const { alice } = await createStandardUserPostUsers(client);

      const error = await captureThrown(() =>
        client.user.updateMany({
          where: { id: alice.id },
          data: {
            // @ts-expect-error updateMany data is scalar-only; relation keys are rejected
            posts: {
              create: {
                id: "post-smuggled",
                title: "Smuggled",
                authorId: alice.id,
              },
            },
          },
        })
      );

      // A loud ValidationError naming the relation key, not a misleading
      // "No fields to update" QueryEngineError.
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toContain("posts");

      const smuggled = await client.post.findUnique({
        where: { id: "post-smuggled" },
      });
      expect(smuggled).toBeNull();
    });
  });

  describe("updateManyAndReturn", () => {
    test("scalar-only data updates and returns the affected rows", async () => {
      await createStandardUserPostUsers(client);

      const rows = await client.user.updateManyAndReturn({
        where: { age: { gte: 25 } },
        data: { name: "Returned" },
      });

      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(row.name).toBe("Returned");
      }
    });

    test("rejects relation data alongside scalars and leaves the DB unchanged", async () => {
      const { alice } = await createStandardUserPostUsers(client);

      const error = await captureThrown(() =>
        client.user.updateManyAndReturn({
          where: { id: alice.id },
          // NOTE: no @ts-expect-error here — nested excess-property checking
          // does not fire through the client's generic signature when another
          // valid key is present (pre-existing surface-wide TS limitation).
          // The runtime parse boundary is the enforced rejection for this
          // shape; the relation-only test below proves the type-level
          // exclusion.
          data: {
            name: "Smuggler",
            posts: {
              create: {
                id: "post-smuggled",
                title: "Smuggled",
                authorId: alice.id,
              },
            },
          },
        })
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toContain("posts");

      const user = await client.user.findUnique({ where: { id: alice.id } });
      expect(user?.name).toBe("Alice");
      const smuggled = await client.post.findUnique({
        where: { id: "post-smuggled" },
      });
      expect(smuggled).toBeNull();
    });

    test("rejects relation-only data with a ValidationError naming the key", async () => {
      const { alice } = await createStandardUserPostUsers(client);

      const error = await captureThrown(() =>
        client.user.updateManyAndReturn({
          where: { id: alice.id },
          data: {
            // @ts-expect-error updateManyAndReturn data is scalar-only; relation keys are rejected
            posts: {
              create: {
                id: "post-smuggled",
                title: "Smuggled",
                authorId: alice.id,
              },
            },
          },
        })
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toContain("posts");

      const smuggled = await client.post.findUnique({
        where: { id: "post-smuggled" },
      });
      expect(smuggled).toBeNull();
    });
  });
});

// =============================================================================
// 4. DELETE OPERATIONS
// =============================================================================

describe("Delete Operations", () => {
  describe("delete", () => {
    test("deletes a record by id", async () => {
      const { alice, bob } = await createStandardUserPostUsers(client);

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
      const { alice } = await createStandardUserPostUsers(client);

      const result = await client.user.delete({
        where: { id: alice.id },
      });

      expect(result.name).toBe("Alice");
      expect(result.email).toBe("alice@test.com");
    });

    test("returns deleted record with select", async () => {
      const { alice } = await createStandardUserPostUsers(client);

      const result = await client.user.delete({
        where: { id: alice.id },
        select: { id: true, name: true },
      });

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).not.toHaveProperty("email");
    });

    test("throws NotFoundError when target row does not exist", async () => {
      await expect(
        client.user.delete({
          where: { id: "nonexistent" },
        })
      ).rejects.toThrow(NotFoundError);

      await expect(
        client.user.delete({
          where: { id: "nonexistent" },
        })
      ).rejects.toThrow("No user record found for delete");
    });

    test("rejects empty where before preparing operation", () => {
      expect(() => {
        // @ts-expect-error runtime guard covers invalid empty unique selector
        client.user.delete({ where: {} });
      }).toThrow(ValidationError);
    });
  });

  describe("deleteMany", () => {
    test("deletes multiple records matching where", async () => {
      await createStandardUserPostUsers(client);

      const result = await client.user.deleteMany({
        where: { age: { gte: 25 } },
      });

      expect(result.count).toBe(2); // Alice and Bob
      const remaining = await client.user.findMany();
      expect(remaining.length).toBe(1);
      expect(remaining[0]?.name).toBe("Charlie");
    });

    test("deletes all records when no where", async () => {
      await createStandardUserPostUsers(client);

      const result = await client.user.deleteMany();

      expect(result.count).toBe(3);
      const remaining = await client.user.findMany();
      expect(remaining.length).toBe(0);
    });

    test("returns BatchPayload with count zero when no matches", async () => {
      await createStandardUserPostUsers(client);

      const result = await client.user.deleteMany({
        where: { name: "NonExistent" },
      });

      expect(result).toEqual({ count: 0 });
    });
  });
});

// =============================================================================
// 5. AGGREGATE OPERATIONS
// =============================================================================

describe("Aggregate Operations", () => {
  describe("count", () => {
    test("counts all records", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.count();
      expect(result).toBe(3);
    });

    test("counts with where filter", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.count({
        where: { age: { gte: 25 } },
      });
      expect(result).toBe(2); // Alice and Bob
    });

    test("counts paginated input rows", async () => {
      await createStandardUserPostUsers(client);

      const result = await client.user.count({
        cursor: { id: "user-2" },
        skip: 1,
        take: 10,
      });

      expect(result).toBe(1);
    });

    test("counts ordered cursor input rows", async () => {
      await createStandardUserPostUsers(client);

      const defaultOrderCount = await client.user.count({
        cursor: { id: "user-1" },
        take: 10,
      });
      const descendingOrderCount = await client.user.count({
        cursor: { id: "user-1" },
        orderBy: { id: "desc" },
        take: 10,
      });

      expect(defaultOrderCount).toBe(3);
      expect(descendingOrderCount).toBe(1);
    });

    test("returns 0 when no records", async () => {
      const result = await client.user.count();
      expect(result).toBe(0);
    });
  });

  describe("aggregate", () => {
    test("calculates _sum", async () => {
      const { alice } = await createStandardUserPostUsers(client);
      await createStandardUserPostPosts(client, alice.id);

      const result = await client.post.aggregate({
        _sum: { views: true },
      });

      expect(result._sum.views).toBe(350); // 100 + 50 + 200
    });

    test("calculates _avg", async () => {
      const { alice } = await createStandardUserPostUsers(client);
      await createStandardUserPostPosts(client, alice.id);

      const result = await client.post.aggregate({
        _avg: { views: true },
      });

      // Average of 100, 50, 200 = 116.67
      expect(result._avg.views).toBeCloseTo(116.67, 1);
    });

    test("calculates _min and _max", async () => {
      const { alice } = await createStandardUserPostUsers(client);
      await createStandardUserPostPosts(client, alice.id);

      const result = await client.post.aggregate({
        _min: { views: true },
        _max: { views: true },
      });

      expect(result._min.views).toBe(50);
      expect(result._max.views).toBe(200);
    });

    test("calculates _count", async () => {
      const { alice } = await createStandardUserPostUsers(client);
      await createStandardUserPostPosts(client, alice.id);

      const result = await client.post.aggregate({
        _count: true,
      });

      expect(result._count).toBe(3);
    });

    test("aggregates with where filter", async () => {
      const { alice } = await createStandardUserPostUsers(client);
      await createStandardUserPostPosts(client, alice.id);

      const result = await client.post.aggregate({
        where: { published: true },
        _sum: { views: true },
        _count: true,
      });

      expect(result._count).toBe(2); // Only published posts
      expect(result._sum.views).toBe(300); // 100 + 200
    });

    test("aggregates ordered and paginated input rows", async () => {
      const { alice } = await createStandardUserPostUsers(client);
      await createStandardUserPostPosts(client, alice.id);

      const result = await client.post.aggregate({
        orderBy: { views: "asc" },
        take: 2,
        _count: true,
        _sum: { views: true },
        _min: { views: true },
        _max: { views: true },
      });

      expect(result._count).toBe(2);
      expect(result._sum.views).toBe(150);
      expect(result._min.views).toBe(50);
      expect(result._max.views).toBe(100);
    });

    test("aggregates cursor-paginated input rows", async () => {
      const { alice } = await createStandardUserPostUsers(client);
      await createStandardUserPostPosts(client, alice.id);

      const result = await client.post.aggregate({
        cursor: { id: "post-2" },
        orderBy: { id: "asc" },
        skip: 1,
        take: 1,
        _count: true,
        _sum: { views: true },
      });

      expect(result._count).toBe(1);
      expect(result._sum.views).toBe(200);
    });
  });

  describe("groupBy", () => {
    test("groups by single field", async () => {
      const { alice, bob } = await createStandardUserPostUsers(client);
      await createStandardUserPostPosts(client, alice.id);
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
      const { alice } = await createStandardUserPostUsers(client);
      await createStandardUserPostPosts(client, alice.id);

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
      const { alice } = await createStandardUserPostUsers(client);

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

    test("rejects empty where before preparing operation", () => {
      expect(() => {
        client.user.upsert({
          // @ts-expect-error runtime guard covers invalid empty unique selector
          where: {},
          create: {
            id: "user-new",
            name: "New User",
            email: "new@test.com",
          },
          update: { name: "Updated User" },
        });
      }).toThrow(ValidationError);
    });
  });

  describe("exist", () => {
    test("returns true when record exists", async () => {
      await createStandardUserPostUsers(client);
      const result = await client.user.exist({ where: { name: "Alice" } });
      expect(result).toBe(true);
    });

    test("returns false when record does not exist", async () => {
      await createStandardUserPostUsers(client);
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
      await createStandardUserPostUsers(client);

      const result = await client.$executeRaw<{ name: string }>(
        sql`SELECT "name" FROM "user" WHERE "name" = ${"Alice"}`
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0]?.name).toBe("Alice");
    });

    test("returns rowCount for mutations", async () => {
      await createStandardUserPostUsers(client);

      const result = await client.$executeRaw(
        sql`UPDATE "user" SET "age" = ${99} WHERE "age" IS NOT NULL`
      );

      expect(result.rowCount).toBe(2); // Alice and Bob
    });
  });

  describe("$queryRaw", () => {
    test("executes raw SQL string with params", async () => {
      await createStandardUserPostUsers(client);

      const result = await client.$queryRaw<{ name: string }>(
        'SELECT "name" FROM "user" WHERE "age" >= $1',
        [25]
      );

      expect(result.rows.length).toBe(2); // Alice (30) and Bob (25)
    });

    test("returns all rows", async () => {
      await createStandardUserPostUsers(client);

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
    const { alice } = await createStandardUserPostUsers(client);
    await createStandardUserPostPosts(client, alice.id);

    const result = await client.user.findFirst({
      where: { id: alice.id },
      include: { posts: true },
    });

    expect(result?.posts.length).toBe(3);
  });

  test("includes to-one relation", async () => {
    const { alice } = await createStandardUserPostUsers(client);
    const { post1 } = await createStandardUserPostPosts(client, alice.id);

    const result = await client.post.findFirst({
      where: { id: post1.id },
      include: { author: true },
    });

    expect(result?.author.name).toBe("Alice");
  });

  test("filters by relation (some)", async () => {
    const { alice, bob } = await createStandardUserPostUsers(client);
    await createStandardUserPostPosts(client, alice.id);

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
    const { alice } = await createStandardUserPostUsers(client);
    await createStandardUserPostPosts(client, alice.id);

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
    const { alice } = await createStandardUserPostUsers(client);
    await createStandardUserPostPosts(client, alice.id);

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
