import { SQLite3Driver } from "@drivers/sqlite3";
import type { BatchQuery, QueryResult } from "@drivers/types";
import {
  ForeignKeyError,
  NotNullConstraintError,
  UniqueConstraintError,
} from "@errors";
import { push } from "@migrations";
import type Database from "better-sqlite3";
import {
  createInMemorySQLite3Driver,
  createSQLite3UserPostClient,
  setupSQLite3UserPostDatabase,
} from "../fixtures/drivers/sqlite3";
import { seedWindowUserPosts } from "../fixtures/user-post-seed";
import { runBatchPrimaryKeyDataflowBehavior } from "./batch-primary-key-dataflow-behavior";
import { runBatchRefSmokeBehavior } from "./batch-ref-smoke-behavior";
import { runCompoundKeyBehavior } from "./compound-key-behavior";
import { runCountAggregateWindowBehavior } from "./count-aggregate-window-behavior";
import { runDistinctSkipWindowBehavior } from "./distinct-skip-window-behavior";
import { runLikeEscapeBehavior } from "./like-escape-behavior";
import { runListJsonFilterBehavior } from "./list-json-filter-behavior";
import { runManyAndReturnBehavior } from "./many-and-return-behavior";
import { runManyToManyBehavior } from "./many-to-many-behavior";
import { runNestedWriteAdvancedBehavior } from "./nested-write-advanced-behavior";
import { runNestedWriteBehavior } from "./nested-write-behavior";
import { runOptionalRelationParityBehavior } from "./optional-relation-parity-behavior";
import { runOrderingArrayCreateBehavior } from "./ordering-array-create-behavior";
import { runPrismaParityBehavior } from "./prisma-parity-behavior";
import { runReadPathRegressionBehavior } from "./read-path-regression-behavior";
import { runRelationFilterMutationBehavior } from "./relation-filter-mutation-behavior";
import {
  runFullScalarRoundtripBehavior,
  runScalarRoundtripBehavior,
} from "./scalar-roundtrip-behavior";
import { runUpsertAtomicityBehavior } from "./upsert-atomicity-behavior";

class BatchOnlySQLite3Driver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}

