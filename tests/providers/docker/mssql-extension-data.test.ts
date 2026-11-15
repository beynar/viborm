/**
 * SQL Server: fields an extension writes, and stamped required fields. The
 * shared suite; set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { runExtensionDataBehavior } from "@tests/contracts/engine/write/extension-data-behavior";
import { runStampedRequiredBehavior } from "@tests/contracts/engine/write/stamped-required-behavior";
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

  runExtensionDataBehavior({
    name: "SQL Server",
    createDriver: createMssqlDriver,
  });
  runStampedRequiredBehavior({
    name: "SQL Server",
    createDriver: createMssqlDriver,
  });
});
