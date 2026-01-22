/**
 * postgres.js Driver Tests
 *
 * Tests the postgres.js driver implementation.
 * NOTE: These tests require a running PostgreSQL database.
 * Skip in CI unless PostgreSQL is available.
 */

import {
  createClient as PostgresCreateClient,
  PostgresDriver,
} from "@drivers/postgres";
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
  .map("postgresjs_test_users");

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
  .map("postgresjs_test_posts");

const schema = { user, post };

// =============================================================================
// HELPER: Setup database with raw SQL (for driver-level tests)
// =============================================================================

async function setupDatabaseRaw(driver: PostgresDriver) {
  // Create tables with raw SQL (for testing driver directly without client)
  await driver._executeRaw(`
    CREATE TABLE IF NOT EXISTS "postgresjs_test_users" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "name" TEXT,
      "email" TEXT NOT NULL,
      "age" INTEGER
    )
  `);

  await driver._executeRaw(`
    CREATE TABLE IF NOT EXISTS "postgresjs_test_posts" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "title" TEXT NOT NULL,
      "content" TEXT,
      "published" BOOLEAN NOT NULL DEFAULT FALSE,
      "authorId" TEXT NOT NULL,
      FOREIGN KEY ("authorId") REFERENCES "postgresjs_test_users"("id")
    )
  `);

  // Clean up any existing data
  await driver._executeRaw(`DELETE FROM "postgresjs_test_posts"`);
  await driver._executeRaw(`DELETE FROM "postgresjs_test_users"`);
}

// =============================================================================
// TESTS
// =============================================================================

