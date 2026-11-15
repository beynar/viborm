/**
 * SQL Server: rows bound to the call (`rows` in a call's arguments). The
 * shared suite; set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { runBoundRowsBehavior } from "@tests/contracts/engine/query/bound-rows-behavior";
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

  runBoundRowsBehavior({
    name: "SQL Server",
    createDriver: createMssqlDriver,
    refusesRecursion: true,
  });
});
