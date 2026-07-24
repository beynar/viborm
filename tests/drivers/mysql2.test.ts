/**
 * mysql2 Driver Tests
 *
 * NOTE: These tests require a running MySQL database (e.g. docker).
 * Set MYSQL_TEST_CONNECTION_STRING to enable, e.g.:
 *   docker run -d --name viborm-mysql -p 3307:3306 \
 *     -e MYSQL_ROOT_PASSWORD=password -e MYSQL_DATABASE=viborm mysql:8
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { push } from "@migrations";
import {
  EMPTY_ROW_RESULT_KEY,
  getAggregateResultKey,
  RELATION_COUNTS_RESULT_KEY,
  VECTOR_DISTANCE_RESULT_KEY,
} from "@query-engine/result-aliases";
import { s } from "@schema";
import { sql } from "@sql";
import { runBulkWriteBehavior } from "../query-engine-v2/bulk-write-behavior";
import { runCreateManyBehavior } from "../query-engine-v2/create-many-behavior";
import { runCreateNestedUpsertBehavior } from "../query-engine-v2/create-nested-upsert-behavior";
import { runNestedMutationBehavior } from "../query-engine-v2/nested-mutation-behavior";
import { runReadBehavior } from "../query-engine-v2/read-behavior";
import { runUpdateFamilyBehavior } from "../query-engine-v2/update-family-behavior";
import { runUpdateNestedUpsertBehavior } from "../query-engine-v2/update-nested-upsert-behavior";
import { runUpsertFamilyBehavior } from "../query-engine-v2/upsert-family-behavior";
import { MySQL2BatchForcedDriver } from "./batch-forced-mysql2";
import { runClientRawBehavior } from "./client-raw-behavior";
import { runCompoundKeyBehavior } from "./compound-key-behavior";
import { runCountAggregateWindowBehavior } from "./count-aggregate-window-behavior";
import { runCursorPaginationBehavior } from "./cursor-pagination-behavior";
import { runDistinctSkipWindowBehavior } from "./distinct-skip-window-behavior";
import { runForwardFkOrderingBehavior } from "./forward-fk-ordering-behavior";
import { runLikeEscapeBehavior } from "./like-escape-behavior";
import { runListJsonFilterBehavior } from "./list-json-filter-behavior";
import { runManyAndReturnBehavior } from "./many-and-return-behavior";
import { runManyToManyBehavior } from "./many-to-many-behavior";
import { runNestedOrderByBehavior } from "./nested-orderby-behavior";
import { runNestedWriteAdvancedBehavior } from "./nested-write-advanced-behavior";
import { runNestedWriteBehavior } from "./nested-write-behavior";
import { runNestedWriteConcurrencyBehavior } from "./nested-write-concurrency-behavior";
import { runNonReturningMutationAtomicityBehavior } from "./non-returning-mutation-atomicity-behavior";
import { runOptionalRelationParityBehavior } from "./optional-relation-parity-behavior";
import { runOrderingArrayCreateBehavior } from "./ordering-array-create-behavior";
import { runPrismaParityBehavior } from "./prisma-parity-behavior";
import { runReadPathRegressionBehavior } from "./read-path-regression-behavior";
import { runRelationFilterMutationBehavior } from "./relation-filter-mutation-behavior";
import { runRelationReadAggregateBehavior } from "./relation-read-aggregate-behavior";
import {
  runFullScalarRoundtripBehavior,
  runScalarRoundtripBehavior,
} from "./scalar-roundtrip-behavior";
import { runUpsertAtomicityBehavior } from "./upsert-atomicity-behavior";

const TEST_CONNECTION_STRING = process.env.MYSQL_TEST_CONNECTION_STRING;
const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

function createMySQL2Driver(): MySQL2Driver {
  return new MySQL2Driver({ databaseUrl: TEST_CONNECTION_STRING });
}

describeIf("MySQL2 Driver", () => {
  // The shared behavior suites assume a fresh database (the local drivers are
  // in-memory). MySQL persists between tests, so drop everything first:
  // pushing an empty schema diffs to dropTable for every existing table.
  beforeEach(async () => {
    const client = createClient({ schema: {}, driver: createMySQL2Driver() });
    await push(client, { force: true });
    await client.$disconnect();
  });

  test("creates driver with connection string", async () => {
    const driver = createMySQL2Driver();
    expect(driver.dialect).toBe("mysql");
    expect(driver.adapter).toBeDefined();
    await driver.disconnect();
  });

  test("preserves every private result alias exactly", async () => {
    const driver = createMySQL2Driver();
    const aliases = [
      COUNT_RESULT_KEY,
      VECTOR_DISTANCE_RESULT_KEY,
      RELATION_COUNTS_RESULT_KEY,
      EMPTY_ROW_RESULT_KEY,
      getAggregateResultKey("_count"),
      getAggregateResultKey("_avg"),
      getAggregateResultKey("_sum"),
      getAggregateResultKey("_min"),
      getAggregateResultKey("_max"),
    ];
    const projections = aliases.map((alias, index) =>
      driver.adapter.identifiers.aliased(sql.raw`${index + 1}`, alias)
    );

    try {
      const result = await driver._execute<Record<string, unknown>>(
        sql`SELECT ${sql.join(projections, ", ")}`
      );
      expect(Object.keys(result.rows[0] ?? {})).toEqual(aliases);
    } finally {
      await driver.disconnect();
    }
  });

  test("self-referencing tree deleteMany succeeds with default referential actions", async () => {
    const category = s
      .model({
        id: s.string().id(),
        name: s.string(),
        parentId: s.string().nullable(),
        parent: s
          .manyToOne(() => category)
          .fields("parentId")
          .references("id")
          .optional(),
        children: s.oneToMany(() => category),
      })
      .map("self_tree_categories");

    const client = createClient({
      schema: { category },
      driver: createMySQL2Driver(),
    });
    try {
      await push(client, { force: true });

      await client.category.create({
        data: { id: "root", name: "Root", parentId: null },
      });
      await client.category.create({
        data: { id: "child", name: "Child", parentId: "root" },
      });
      await client.category.create({
        data: { id: "grandchild", name: "Grandchild", parentId: "child" },
      });

      // InnoDB checks self-referencing FKs row-by-row, so this only works
      // because the nullable parent FK defaults to ON DELETE SET NULL
      // (Prisma parity) — with NO ACTION it throws ForeignKeyError here
      // while PG/SQLite (statement-end validation) succeed.
      const result = await client.category.deleteMany({});
      expect(result.count).toBe(3);
      expect(await client.category.findMany()).toHaveLength(0);
    } finally {
      await client.$disconnect();
    }
  });

  describe("$transaction portable option boundary", () => {
    const entry = s
      .model({
        id: s.string().id(),
        note: s.string(),
      })
      .map("isolation_entries");

    test("rejects removed isolation before the callback", async () => {
      const client = createClient({
        schema: { entry },
        driver: createMySQL2Driver(),
      });
      let callbackCalled = false;
      try {
        const transaction = client.$transaction;
        await expect(
          Reflect.apply(transaction, client, [
            async () => {
              callbackCalled = true;
            },
            { isolationLevel: "serializable" },
          ])
        ).rejects.toMatchObject({ name: "TransactionError", code: "V5005" });
        expect(callbackCalled).toBe(false);
      } finally {
        await client.$disconnect();
      }
    });
  });

  runOrderingArrayCreateBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runManyAndReturnBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runListJsonFilterBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runNestedWriteBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runNestedWriteAdvancedBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runCompoundKeyBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runReadPathRegressionBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runRelationReadAggregateBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });
  runNestedOrderByBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runClientRawBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runForwardFkOrderingBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runManyToManyBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runRelationFilterMutationBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runCountAggregateWindowBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runDistinctSkipWindowBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runCursorPaginationBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runScalarRoundtripBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runFullScalarRoundtripBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runPrismaParityBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runOptionalRelationParityBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runLikeEscapeBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  // Non-returning upserts use the locked interpreter branch path so branch
  // identity and result refetch stay on one transaction connection.
  runUpsertAtomicityBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runNonReturningMutationAtomicityBehavior(
    TEST_CONNECTION_STRING ?? "mysql://unconfigured.invalid/viborm"
  );

  // M8 (§7.4, D7): two real transaction-capable connections race. PlannedMode
  // real-race coverage stays on PostgreSQL because MySQL's public adapter is
  // non-returning and cannot roll public parsing back after a batch commits.
  runNestedWriteConcurrencyBehavior({
    driverName: "mysql2",
    createTxDriver: () =>
      new MySQL2Driver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runCreateNestedUpsertBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runCreateNestedUpsertBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });
  // T4b CLASS III boundary-stop — MySQL has no RETURNING, so a batch-only MySQL is a
  // non-returning atomic driver: V1 AND V2 refuse the single-row update/delete/upsert
  // refetch family before I/O (byte-identical `TransactionError`, routing.ts
  // `assertRoutedAtomicResolution`), so `runBatchPrimaryKeyDataflowBehavior`'s
  // updated-PK cases are not runnable here (the family is refused, not the CLASS III
  // dataflow specifically). MySQL certifies these mutations in TRANSACTION mode (the
  // MySQL2 transaction blocks above and the full estate). The RETURNING-capable
  // batch-only drivers (SQLite3, LibSQL, PGlite, Postgres) carry the batch dataflow.

  runUpdateNestedUpsertBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runUpdateNestedUpsertBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  runUpdateFamilyBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runUpdateFamilyBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  runUpsertFamilyBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runUpsertFamilyBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  runNestedMutationBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });
  runNestedMutationBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  // createMany on MySQL only in transaction mode: skipDuplicates uses the
  // savepoint effect (recoverableUniqueError strategy), which has no atomic-batch
  // lowering (the recorded batch disposition). MySQL always runs transactions in
  // production; the sql-strategy batch path is proven on PGlite/SQLite/LibSQL.
  runReadBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });
  runBulkWriteBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });
  runCreateManyBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });

  test("rejects artificial batch-only non-returning writes before provider access", async () => {
    const entry = s
      .model({
        id: s.string().id(),
        email: s.string().unique(),
      })
      .map("batch_only_nonreturn_entries");
    const client = createClient({
      schema: { entry },
      driver: new MySQL2BatchForcedDriver({
        databaseUrl: "mysql://invalid.invalid/viborm",
      }),
    });
    try {
      await expect(
        client.entry.upsert({
          where: { email: "entry@test.com" },
          create: { id: "entry", email: "entry@test.com" },
          update: { email: "entry@test.com" },
        })
      ).rejects.toThrow(
        "cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back after an atomic batch commits"
      );
    } finally {
      await client.$disconnect();
    }
  });

  // The batch-only suites (batch-primary-key-dataflow, batch-ref-smoke) are
  // not wired here: they need a batch-only driver subclass and MySQL2
  // exercises the transaction-based nested-write path instead.
});
