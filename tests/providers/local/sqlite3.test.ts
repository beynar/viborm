/**
 * SQLite3 provider boundary: driver creation, raw statement execution, transactions, error mapping, client integration, query features, and the GeoPoint storage tier.
 *
 * One file of the SQLite3 provider suite, which is split across sibling
 * `sqlite3-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./sqlite3-fixtures`, which Vitest does not collect.
 */

import { createClient } from "@client/client";
import { D1Driver } from "@drivers/d1";
import { SQLite3Driver } from "@drivers/sqlite3";
import {
  FeatureNotSupportedError,
  ForeignKeyError,
  NotNullConstraintError,
  UniqueConstraintError,
} from "@errors";
import { s } from "@schema";
import {
  geoPointBatchContract,
  geoPointContract,
} from "@tests/contracts/drivers/behaviors/geopoint-behavior";
import {
  createInMemorySQLite3Driver,
  createSQLite3UserPostClient,
  setupSQLite3UserPostDatabase,
} from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { seedWindowUserPosts } from "@tests/fixtures/user-post-seed";
import { vi } from "vitest";
import { createBatchOnlySQLite3Driver } from "./sqlite3-fixtures";

describe("SQLite3 Driver", () => {
  geoPointContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
    tier: "storage",
    rawSelectSql:
      'SELECT "location" FROM "geopoint_behavior_places" WHERE "id" = \'raw\'',
  });
  geoPointBatchContract.register({
    driverName: "SQLite3 forced native batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  describe("Vector Support", () => {
    test("throws FeatureNotSupported for vector distance orderBy", async () => {
      const schema = {
        doc: s.model({
          id: s.string().id(),
          embedding: s.vector().dimension(3),
        }),
      };
      const driver = createInMemorySQLite3Driver();
      const client = createClient({ schema, driver });

      try {
        await expect(
          client.doc.findMany({
            orderBy: {
              embedding: {
                _distance: {
                  to: [1, 0, 0],
                  metric: "l2",
                },
              },
            },
          })
        ).rejects.toThrow(FeatureNotSupportedError);
      } finally {
        await client.$disconnect();
      }
    });
  });
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

    test("does not treat an identifier containing returning as a row-producing statement", async () => {
      const result = await driver._executeRaw(
        `CREATE TABLE "returning_events" ("id" TEXT PRIMARY KEY)`
      );

      expect(result.rows).toEqual([]);
      expect(result.rowCount).toBe(0);
    });

    test("does not treat a comment containing returning as a row-producing statement", async () => {
      const result = await driver._executeRaw(
        `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?) /* returning is only a comment */`,
        ["comment-user", "comment@example.com", "Comment User"]
      );

      expect(result.rows).toEqual([]);
      expect(result.rowCount).toBe(1);
    });

    test("does not treat a string literal containing returning as a row-producing statement", async () => {
      const result = await driver._executeRaw(
        `INSERT INTO "users" ("id", "email", "name") VALUES ('literal-user', 'literal@example.com', 'contains returning text')`
      );

      expect(result.rows).toEqual([]);
      expect(result.rowCount).toBe(1);
    });

    test("returns rows for a genuine mutation RETURNING clause", async () => {
      const result = await driver._executeRaw<{
        id: string;
        email: string;
        name: string;
      }>(
        `INSERT INTO "users" ("id", "email", "name") VALUES (?, ?, ?) RETURNING "id", "email", "name"`,
        ["returned-user", "returned@example.com", "Returned User"]
      );

      expect(result.rows).toEqual([
        {
          id: "returned-user",
          email: "returned@example.com",
          name: "Returned User",
        },
      ]);
      expect(result.rowCount).toBe(1);
    });
  });
  describe("Worker-safe D1 binary parameters", () => {
    test("binds Uint8Array blobs when Buffer is unavailable", async () => {
      const boundValues: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          boundValues.push(...values);
          return statement;
        },
        async run() {
          return {
            success: true,
            results: [],
            meta: { changes: 1, last_row_id: 1 },
          };
        },
      };
      // This fake intentionally implements only the D1 surface exercised here.
      const database = {
        prepare() {
          return statement;
        },
      } as unknown as ConstructorParameters<typeof D1Driver>[0]["database"];
      const driver = new D1Driver({ database });
      const payload = new Uint8Array([1, 2, 3]);

      vi.stubGlobal("Buffer", undefined);
      try {
        await driver._executeRaw(`INSERT INTO "blobs" ("payload") VALUES (?)`, [
          payload,
        ]);
      } finally {
        vi.unstubAllGlobals();
        await driver.disconnect();
      }

      const [boundValue] = boundValues;
      if (boundValue instanceof Uint8Array) {
        expect(Object.getPrototypeOf(boundValue)).toBe(Uint8Array.prototype);
        expect(Array.from(boundValue)).toEqual([1, 2, 3]);
        return;
      }
      if (boundValue instanceof ArrayBuffer) {
        expect(Array.from(new Uint8Array(boundValue))).toEqual([1, 2, 3]);
        return;
      }
      throw new Error(
        "D1 blob parameters must remain Worker-compatible binary"
      );
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
      await syncLiveSchema(client);

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
      await syncLiveSchema(client);

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
      await syncLiveSchema(client);

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
      await syncLiveSchema(client);

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
      await syncLiveSchema(client);

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
});
