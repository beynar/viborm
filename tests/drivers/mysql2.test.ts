/**
 * mysql2 Driver Tests
 *
 * NOTE: These tests require a running MySQL database (e.g. docker).
 * Set MYSQL_TEST_CONNECTION_STRING to enable, e.g.:
 *   docker run -d --name viborm-mysql -p 3307:3306 \
 *     -e MYSQL_ROOT_PASSWORD=password -e MYSQL_DATABASE=viborm mysql:8
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { push } from "@migrations";
import { s } from "@schema";
import {
  MySQL2BatchForcedDriver,
  MySQL2RacePlantingBatchDriver,
} from "./batch-forced-mysql2";
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
import { runNestedWriteConcurrencyBehavior } from "./nested-write-concurrency-behavior";
import { runReadPathRegressionBehavior } from "./read-path-regression-behavior";
import { runRelationFilterMutationBehavior } from "./relation-filter-mutation-behavior";
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

  runScalarRoundtripBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runFullScalarRoundtripBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  // Default-mode equals is case-insensitive under MySQL's default CI
  // collations — pinned explicitly instead of omitting the suite.
  runPrismaParityBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
    caseInsensitiveDefaultEquals: true,
  });

  runOptionalRelationParityBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runLikeEscapeBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  // Plain upserts run natively as INSERT ... ON DUPLICATE KEY UPDATE with a
  // refetch; nested upserts exercise the transaction fallback and its
  // unique-race retry.
  runUpsertAtomicityBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  // M8 (§7.4, D7): the write-race retry unified above selectMode. Two real
  // connections race; the batch-forced sibling exercises the PlannedMode
  // converge-on-rerun (on MySQL the loser typically aborts with a gap-lock
  // deadlock, also a retryable signal). Needs a real multi-connection database.
  runNestedWriteConcurrencyBehavior({
    driverName: "mysql2",
    createTxDriver: () =>
      new MySQL2Driver({ databaseUrl: TEST_CONNECTION_STRING }),
    createBatchDriver: () =>
      new MySQL2BatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
    createRacePlantingBatchDriver: ({ plant, onBatchError }) =>
      new MySQL2RacePlantingBatchDriver(plant, onBatchError, {
        databaseUrl: TEST_CONNECTION_STRING,
      }),
  });

  // The batch-only suites (batch-primary-key-dataflow, batch-ref-smoke) are
  // not wired here: they need a batch-only driver subclass and MySQL2
  // exercises the transaction-based nested-write path instead.
});
