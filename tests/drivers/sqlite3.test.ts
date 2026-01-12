/**
 * SQLite3 Driver Tests
 *
 * Tests the better-sqlite3 driver implementation with a simple schema.
 */

import {
  createClient as SQLite3CreateClient,
  SQLite3Driver,
} from "@drivers/sqlite3";
import { push } from "@migrations";
import { s } from "@schema";

// =============================================================================
// SCHEMA DEFINITION
// =============================================================================

const user = s
  .model({
    id: s.string().id(),
    name: s.string().nullable(),
    email: s.string(),
    age: s.int().nullable(),
    posts: s.oneToMany(() => post),
  })
  .map("users");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    content: s.string().nullable(),
    published: s.boolean().default(false),
    authorId: s.string(),
    author: s
      .manyToOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("posts");

const schema = { user, post };

// =============================================================================
// HELPER: Setup database with raw SQL (for driver-level tests)
// =============================================================================

async function setupDatabaseRaw(driver: SQLite3Driver) {
  // Create tables with raw SQL (for testing driver directly without client)
  await driver.executeRaw(`
    CREATE TABLE IF NOT EXISTS "users" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "name" TEXT,
      "email" TEXT NOT NULL,
      "age" INTEGER
    )
  `);

  await driver.executeRaw(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "title" TEXT NOT NULL,
      "content" TEXT,
      "published" INTEGER NOT NULL DEFAULT 0,
      "authorId" TEXT NOT NULL,
      FOREIGN KEY ("authorId") REFERENCES "users"("id")
    )
  `);

  // Clean up any existing data
  await driver.executeRaw(`DELETE FROM "posts"`);
  await driver.executeRaw(`DELETE FROM "users"`);
}

// =============================================================================
// TESTS
// =============================================================================

describe("SQLite3 Driver", () => {
  describe("Driver Creation", () => {
    test("creates in-memory driver by default", async () => {
      const driver = new SQLite3Driver();
      expect(driver.dialect).toBe("sqlite");
      expect(driver.adapter).toBeDefined();
      await driver.disconnect();
    });

    test("creates driver with custom options", async () => {
      const driver = new SQLite3Driver({
        options: {
          filename: ":memory:",
          timeout: 10_000,
        },
      });
      expect(driver.dialect).toBe("sqlite");
      await driver.disconnect();
    });
  });

  describe("Raw SQL Execution", () => {
    let driver: SQLite3Driver;

    beforeEach(async () => {
      driver = new SQLite3Driver({
        options: { filename: ":memory:" },
      });
      await setupDatabaseRaw(driver);
    });

    afterEach(async () => {
      await driver.disconnect();
    });

    test("executes INSERT and returns row count", async () => {
      const result = await driver.executeRaw(
        `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
        ["user-1", "test@example.com", "Test User"]
      );
      expect(result.rowCount).toBe(1);
    });

    test("executes SELECT and returns rows", async () => {
      await driver.executeRaw(
        `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
        ["user-1", "test@example.com", "Test User"]
      );

      const result = await driver.executeRaw<{ id: string; email: string }>(
        `SELECT * FROM "users" WHERE "id" = ?`,
        ["user-1"]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.email).toBe("test@example.com");
    });

    test("executes UPDATE and returns affected count", async () => {
      await driver.executeRaw(
        `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
        ["user-1", "test@example.com", "Test User"]
      );

      const result = await driver.executeRaw(
        `UPDATE "users" SET "name" = ? WHERE "id" = ?`,
        ["Updated Name", "user-1"]
      );

      expect(result.rowCount).toBe(1);
    });

    test("executes DELETE and returns affected count", async () => {
      await driver.executeRaw(
        `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
        ["user-1", "test@example.com", "Test User"]
      );

      const result = await driver.executeRaw(
        `DELETE FROM "users" WHERE "id" = ?`,
        ["user-1"]
      );

      expect(result.rowCount).toBe(1);
    });
  });

  describe("Transactions", () => {
    let driver: SQLite3Driver;

    beforeEach(async () => {
      driver = new SQLite3Driver({
        options: { filename: ":memory:" },
      });
      await setupDatabaseRaw(driver);
    });

    afterEach(async () => {
      await driver.disconnect();
    });

    test("commits transaction on success", async () => {
      await driver.transaction(async (tx) => {
        await tx.executeRaw(
          `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
          ["user-1", "test@example.com", "Test User"]
        );
        await tx.executeRaw(
          `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
          ["user-2", "test2@example.com", "Test User 2"]
        );
      });

      const result = await driver.executeRaw<{ count: number }>(
        `SELECT COUNT(*) as count FROM "users"`
      );
      expect(result.rows[0]?.count).toBe(2);
    });

    test("rolls back transaction on error", async () => {
      await expect(
        driver.transaction(async (tx) => {
          await tx.executeRaw(
            `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
            ["user-1", "test@example.com", "Test User"]
          );
          throw new Error("Intentional error");
        })
      ).rejects.toThrow("Intentional error");

      const result = await driver.executeRaw<{ count: number }>(
        `SELECT COUNT(*) as count FROM "users"`
      );
      expect(result.rows[0]?.count).toBe(0);
    });

    test("supports nested transactions with savepoints", async () => {
      await driver.transaction(async (tx) => {
        await tx.executeRaw(
          `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
          ["user-1", "test@example.com", "Test User"]
        );

        // Nested transaction that fails
        await expect(
          tx.transaction(async (nestedTx) => {
            await nestedTx.executeRaw(
              `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
              ["user-2", "test2@example.com", "Test User 2"]
            );
            throw new Error("Nested error");
          })
        ).rejects.toThrow("Nested error");

        // First insert should still be there
      });

      const result = await driver.executeRaw<{ count: number }>(
        `SELECT COUNT(*) as count FROM "users"`
      );
      // Only user-1 should exist (user-2 was rolled back by nested transaction)
      expect(result.rows[0]?.count).toBe(1);
    });
  });

  describe("VibORM Client Integration", () => {
    test("creates client with schema", async () => {
      const client = SQLite3CreateClient({
        schema,
        options: { filename: ":memory:" },
      });

      expect(client.user).toBeDefined();
      expect(client.post).toBeDefined();
      expect(client.$driver).toBeDefined();
      expect(client.$driver.dialect).toBe("sqlite");

      await client.$disconnect();
    });

    test("performs CRUD operations via client", async () => {
      const client = SQLite3CreateClient({
        schema,
        options: { filename: ":memory:" },
      });

      // Push schema to create tables
      await push(client.$driver, schema, { force: true });

      // Create user
      const newUser = await client.user.create({
        data: {
          id: "user-123",
          email: "alice@example.com",
          name: "Alice",
          age: 30,
        },
      });

      expect(newUser.id).toBe("user-123");
      expect(newUser.email).toBe("alice@example.com");
      expect(newUser.name).toBe("Alice");

      // Create post for user
      const newPost = await client.post.create({
        data: {
          id: "post-456",
          title: "Hello World",
          content: "My first post!",
          published: true,
          authorId: newUser.id,
        },
      });

      expect(newPost.id).toBe("post-456");
      expect(newPost.authorId).toBe("user-123");

      // Find user with posts
      const userWithPosts = await client.user.findFirst({
        where: { id: "user-123" },
        include: { posts: true },
      });

      expect(userWithPosts?.posts).toHaveLength(1);
      expect(userWithPosts?.posts[0]?.title).toBe("Hello World");

      // Update user
      const updatedUser = await client.user.update({
        where: { id: "user-123" },
        data: { name: "Alice Updated" },
      });

      expect(updatedUser.name).toBe("Alice Updated");

      // Count users
      const count = await client.user.count({});
      expect(count).toBe(1);

      // Delete post then user
      await client.post.delete({ where: { id: "post-456" } });
      await client.user.delete({ where: { id: "user-123" } });

      const finalCount = await client.user.count({});
      expect(finalCount).toBe(0);

      await client.$disconnect();
    });

    test("performs transactions via client", async () => {
      const client = SQLite3CreateClient({
        schema,
        options: { filename: ":memory:" },
      });

      // Push schema to create tables
      await push(client.$driver, schema, { force: true });

      // Successful transaction
      await client.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            id: "tx-user-1",
            email: "tx@example.com",
            name: "Transaction User",
          },
        });

        await tx.post.create({
          data: {
            id: "tx-post-1",
            title: "Transaction Post",
            content: "Created in transaction",
            authorId: user.id,
          },
        });
      });

      const users = await client.user.findMany({});
      expect(users).toHaveLength(1);

      const posts = await client.post.findMany({});
      expect(posts).toHaveLength(1);

      await client.$disconnect();
    });

    test("rolls back failed transactions via client", async () => {
      const client = SQLite3CreateClient({
        schema,
        options: { filename: ":memory:" },
      });

      // Push schema to create tables
      await push(client.$driver, schema, { force: true });

      // Transaction that fails
      await expect(
        client.$transaction(async (tx) => {
          await tx.user.create({
            data: {
              id: "fail-user",
              email: "fail@example.com",
              name: "Will Fail",
            },
          });

          throw new Error("Transaction failed intentionally");
        })
      ).rejects.toThrow("Transaction failed intentionally");

      // User should not exist
      const users = await client.user.findMany({});
      expect(users).toHaveLength(0);

      await client.$disconnect();
    });
  });

  describe("Query Features", () => {
    let client: ReturnType<typeof SQLite3CreateClient<typeof schema>>;

    beforeEach(async () => {
      client = SQLite3CreateClient({
        schema,
        options: { filename: ":memory:" },
      });

      // Push schema to create tables
      await push(client.$driver, schema, { force: true });

      // Seed data
      await client.user.createMany({
        data: [
          { id: "u1", email: "alice@test.com", name: "Alice", age: 25 },
          { id: "u2", email: "bob@test.com", name: "Bob", age: 30 },
          { id: "u3", email: "charlie@test.com", name: "Charlie", age: 35 },
        ],
      });

      await client.post.createMany({
        data: [
          {
            id: "p1",
            title: "Post 1",
            content: "Content 1",
            published: true,
            authorId: "u1",
          },
          {
            id: "p2",
            title: "Post 2",
            content: "Content 2",
            published: false,
            authorId: "u1",
          },
          {
            id: "p3",
            title: "Post 3",
            content: "Content 3",
            published: true,
            authorId: "u2",
          },
        ],
      });
    });

    afterEach(async () => {
      await client.$disconnect();
    });

    test("findMany with where clause", async () => {
      const users = await client.user.findMany({
        where: { age: { gte: 30 } },
      });

      expect(users).toHaveLength(2);
      expect(users.map((u) => u.name).sort()).toEqual(["Bob", "Charlie"]);
    });

    test("findMany with orderBy", async () => {
      const users = await client.user.findMany({
        orderBy: { age: "desc" },
      });

      expect(users[0]?.name).toBe("Charlie");
      expect(users[2]?.name).toBe("Alice");
    });

    test("findMany with skip and take", async () => {
      const users = await client.user.findMany({
        orderBy: { age: "asc" },
        skip: 1,
        take: 1,
      });

      expect(users).toHaveLength(1);
      expect(users[0]?.name).toBe("Bob");
    });

    test("findMany with select", async () => {
      const users = await client.user.findMany({
        select: { id: true, email: true },
      });

      expect(users[0]).toHaveProperty("id");
      expect(users[0]).toHaveProperty("email");
      expect(users[0]).not.toHaveProperty("name");
      expect(users[0]).not.toHaveProperty("age");
    });

    test("findMany with include", async () => {
      const users = await client.user.findMany({
        where: { id: "u1" },
        include: { posts: true },
      });

      expect(users[0]?.posts).toHaveLength(2);
    });

    test("updateMany", async () => {
      const result = await client.user.updateMany({
        where: { age: { lt: 30 } },
        data: { name: "Young" },
      });

      expect(result.count).toBe(1);

      const updated = await client.user.findFirst({ where: { id: "u1" } });
      expect(updated?.name).toBe("Young");
    });

    test("deleteMany", async () => {
      // First delete posts to avoid FK constraint
      await client.post.deleteMany({ where: { authorId: "u3" } });

      const result = await client.user.deleteMany({
        where: { age: { gt: 30 } },
      });

      expect(result.count).toBe(1);

      const remaining = await client.user.count({});
      expect(remaining).toBe(2);
    });

    test("aggregate operations", async () => {
      const result = await client.user.aggregate({
        _count: { _all: true },
        _avg: { age: true },
        _min: { age: true },
        _max: { age: true },
        _sum: { age: true },
      });

      expect(result._count._all).toBe(3);
      expect(result._avg.age).toBe(30);
      expect(result._min.age).toBe(25);
      expect(result._max.age).toBe(35);
      expect(result._sum.age).toBe(90);
    });
  });
});
