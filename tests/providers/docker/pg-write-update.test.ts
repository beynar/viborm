/**
 * pg Driver Tests - update family and extended whereUnique
 *
 * Engine write behaviors for extended whereUnique, the update family, nested
 * upserts on create and update, the batch primary-key dataflow, and the
 * boolean no-op arm.
 *
 * One program per file has to fit the 1280 MB TypeScript shard heap, and the
 * type inference a behavior module's schemas force is what that heap holds, so
 * this suite is split by schema across `pg*.test.ts`. Every piece keeps the
 * `pg Driver` describe and its drop-everything `beforeEach`, so test names and
 * per-test lifecycle are unchanged.
 *
 * NOTE: These tests require a running PostgreSQL database.
 * Skip in CI unless PostgreSQL is available.
 */

import { PgDriver } from "@drivers/pg";
import { batchPrimaryKeyDataflowContract } from "@tests/contracts/drivers/behaviors/batch-primary-key-dataflow-behavior";
import { runBooleanNoOpArmBehavior } from "@tests/contracts/engine/write/boolean-noop-arm-behavior";
import { runCreateNestedUpsertBehavior } from "@tests/contracts/engine/write/create-nested-upsert-behavior";
import { runExtendedWhereUniqueBehavior } from "@tests/contracts/engine/write/extended-where-unique-behavior";
import { runUpdateFamilyBehavior } from "@tests/contracts/engine/write/update-family-behavior";
import { runUpdateNestedUpsertBehavior } from "@tests/contracts/engine/write/update-nested-upsert-behavior";
import { PgBatchForcedDriver } from "@tests/fixtures/drivers/batch-forced-pg";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  // The shared behavior suites and client-integration tests assume a fresh
  // database. PostgreSQL persists between tests, so drop everything first:
  // pushing an empty schema diffs to dropTable for every existing table.
  // (Same pattern as mysql2.test.ts.)
  beforeEach(dropEveryLiveTable);

  runCreateNestedUpsertBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runCreateNestedUpsertBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  batchPrimaryKeyDataflowContract.register({
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

  runBooleanNoOpArmBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runBooleanNoOpArmBehavior({
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
});
