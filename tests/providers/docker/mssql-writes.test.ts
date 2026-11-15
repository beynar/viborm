/**
 * The driver contract suites on SQL Server (writes). Tables come from the
 * test-only T-SQL push (`tests/fixtures/mssql-schema.ts`): VibORM writes no
 * SQL Server DDL. Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { bulkWriteLimitContract } from "@tests/contracts/drivers/behaviors/bulk-write-limit-behavior";
import { clientRawContract } from "@tests/contracts/drivers/behaviors/client-raw-behavior";
import { createManyReturnFoldContract } from "@tests/contracts/drivers/behaviors/create-many-return-fold-behavior";
import { implicitReturningContract } from "@tests/contracts/drivers/behaviors/implicit-returning-behavior";
import { nestedWriteAdvancedContract } from "@tests/contracts/drivers/behaviors/nested-write-advanced-behavior";
import { nestedWriteContract } from "@tests/contracts/drivers/behaviors/nested-write-behavior";
import { nestedWriteConcurrencyContract } from "@tests/contracts/drivers/behaviors/nested-write-concurrency-behavior";
import { nestedWriteJsonEnvelopeContract } from "@tests/contracts/drivers/behaviors/nested-write-json-envelope-behavior";
import { rawArrayTransactionContract } from "@tests/contracts/drivers/behaviors/raw-array-transaction-behavior";
import { relationFilterMutationContract } from "@tests/contracts/drivers/behaviors/relation-filter-mutation-behavior";
import { upsertAtomicityContract } from "@tests/contracts/drivers/behaviors/upsert-atomicity-behavior";
import { beforeEach, describe } from "vitest";
import {
  createMssqlDriver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("SQL Server Driver", () => {
  beforeEach(dropEveryLiveTable);

  nestedWriteContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  nestedWriteAdvancedContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  nestedWriteJsonEnvelopeContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  createManyReturnFoldContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  bulkWriteLimitContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  upsertAtomicityContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  implicitReturningContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  relationFilterMutationContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  clientRawContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  rawArrayTransactionContract.register({
    name: "SQL Server",
    createDriver: createMssqlDriver,
  });
  nestedWriteConcurrencyContract.register({
    driverName: "mssql",
    createTxDriver: createMssqlDriver,
  });
});
