/**
 * mysql2 Driver Tests - nested writes, raw SQL and atomicity
 *
 * Nested-write contracts, the createMany return fold and bulk-write limit, raw
 * SQL over the client, and the upsert / non-returning atomicity boundaries.
 *
 * One program per file has to fit the 1280 MB TypeScript shard heap, and the
 * type inference a behavior module's schemas force is what that heap holds, so
 * this suite is split by schema across `mysql2*.test.ts`. Every piece keeps the
 * `MySQL2 Driver` describe and its drop-everything `beforeEach`, so test names
 * and per-test lifecycle are unchanged.
 *
 * NOTE: These tests require a running MySQL database (e.g. docker).
 * Set MYSQL_TEST_CONNECTION_STRING to enable, e.g.:
 *   docker run -d --name viborm-mysql -p 3307:3306 \
 *     -e MYSQL_ROOT_PASSWORD=password -e MYSQL_DATABASE=viborm mysql:8
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

import { bulkWriteLimitContract } from "@tests/contracts/drivers/behaviors/bulk-write-limit-behavior";
import { clientRawContract } from "@tests/contracts/drivers/behaviors/client-raw-behavior";
import { createManyReturnFoldContract } from "@tests/contracts/drivers/behaviors/create-many-return-fold-behavior";
import { nestedWriteAdvancedContract } from "@tests/contracts/drivers/behaviors/nested-write-advanced-behavior";
import { nestedWriteContract } from "@tests/contracts/drivers/behaviors/nested-write-behavior";
import { nestedWriteConcurrencyContract } from "@tests/contracts/drivers/behaviors/nested-write-concurrency-behavior";
import { nonReturningMutationAtomicityContract } from "@tests/contracts/drivers/behaviors/non-returning-mutation-atomicity-behavior";
import { rawArrayTransactionContract } from "@tests/contracts/drivers/behaviors/raw-array-transaction-behavior";
import { upsertAtomicityContract } from "@tests/contracts/drivers/behaviors/upsert-atomicity-behavior";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("MySQL2 Driver", () => {
  // The shared behavior suites assume a fresh database (the local drivers are
  // in-memory). MySQL persists between tests, so drop everything first:
  // pushing an empty schema diffs to dropTable for every existing table.
  beforeEach(dropEveryLiveTable);

  createManyReturnFoldContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  bulkWriteLimitContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  nestedWriteContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  nestedWriteAdvancedContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  clientRawContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  rawArrayTransactionContract.register({
    name: "Docker MySQL",
    createDriver: createMySQL2Driver,
  });

  // Non-returning upserts use the locked interpreter branch path so branch
  // identity and result refetch stay on one transaction connection.
  upsertAtomicityContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  nonReturningMutationAtomicityContract.register(
    TEST_CONNECTION_STRING ?? "mysql://unconfigured.invalid/viborm"
  );

  // M8 (§7.4, D7): two real transaction-capable connections race. PlannedMode
  // real-race coverage stays on PostgreSQL because MySQL's public adapter is
  // non-returning and cannot roll public parsing back after a batch commits.
  nestedWriteConcurrencyContract.register({
    driverName: "mysql2",
    createTxDriver: createMySQL2Driver,
  });
});