// Skip tests if no PostgreSQL connection is available
const TEST_CONNECTION_STRING = process.env.PG_TEST_CONNECTION_STRING;
const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("postgres.js Driver", () => {
  describe("Driver Creation", () => {
    test("creates driver with connection string", async () => {
      const driver = new PostgresDriver({
        connectionString: TEST_CONNECTION_STRING,
      });
      expect(driver.dialect).toBe("postgresql");
      expect(driver.adapter).toBeDefined();
      await driver.disconnect();
    });

    test("creates driver with options", async () => {
      // Parse connection string to get options
      const url = new URL(TEST_CONNECTION_STRING!);
      const driver = new PostgresDriver({
        options: {
          host: url.hostname,
          port: Number.parseInt(url.port) || 5432,
          database: url.pathname.slice(1),
          username: url.username,
          password: url.password,
        },
      });
      expect(driver.dialect).toBe("postgresql");
      await driver.disconnect();
    });
  });

  describe("Raw SQL Execution", () => {
    let driver: PostgresDriver;

    beforeEach(async () => {
      driver = new PostgresDriver({
        connectionString: TEST_CONNECTION_STRING,
      });
      await setupDatabaseRaw(driver);
    });

    afterEach(async () => {
      await driver.disconnect();
    });

    test("executes INSERT and returns row count", async () => {
      const result = await driver._executeRaw(
        `INSERT INTO "postgresjs_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
        ["user-1", "test@example.com", "Test User"]
      );
      expect(result.rowCount).toBe(1);
    });

    test("executes SELECT and returns rows", async () => {
      await driver._executeRaw(
        `INSERT INTO "postgresjs_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
        ["user-1", "test@example.com", "Test User"]
      );

      const result = await driver._executeRaw<{ id: string; email: string }>(
        `SELECT * FROM "postgresjs_test_users" WHERE "id" = $1`,
        ["user-1"]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.email).toBe("test@example.com");
    });

    test("executes UPDATE and returns affected count", async () => {
      await driver._executeRaw(
        `INSERT INTO "postgresjs_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
        ["user-1", "test@example.com", "Test User"]
      );

      const result = await driver._executeRaw(
        `UPDATE "postgresjs_test_users" SET "name" = $1 WHERE "id" = $2`,
        ["Updated Name", "user-1"]
      );

      expect(result.rowCount).toBe(1);
    });

    test("executes DELETE and returns affected count", async () => {
      await driver._executeRaw(
        `INSERT INTO "postgresjs_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
        ["user-1", "test@example.com", "Test User"]
      );

      const result = await driver._executeRaw(
        `DELETE FROM "postgresjs_test_users" WHERE "id" = $1`,
        ["user-1"]
      );

      expect(result.rowCount).toBe(1);
    });
  });

  describe("Transactions", () => {
    let driver: PostgresDriver;

    beforeEach(async () => {
      driver = new PostgresDriver({
        connectionString: TEST_CONNECTION_STRING,
      });
      await setupDatabaseRaw(driver);
    });

    afterEach(async () => {
      await driver.disconnect();
    });

    test("commits transaction on success", async () => {
      await driver.withTransaction(async (txDriver) => {
        await txDriver._executeRaw(
          `INSERT INTO "postgresjs_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
          ["user-1", "test@example.com", "Test User"]
        );
        await txDriver._executeRaw(
          `INSERT INTO "postgresjs_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
          ["user-2", "test2@example.com", "Test User 2"]
        );
      });

      const result = await driver._executeRaw<{ count: string }>(
        `SELECT COUNT(*) as count FROM "postgresjs_test_users"`
      );
      expect(Number.parseInt(result.rows[0]?.count ?? "0")).toBe(2);
    });

    test("rolls back transaction on error", async () => {
      await expect(
        driver.withTransaction(async (txDriver) => {
          await txDriver._executeRaw(
            `INSERT INTO "postgresjs_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
            ["user-1", "test@example.com", "Test User"]
          );
          throw new Error("Intentional error");
        })
      ).rejects.toThrow("Intentional error");

      const result = await driver._executeRaw<{ count: string }>(
        `SELECT COUNT(*) as count FROM "postgresjs_test_users"`
      );
      expect(Number.parseInt(result.rows[0]?.count ?? "0")).toBe(0);
    });

    test("supports nested transactions with savepoints", async () => {
      await driver.withTransaction(async (txDriver) => {
        await txDriver._executeRaw(
          `INSERT INTO "postgresjs_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
          ["user-1", "test@example.com", "Test User"]
        );

        // Nested transaction that fails
        await expect(
          txDriver.withTransaction(async (nestedTxDriver) => {
            await nestedTxDriver._executeRaw(
              `INSERT INTO "postgresjs_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
              ["user-2", "test2@example.com", "Test User 2"]
            );
            throw new Error("Nested error");
          })
        ).rejects.toThrow("Nested error");

        // First insert should still be there
      });

      const result = await driver._executeRaw<{ count: string }>(
        `SELECT COUNT(*) as count FROM "postgresjs_test_users"`
      );
      // Only user-1 should exist (user-2 was rolled back by nested transaction)
      expect(Number.parseInt(result.rows[0]?.count ?? "0")).toBe(1);
    });

    test("supports isolation levels", async () => {
      await driver.withTransaction(
        async (txDriver) => {
          await txDriver._executeRaw(
            `INSERT INTO "postgresjs_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
            ["user-1", "test@example.com", "Test User"]
          );
        },
        { isolationLevel: "Serializable" }
      );

      const result = await driver._executeRaw<{ count: string }>(
        `SELECT COUNT(*) as count FROM "postgresjs_test_users"`
      );
      expect(Number.parseInt(result.rows[0]?.count ?? "0")).toBe(1);
    });
  });

  describe("VibORM Client Integration", () => {
    test("creates client with schema", async () => {
      const client = await PostgresCreateClient({
        schema,
        connectionString: TEST_CONNECTION_STRING,
      });

      expect(client.user).toBeDefined();
      expect(client.post).toBeDefined();
      expect(client.$driver).toBeDefined();
      expect(client.$driver.dialect).toBe("postgresql");

      await client.$disconnect();
    });

    test("performs CRUD operations via client", async () => {
      const client = await PostgresCreateClient({
        schema,
        connectionString: TEST_CONNECTION_STRING,
      });

      // Push schema to create tables
      await push(client, { force: true });

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
      const client = await PostgresCreateClient({
        schema,
        connectionString: TEST_CONNECTION_STRING,
      });

      // Push schema to create tables
      await push(client, { force: true });

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
  });
});
