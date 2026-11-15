/**
 * The driver contract suites on SQL Server (read-surface). Tables come from the
 * test-only T-SQL push (`tests/fixtures/mssql-schema.ts`): VibORM writes no
 * SQL Server DDL. Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { countAggregateWindowContract } from "@tests/contracts/drivers/behaviors/count-aggregate-window-behavior";
import { cursorPaginationContract } from "@tests/contracts/drivers/behaviors/cursor-pagination-behavior";
import { distinctSkipWindowContract } from "@tests/contracts/drivers/behaviors/distinct-skip-window-behavior";
import { fieldReferenceContract } from "@tests/contracts/drivers/behaviors/field-reference-behavior";
import { nestedOrderByContract } from "@tests/contracts/drivers/behaviors/nested-orderby-behavior";
import { nestedPaginationContract } from "@tests/contracts/drivers/behaviors/nested-pagination-behavior";
import { omitContract } from "@tests/contracts/drivers/behaviors/omit-behavior";
import { optionalRelationParityContract } from "@tests/contracts/drivers/behaviors/optional-relation-parity-behavior";
import { readPathRegressionContract } from "@tests/contracts/drivers/behaviors/read-path-regression-behavior";
import { relationReadAggregateContract } from "@tests/contracts/drivers/behaviors/relation-read-aggregate-behavior";
import { beforeEach, describe } from "vitest";
import {
  createMssqlDriver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("SQL Server Driver", () => {
  beforeEach(dropEveryLiveTable);

  readPathRegressionContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  relationReadAggregateContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  nestedOrderByContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  omitContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  countAggregateWindowContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  distinctSkipWindowContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  cursorPaginationContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  nestedPaginationContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  fieldReferenceContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  optionalRelationParityContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
});
