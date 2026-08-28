import { createClient } from "@client/client";
import { D1Driver } from "@drivers/d1";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { BatchQuery, QueryResult } from "@drivers/types";
import {
  FeatureNotSupportedError,
  ForeignKeyError,
  NotNullConstraintError,
  UniqueConstraintError,
} from "@errors";

import { s } from "@schema";
import { batchPrimaryKeyDataflowContract } from "@tests/contracts/drivers/behaviors/batch-primary-key-dataflow-behavior";
import { batchRefSmokeContract } from "@tests/contracts/drivers/behaviors/batch-ref-smoke-behavior";
import { blobFilterContract } from "@tests/contracts/drivers/behaviors/blob-filter-behavior";
import { bulkWriteLimitContract } from "@tests/contracts/drivers/behaviors/bulk-write-limit-behavior";
import { clientRawContract } from "@tests/contracts/drivers/behaviors/client-raw-behavior";
import { compoundJunctionContract } from "@tests/contracts/drivers/behaviors/compound-junction-behavior";
import { compoundKeyContract } from "@tests/contracts/drivers/behaviors/compound-key-behavior";
import { countAggregateWindowContract } from "@tests/contracts/drivers/behaviors/count-aggregate-window-behavior";
import { createManyReturnFoldContract } from "@tests/contracts/drivers/behaviors/create-many-return-fold-behavior";
import { cursorPaginationContract } from "@tests/contracts/drivers/behaviors/cursor-pagination-behavior";
import { decimalExactnessContract } from "@tests/contracts/drivers/behaviors/decimal-exactness-behavior";
import { distinctSkipWindowContract } from "@tests/contracts/drivers/behaviors/distinct-skip-window-behavior";
import { fieldReferenceContract } from "@tests/contracts/drivers/behaviors/field-reference-behavior";
import {
  fkIndexContract,
  fkIndexPlanContract,
  fkIndexUpgradeContract,
} from "@tests/contracts/drivers/behaviors/fk-index-behavior";
import { forwardFkOrderingContract } from "@tests/contracts/drivers/behaviors/forward-fk-ordering-behavior";
import { implicitReturningContract } from "@tests/contracts/drivers/behaviors/implicit-returning-behavior";
import {
  mappedIndexContract,
  partialIndexContract,
  partialIndexCoverageContract,
} from "@tests/contracts/drivers/behaviors/index-ddl-behavior";
import { jsonNullSentinelContract } from "@tests/contracts/drivers/behaviors/json-null-sentinel-behavior";
import { likeEscapeContract } from "@tests/contracts/drivers/behaviors/like-escape-behavior";
import { listJsonFilterContract } from "@tests/contracts/drivers/behaviors/list-json-filter-behavior";
import { manyToManyContract } from "@tests/contracts/drivers/behaviors/many-to-many-behavior";
import { nestedOrderByContract } from "@tests/contracts/drivers/behaviors/nested-orderby-behavior";
import { nestedPaginationContract } from "@tests/contracts/drivers/behaviors/nested-pagination-behavior";
import { nestedWriteAdvancedContract } from "@tests/contracts/drivers/behaviors/nested-write-advanced-behavior";
import { nestedWriteContract } from "@tests/contracts/drivers/behaviors/nested-write-behavior";
import { nestedWriteJsonEnvelopeContract } from "@tests/contracts/drivers/behaviors/nested-write-json-envelope-behavior";
import { omitContract } from "@tests/contracts/drivers/behaviors/omit-behavior";
import { optionalRelationParityContract } from "@tests/contracts/drivers/behaviors/optional-relation-parity-behavior";
import { orderingArrayCreateContract } from "@tests/contracts/drivers/behaviors/ordering-array-create-behavior";
import { orderingPlanContract } from "@tests/contracts/drivers/behaviors/ordering-plan-behavior";
import { polymorphicCollectionReadContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-read-behavior";
import { polymorphicCollectionWriteContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior";
import { polymorphicMemberJunctionContract } from "@tests/contracts/drivers/behaviors/polymorphic-member-junction-behavior";
import { polymorphicRelationContract } from "@tests/contracts/drivers/behaviors/polymorphic-relation-behavior";
import { prismaParityContract } from "@tests/contracts/drivers/behaviors/prisma-parity-behavior";
import { readPathRegressionContract } from "@tests/contracts/drivers/behaviors/read-path-regression-behavior";
import { relationFilterMutationContract } from "@tests/contracts/drivers/behaviors/relation-filter-mutation-behavior";
import { relationReadAggregateContract } from "@tests/contracts/drivers/behaviors/relation-read-aggregate-behavior";
import {
  fullScalarRoundtripContract,
  scalarRoundtripContract,
} from "@tests/contracts/drivers/behaviors/scalar-roundtrip-behavior";
import { upsertAtomicityContract } from "@tests/contracts/drivers/behaviors/upsert-atomicity-behavior";
import { runBooleanNoOpArmBehavior } from "@tests/contracts/engine/write/boolean-noop-arm-behavior";
import { runBulkWriteBehavior } from "@tests/contracts/engine/write/bulk-write-behavior";
import { runCreateManyBehavior } from "@tests/contracts/engine/write/create-many-behavior";
import { runCreateNestedUpsertBehavior } from "@tests/contracts/engine/write/create-nested-upsert-behavior";
import { runDepthSeamBehavior } from "@tests/contracts/engine/write/depth-seam-behavior";
import { runExtendedWhereUniqueBehavior } from "@tests/contracts/engine/write/extended-where-unique-behavior";
import { runInverseToOneCreateBehavior } from "@tests/contracts/engine/write/inverse-to-one-create-behavior";
import { runJunctionCreateManyBehavior } from "@tests/contracts/engine/write/junction-create-many-behavior";
import { runLocatedParentRefBehavior } from "@tests/contracts/engine/write/located-parent-ref-behavior";
import { runNestedMutationBehavior } from "@tests/contracts/engine/write/nested-mutation-behavior";
import { runOwnWriteLinearizationBehavior } from "@tests/contracts/engine/write/own-write-linearization-behavior";
import { runPostTransitionAdoptBehavior } from "@tests/contracts/engine/write/post-transition-adopt-behavior";
import { runProducedIdentityBehavior } from "@tests/contracts/engine/write/produced-identity-depth-behavior";
import { runReadBehavior } from "@tests/contracts/engine/write/read-behavior";
import { runToOneUpdateWhereBehavior } from "@tests/contracts/engine/write/to-one-update-where-behavior";
import { runUpdateFamilyBehavior } from "@tests/contracts/engine/write/update-family-behavior";
import { runUpdateNestedUpsertBehavior } from "@tests/contracts/engine/write/update-nested-upsert-behavior";
import { runUpsertFamilyBehavior } from "@tests/contracts/engine/write/upsert-family-behavior";
import { batchPrimaryKeyDataflowSchema } from "@tests/fixtures/batch-primary-key-dataflow-schema";
import {
  createInMemorySQLite3Driver,
  createSQLite3UserPostClient,
  setupSQLite3UserPostDatabase,
} from "@tests/fixtures/drivers/sqlite3";
import { seedWindowUserPosts } from "@tests/fixtures/user-post-seed";
import type Database from "better-sqlite3";
import { vi } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

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

  fkIndexContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  mappedIndexContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  partialIndexContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  partialIndexCoverageContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  fkIndexUpgradeContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  fkIndexPlanContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  orderingPlanContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });

  forwardFkOrderingContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
    fkNamesRoundTrip: false,
  });

  countAggregateWindowContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });

  distinctSkipWindowContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });

  cursorPaginationContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });

  nestedPaginationContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });

  omitContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });

  nestedWriteContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  nestedWriteAdvancedContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  nestedWriteJsonEnvelopeContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  compoundKeyContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  compoundJunctionContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  polymorphicMemberJunctionContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  manyToManyContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  relationFilterMutationContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  orderingArrayCreateContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  implicitReturningContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  createManyReturnFoldContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  bulkWriteLimitContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  listJsonFilterContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  jsonNullSentinelContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  readPathRegressionContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  relationReadAggregateContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  nestedOrderByContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  clientRawContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  scalarRoundtripContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  fullScalarRoundtripContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  decimalExactnessContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
    // SQLite-legal intersection: `precision + scale <= 18` (plan 3.1).
    descriptor: { precision: 16, scale: 2 },
  });
  likeEscapeContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  blobFilterContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });

  fieldReferenceContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  prismaParityContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });

  optionalRelationParityContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  polymorphicRelationContract.register({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  polymorphicCollectionReadContract.register({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  polymorphicCollectionWriteContract.register({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  upsertAtomicityContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  test("transactional nested update divides an integer PK and propagates it", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({
      schema: batchPrimaryKeyDataflowSchema,
      driver,
    });

    try {
      await syncLiveSchema(client);
      await client.mutableUser.create({
        data: { id: 330, name: "Divide operation" },
      });

      const updated = await client.mutableUser.update({
        where: { id: 330 },
        data: {
          id: { divide: 3 },
          name: "Divide operation updated",
          posts: { create: { title: "Divide operation child" } },
        },
      });

      const posts = await client.mutablePost.findMany();
      expect(updated.id).toBe(110);
      expect(posts).toHaveLength(1);
      expect(posts[0]?.userId).toBe(110);
    } finally {
      await client.$disconnect();
    }
  });
  batchPrimaryKeyDataflowContract.register({
    driverName: "SQLite3 batch-only",
    createDriver: createBatchOnlySQLite3Driver,
  });
  batchRefSmokeContract.register({
    driverName: "SQLite3 batch-only",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runCreateNestedUpsertBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runCreateNestedUpsertBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runUpdateNestedUpsertBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runUpdateNestedUpsertBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runUpdateFamilyBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runUpdateFamilyBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runLocatedParentRefBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runLocatedParentRefBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runInverseToOneCreateBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runInverseToOneCreateBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runDepthSeamBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runDepthSeamBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runProducedIdentityBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runProducedIdentityBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runOwnWriteLinearizationBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runOwnWriteLinearizationBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runBooleanNoOpArmBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runBooleanNoOpArmBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runPostTransitionAdoptBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runPostTransitionAdoptBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runJunctionCreateManyBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runJunctionCreateManyBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runExtendedWhereUniqueBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runExtendedWhereUniqueBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runToOneUpdateWhereBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runToOneUpdateWhereBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runUpsertFamilyBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runUpsertFamilyBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runNestedMutationBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runNestedMutationBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });

  runReadBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runBulkWriteBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runCreateManyBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runCreateManyBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
});
