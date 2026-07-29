/**
 * pg Driver Tests (node-postgres)
 *
 * Tests the pg driver implementation.
 * NOTE: These tests require a running PostgreSQL database.
 * Skip in CI unless PostgreSQL is available.
 */

import { VibORM } from "@client/client";
import { createClient as PgCreateClient, PgDriver } from "@drivers/pg";
import { UniqueConstraintError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { runBulkWriteBehavior } from "../query-engine-v2/bulk-write-behavior";
import { runCreateManyBehavior } from "../query-engine-v2/create-many-behavior";
import { runCreateNestedUpsertBehavior } from "../query-engine-v2/create-nested-upsert-behavior";
import { runExtendedWhereUniqueBehavior } from "../query-engine-v2/extended-where-unique-behavior";
import { runInverseToOneCreateBehavior } from "../query-engine-v2/inverse-to-one-create-behavior";
import { runDepthSeamBehavior } from "../query-engine-v2/depth-seam-behavior";
import { runJunctionCreateManyBehavior } from "../query-engine-v2/junction-create-many-behavior";
import { runLocatedParentRefBehavior } from "../query-engine-v2/located-parent-ref-behavior";
import { runNestedMutationBehavior } from "../query-engine-v2/nested-mutation-behavior";
import { runPostTransitionAdoptBehavior } from "../query-engine-v2/post-transition-adopt-behavior";
import { runReadBehavior } from "../query-engine-v2/read-behavior";
import { runToOneUpdateWhereBehavior } from "../query-engine-v2/to-one-update-where-behavior";
import { runUpdateFamilyBehavior } from "../query-engine-v2/update-family-behavior";
import { runUpdateNestedUpsertBehavior } from "../query-engine-v2/update-nested-upsert-behavior";
import { runUpsertFamilyBehavior } from "../query-engine-v2/upsert-family-behavior";
import {
  PgBatchForcedDriver,
  PgBeforeFirstBatchDriver,
  PgRacePlantingBatchDriver,
} from "./batch-forced-pg";
import { runBatchPrimaryKeyDataflowBehavior } from "./batch-primary-key-dataflow-behavior";
import { runBlobFilterBehavior } from "./blob-filter-behavior";
import { runBulkWriteLimitBehavior } from "./bulk-write-limit-behavior";
import { runClientRawBehavior } from "./client-raw-behavior";
import { runDecimalExactnessBehavior } from "./decimal-exactness-behavior";
import { runFieldReferenceBehavior } from "./field-reference-behavior";
import { runForwardFkOrderingBehavior } from "./forward-fk-ordering-behavior";
import { runJsonNullSentinelBehavior } from "./json-null-sentinel-behavior";
import { runListJsonFilterBehavior } from "./list-json-filter-behavior";
import { runM2mDeleteManyStalenessBehavior } from "./m2m-deletemany-staleness-behavior";
import { runNestedOrderByBehavior } from "./nested-orderby-behavior";
import { runNestedWriteAdvancedBehavior } from "./nested-write-advanced-behavior";
import { runNestedWriteBehavior } from "./nested-write-behavior";
import { runNestedWriteConcurrencyBehavior } from "./nested-write-concurrency-behavior";
import { runOmitBehavior } from "./omit-behavior";
import { runRelationReadAggregateBehavior } from "./relation-read-aggregate-behavior";
import {
  runFullScalarRoundtripBehavior,
  runScalarRoundtripBehavior,
} from "./scalar-roundtrip-behavior";
import { runUpsertAtomicityBehavior } from "./upsert-atomicity-behavior";
import { runVectorBehavior } from "./vector-behavior";

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
  .map("pg_test_users");

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
  .map("pg_test_posts");

const schema = { user, post };

// =============================================================================
// HELPER: Setup database using push() migration
// =============================================================================

async function setupDatabase(driver: PgDriver) {
  // Create a temporary client to use push() for migrations
  const tempClient = VibORM.create({
    schema,
    driver,
  });
  await push(tempClient, { force: true });

  // Clean up any existing data
  await driver._executeRaw(`DELETE FROM "pg_test_posts"`);
  await driver._executeRaw(`DELETE FROM "pg_test_users"`);
}

// =============================================================================
// TESTS
// =============================================================================

// Skip tests if no PostgreSQL connection is available
const TEST_CONNECTION_STRING = process.env.PG_TEST_CONNECTION_STRING;
const PGVECTOR_TEST_CONNECTION_STRING =
  process.env.PGVECTOR_TEST_CONNECTION_STRING;
const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

function requirePgvectorConnectionString(): string {
  if (!PGVECTOR_TEST_CONNECTION_STRING) {
    throw new Error("PGVECTOR_TEST_CONNECTION_STRING is required.");
  }
  return PGVECTOR_TEST_CONNECTION_STRING;
}

describeIf("pg Driver", () => {
  // The shared behavior suites and client-integration tests assume a fresh
  // database. PostgreSQL persists between tests, so drop everything first:
  // pushing an empty schema diffs to dropTable for every existing table.
  // (Same pattern as mysql2.test.ts.)
  beforeEach(async () => {
    const cleanupClient = PgCreateClient({
      schema: {},
      databaseUrl: TEST_CONNECTION_STRING,
    });
    await push(cleanupClient, { force: true });
    await cleanupClient.$disconnect();
  });

  describe("Driver Creation", () => {
    test("creates driver with connection string", async () => {
      const driver = new PgDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      });
      expect(driver.dialect).toBe("postgresql");
      expect(driver.adapter).toBeDefined();
      await driver.disconnect();
    });

    test("creates driver with options", async () => {
      // Parse connection string to get options
      const url = new URL(TEST_CONNECTION_STRING!);
      const driver = new PgDriver({
        options: {
          host: url.hostname,
          port: Number.parseInt(url.port, 10) || 5432,
          database: url.pathname.slice(1),
          user: url.username,
          password: url.password,
        },
      });
      expect(driver.dialect).toBe("postgresql");
      await driver.disconnect();
    });
  });

  test("attributes a sequential atomic-batch failure to its exact statement", async () => {
    const driver = new PgBatchForcedDriver({
      databaseUrl: TEST_CONNECTION_STRING,
    });
    await setupDatabase(driver);

    const error = await driver
      ._executeBatch([
        {
          sql: `INSERT INTO "pg_test_users" ("id", "email") VALUES ($1, $2)`,
          params: ["batch-user", "first@example.com"],
        },
        {
          sql: `INSERT INTO "pg_test_users" ("id", "email") VALUES ($1, $2)`,
          params: ["batch-user", "second@example.com"],
        },
      ])
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect(error.meta).toMatchObject({
      statementIndex: 1,
      table: "pg_test_users",
      constraint: "pg_test_users_pkey",
    });
    await driver.disconnect();
  });

  describe("Raw SQL Execution", () => {
    let driver: PgDriver;

    beforeEach(async () => {
      driver = new PgDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      });
      await setupDatabase(driver);
    });

    afterEach(async () => {
      await driver.disconnect();
    });

    test("executes INSERT and returns row count", async () => {
      const result = await driver._executeRaw(
        `INSERT INTO "pg_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
        ["user-1", "test@example.com", "Test User"]
      );
      expect(result.rowCount).toBe(1);
    });

    test("executes SELECT and returns rows", async () => {
      await driver._executeRaw(
        `INSERT INTO "pg_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
        ["user-1", "test@example.com", "Test User"]
      );

      const result = await driver._executeRaw<{ id: string; email: string }>(
        `SELECT * FROM "pg_test_users" WHERE "id" = $1`,
        ["user-1"]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.email).toBe("test@example.com");
    });

    test("executes UPDATE and returns affected count", async () => {
      await driver._executeRaw(
        `INSERT INTO "pg_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
        ["user-1", "test@example.com", "Test User"]
      );

      const result = await driver._executeRaw(
        `UPDATE "pg_test_users" SET "name" = $1 WHERE "id" = $2`,
        ["Updated Name", "user-1"]
      );

      expect(result.rowCount).toBe(1);
    });

    test("executes DELETE and returns affected count", async () => {
      await driver._executeRaw(
        `INSERT INTO "pg_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
        ["user-1", "test@example.com", "Test User"]
      );

      const result = await driver._executeRaw(
        `DELETE FROM "pg_test_users" WHERE "id" = $1`,
        ["user-1"]
      );

      expect(result.rowCount).toBe(1);
    });
  });

  describe("Transactions", () => {
    let driver: PgDriver;

    beforeEach(async () => {
      driver = new PgDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      });
      await setupDatabase(driver);
    });

    afterEach(async () => {
      await driver.disconnect();
    });

    test("commits transaction on success", async () => {
      await driver.withTransaction(async (txDriver) => {
        await txDriver._executeRaw(
          `INSERT INTO "pg_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
          ["user-1", "test@example.com", "Test User"]
        );
        await txDriver._executeRaw(
          `INSERT INTO "pg_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
          ["user-2", "test2@example.com", "Test User 2"]
        );
      });

      const result = await driver._executeRaw<{ count: string }>(
        `SELECT COUNT(*) as count FROM "pg_test_users"`
      );
      expect(Number.parseInt(result.rows[0]?.count ?? "0", 10)).toBe(2);
    });

    test("rolls back transaction on error", async () => {
      await expect(
        driver.withTransaction(async (txDriver) => {
          await txDriver._executeRaw(
            `INSERT INTO "pg_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
            ["user-1", "test@example.com", "Test User"]
          );
          throw new Error("Intentional error");
        })
      ).rejects.toThrow("Intentional error");

      const result = await driver._executeRaw<{ count: string }>(
        `SELECT COUNT(*) as count FROM "pg_test_users"`
      );
      expect(Number.parseInt(result.rows[0]?.count ?? "0", 10)).toBe(0);
    });

    test("supports nested transactions with savepoints", async () => {
      await driver.withTransaction(async (txDriver) => {
        await txDriver._executeRaw(
          `INSERT INTO "pg_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
          ["user-1", "test@example.com", "Test User"]
        );

        // Nested transaction that fails
        await expect(
          txDriver.withTransaction(async (nestedTxDriver) => {
            await nestedTxDriver._executeRaw(
              `INSERT INTO "pg_test_users" ("id", "email", "name") VALUES ($1, $2, $3)`,
              ["user-2", "test2@example.com", "Test User 2"]
            );
            throw new Error("Nested error");
          })
        ).rejects.toThrow("Nested error");

        // First insert should still be there
      });

      const result = await driver._executeRaw<{ count: string }>(
        `SELECT COUNT(*) as count FROM "pg_test_users"`
      );
      // Only user-1 should exist (user-2 was rolled back by nested transaction)
      expect(Number.parseInt(result.rows[0]?.count ?? "0", 10)).toBe(1);
    });

    test("rejects removed isolation before opening a transaction", async () => {
      let callbackCalled = false;
      await expect(
        Reflect.apply(driver.withTransaction, driver, [
          async () => {
            callbackCalled = true;
          },
          { isolationLevel: "serializable" },
        ])
      ).rejects.toMatchObject({ name: "TransactionError", code: "V5005" });
      expect(callbackCalled).toBe(false);
    });
  });

  describe("VibORM Client Integration", () => {
    test("creates client with schema", async () => {
      const client = await PgCreateClient({
        schema,
        databaseUrl: TEST_CONNECTION_STRING,
      });

      expect(client.user).toBeDefined();
      expect(client.post).toBeDefined();
      expect(client.$driver).toBeDefined();
      expect(client.$driver.dialect).toBe("postgresql");

      await client.$disconnect();
    });

    test("performs CRUD operations via client", async () => {
      const client = await PgCreateClient({
        schema,
        databaseUrl: TEST_CONNECTION_STRING,
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
      const client = await PgCreateClient({
        schema,
        databaseUrl: TEST_CONNECTION_STRING,
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

    test("rejects removed isolation at the client boundary", async () => {
      const client = await PgCreateClient({
        schema,
        databaseUrl: TEST_CONNECTION_STRING,
      });

      await push(client, { force: true });

      let callbackCalled = false;
      await expect(
        Reflect.apply(client.$transaction, client, [
          async () => {
            callbackCalled = true;
          },
          { isolationLevel: "serializable" },
        ])
      ).rejects.toMatchObject({ name: "TransactionError", code: "V5005" });
      expect(callbackCalled).toBe(false);

      await client.$disconnect();
    });
  });

  runForwardFkOrderingBehavior({
    driverName: "pg (tx)",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runForwardFkOrderingBehavior({
    driverName: "pg (batch)",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  // Real multi-connection driver: the concurrent upsert tests in this suite
  // genuinely race two transactions, unlike single-session PGlite.
  runUpsertAtomicityBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  // M8 (§7.4, D7): the write-race retry unified above selectMode. Two real
  // connections genuinely race; the batch-forced sibling exercises the PlannedMode
  // converge-on-rerun that batch-only drivers lacked. Only runnable with a real
  // multi-connection database, hence its home here.
  runNestedWriteConcurrencyBehavior({
    driverName: "pg",
    createTxDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
    createBatchDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
    createRacePlantingBatchDriver: ({ plant, onBatchError }) =>
      new PgRacePlantingBatchDriver(plant, onBatchError, {
        databaseUrl: TEST_CONNECTION_STRING,
      }),
  });

  // M9 (§9, §5.5 Rule 3): the filtered-M2M-deleteMany staleness guards close the
  // plan-time→execution window fail-closed. A member added on a real second
  // connection after the plan-time read aborts the guard (raceable); the retry
  // re-plans and converges. Docker-gated for the same reason as M8.
  runM2mDeleteManyStalenessBehavior({
    driverName: "pg",
    createTxDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
    createStalePlanBatchDriver: ({ beforeFirstBatch, onBatchError }) =>
      new PgBeforeFirstBatchDriver(beforeFirstBatch, onBatchError, {
        databaseUrl: TEST_CONNECTION_STRING,
      }),
  });

  // Real pg param serialization for native array columns (array_cat push etc.)
  runListJsonFilterBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runJsonNullSentinelBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  // Real Postgres, not PGlite: the server's own locale collation is what a
  // column-to-column text comparison is decided under.
  runFieldReferenceBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runScalarRoundtripBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runDecimalExactnessBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
    exactDecimal: true,
  });

  // Real pg param serialization for a LIST of bytea bind params
  runBlobFilterBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runFullScalarRoundtripBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  // Nested writes over real pooled connections (transactions span checkouts)
  runNestedWriteBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runNestedWriteAdvancedBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  // Raw-string $queryRaw params and sql`` rendering go through the real pg
  // wire protocol here ($n placeholders), unlike the PGlite in-memory run.
  runClientRawBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  // Relation _count / relation orderBy / every-none read filters over the
  // real driver (correlated-subquery results cross real result parsing).
  runRelationReadAggregateBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runNestedOrderByBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runOmitBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runCreateNestedUpsertBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runCreateNestedUpsertBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  // T4b CLASS III — the batch updated/generated-PK dataflow on the RETURNING/lastval
  // driver: updated-PK (compile-derived literal FK) and generated-PK (lastval batch-ref
  // store) both proven on a real Postgres atomic batch.
  runBatchPrimaryKeyDataflowBehavior({
    driverName: "pg batch-only",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runUpdateNestedUpsertBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runUpdateNestedUpsertBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runUpdateFamilyBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runUpdateFamilyBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runLocatedParentRefBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runLocatedParentRefBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runInverseToOneCreateBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runInverseToOneCreateBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runDepthSeamBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runDepthSeamBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runPostTransitionAdoptBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runPostTransitionAdoptBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runJunctionCreateManyBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runJunctionCreateManyBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runExtendedWhereUniqueBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runExtendedWhereUniqueBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runToOneUpdateWhereBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runToOneUpdateWhereBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runUpsertFamilyBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runUpsertFamilyBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runNestedMutationBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runNestedMutationBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runReadBehavior({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runBulkWriteBehavior({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runCreateManyBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runCreateManyBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  // Bulk-write `limit` IS wired here, unlike the adapter-level suites below:
  // its PostgreSQL form nests a bound `LIMIT` inside a subquery inside an
  // UPDATE's WHERE, after the SET's own bound values — a parameter ORDERING
  // this file's charter (param serialization on the real driver) covers and
  // PGlite's in-process binding does not fully stand in for.
  runBulkWriteLimitBehavior({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  // The remaining behavior suites are not wired here: they are adapter-level
  // and already run on PGlite, which shares the postgres adapter; this file
  // covers what depends on the real driver (param serialization, pooling,
  // transactions, races).
});

runVectorBehavior({
  driverName: "pg",
  enabled: Boolean(PGVECTOR_TEST_CONNECTION_STRING),
  createDriver: () =>
    new PgDriver({
      databaseUrl: requirePgvectorConnectionString(),
      pgvector: true,
    }),
});
