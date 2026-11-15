/**
 * SQL Server: a nested `create` list written as one batch. The shared suite;
 * set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { runNestedCreateBatchBehavior } from "@tests/contracts/engine/write/nested-create-batch-behavior";
import {
  createMssqlDriver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("SQL Server Driver", () => {
  beforeEach(dropEveryLiveTable);
  // The provider files share one database: leave it as empty as it was found.
  afterAll(dropEveryLiveTable);

  runNestedCreateBatchBehavior({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
});