function createBatchOnlySQLite3Driver(): SQLite3Driver {
  return new BatchOnlySQLite3Driver({
    dataDir: ":memory:",
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe("SQLite3 Driver", () => {
  describe("Driver Creation", () => {
    test("creates in-memory driver by default", async () => {
      const driver = createInMemorySQLite3Driver();
      expect(driver.dialect).toBe("sqlite");
      expect(driver.adapter).toBeDefined();
      await driver.disconnect();
    });

    test("creates driver with custom options", async () => {
      const driver = new SQLite3Driver({
        dataDir: ":memory:",
        options: { timeout: 10_000 },
      });
      expect(driver.dialect).toBe("sqlite");
      await driver.disconnect();
    });
  });

  describe("Raw SQL Execution", () => {
    let driver: SQLite3Driver;

    beforeEach(async () => {
      driver = createInMemorySQLite3Driver();
      await setupSQLite3UserPostDatabase(driver);
    });

    afterEach(async () => {
      await driver.disconnect();
    });

    test("executes INSERT and returns row count", async () => {
      const result = await driver._executeRaw(
        `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
        ["user-1", "test@example.com", "Test User"]
      );
      expect(result.rowCount).toBe(1);
    });

    test("executes SELECT and returns rows", async () => {
      await driver._executeRaw(
        `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
        ["user-1", "test@example.com", "Test User"]
      );

      const result = await driver._executeRaw<{ id: string; email: string }>(
        `SELECT * FROM "users" WHERE "id" = ?`,
        ["user-1"]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.email).toBe("test@example.com");
    });

    test("executes UPDATE and returns affected count", async () => {
      await driver._executeRaw(
        `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
        ["user-1", "test@example.com", "Test User"]
      );

      const result = await driver._executeRaw(
        `UPDATE "users" SET "name" = ? WHERE "id" = ?`,
        ["Updated Name", "user-1"]
      );

      expect(result.rowCount).toBe(1);
    });

    test("executes DELETE and returns affected count", async () => {
      await driver._executeRaw(
        `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
        ["user-1", "test@example.com", "Test User"]
      );

      const result = await driver._executeRaw(
        `DELETE FROM "users" WHERE "id" = ?`,
        ["user-1"]
      );

      expect(result.rowCount).toBe(1);
    });
  });

  describe("Transactions", () => {
    let driver: SQLite3Driver;

    beforeEach(async () => {
      driver = createInMemorySQLite3Driver();
      await setupSQLite3UserPostDatabase(driver);
    });

    afterEach(async () => {
      await driver.disconnect();
    });

    test("commits transaction on success", async () => {
      await driver.withTransaction(async (txDriver) => {
        await txDriver._executeRaw(
          `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
          ["user-1", "test@example.com", "Test User"]
        );
        await txDriver._executeRaw(
          `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
          ["user-2", "test2@example.com", "Test User 2"]
        );
      });

      const result = await driver._executeRaw<{ count: number }>(
        `SELECT COUNT(*) as count FROM "users"`
      );
      expect(result.rows[0]?.count).toBe(2);
    });

    test("rolls back transaction on error", async () => {
      await expect(
        driver.withTransaction(async (txDriver) => {
          await txDriver._executeRaw(
            `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
            ["user-1", "test@example.com", "Test User"]
          );
          throw new Error("Intentional error");
        })
      ).rejects.toThrow("Intentional error");

      const result = await driver._executeRaw<{ count: number }>(
        `SELECT COUNT(*) as count FROM "users"`
      );
      expect(result.rows[0]?.count).toBe(0);
    });

    test("supports nested transactions with savepoints", async () => {
      await driver.withTransaction(async (txDriver) => {
        await txDriver._executeRaw(
          `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
          ["user-1", "test@example.com", "Test User"]
        );

        // Nested transaction that fails
        await expect(
          txDriver.withTransaction(async (nestedTxDriver) => {
            await nestedTxDriver._executeRaw(
              `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?)`,
              ["user-2", "test2@example.com", "Test User 2"]
            );
            throw new Error("Nested error");
          })
        ).rejects.toThrow("Nested error");

        // First insert should still be there
      });

      const result = await driver._executeRaw<{ count: number }>(
        `SELECT COUNT(*) as count FROM "users"`
      );
      // Only user-1 should exist (user-2 was rolled back by nested transaction)
      expect(result.rows[0]?.count).toBe(1);
    });
  });

  describe("Error Mapping", () => {
    test("maps ORM unique constraint errors with model and operation context", async () => {
      const client = createSQLite3UserPostClient();
      await push(client, { force: true });

      await client.user.create({
        data: {
          id: "duplicate-id",
          email: "first@example.com",
        },
      });

      await expect(
        client.user.create({
          data: {
            id: "duplicate-id",
            email: "second@example.com",
          },
        })
      ).rejects.toMatchObject({
        name: "UniqueConstraintError",
        meta: {
          driver: "sqlite3",
          model: "user",
          operation: "create",
        },
      });

      await client.$disconnect();
    });

    test("maps raw not-null constraint errors", async () => {
      const driver = createInMemorySQLite3Driver();
      await setupSQLite3UserPostDatabase(driver);

      await expect(
        driver._executeRaw(`INSERT INTO "users" ("id") VALUES (?)`, [
          "missing-email",
        ])
      ).rejects.toBeInstanceOf(NotNullConstraintError);

      await driver.disconnect();
    });

    test("maps raw foreign key constraint errors", async () => {
      const driver = createInMemorySQLite3Driver();
      await setupSQLite3UserPostDatabase(driver);
      await driver._executeRaw("PRAGMA foreign_keys = ON");

      await expect(
        driver._executeRaw(
          `INSERT INTO "posts" ("id", "title", "authorId") VALUES (?, ?, ?)`,
          ["orphan-post", "Orphan", "missing-user"]
        )
      ).rejects.toBeInstanceOf(ForeignKeyError);

      await driver.disconnect();
    });

    test("maps raw unique constraint errors", async () => {
      const driver = createInMemorySQLite3Driver();
      await setupSQLite3UserPostDatabase(driver);

      await driver._executeRaw(
        `INSERT INTO "users" ("id", "email") VALUES (?, ?)`,
        ["raw-duplicate", "raw@example.com"]
      );

      await expect(
        driver._executeRaw(
          `INSERT INTO "users" ("id", "email") VALUES (?, ?)`,
          ["raw-duplicate", "other@example.com"]
        )
      ).rejects.toBeInstanceOf(UniqueConstraintError);

      await driver.disconnect();
    });
  });

  describe("VibORM Client Integration", () => {
    test("creates client with schema", async () => {
      const client = createSQLite3UserPostClient();

      expect(client.user).toBeDefined();
      expect(client.post).toBeDefined();
      expect(client.$driver).toBeDefined();
      expect(client.$driver.dialect).toBe("sqlite");

      await client.$disconnect();
    });

    test("performs CRUD operations via client", async () => {
      const client = createSQLite3UserPostClient();

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
      const client = createSQLite3UserPostClient();

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

    test("rolls back failed transactions via client", async () => {
      const client = createSQLite3UserPostClient();

      // Push schema to create tables
      await push(client, { force: true });

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
    let client: ReturnType<typeof createSQLite3UserPostClient>;

    beforeEach(async () => {
      client = createSQLite3UserPostClient();

      // Push schema to create tables
      await push(client, { force: true });

      // Seed data
      await seedWindowUserPosts(client);
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

  runCountAggregateWindowBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });

  runDistinctSkipWindowBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });

  runNestedWriteBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runNestedWriteAdvancedBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runCompoundKeyBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runManyToManyBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runRelationFilterMutationBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runOrderingArrayCreateBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runManyAndReturnBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runListJsonFilterBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runReadPathRegressionBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runScalarRoundtripBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runFullScalarRoundtripBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runLikeEscapeBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runPrismaParityBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });

  runOptionalRelationParityBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runUpsertAtomicityBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runBatchPrimaryKeyDataflowBehavior({
    driverName: "SQLite3 batch-only",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runBatchRefSmokeBehavior({
    driverName: "SQLite3 batch-only",
    createDriver: createBatchOnlySQLite3Driver,
  });
});
