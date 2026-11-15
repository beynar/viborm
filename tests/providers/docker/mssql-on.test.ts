/**
 * SQL Server: `viborm/on`: no RETURNING, so a write a hook concerns reads
 * its rows back the way a write with a `select` does. The shared suite; set
 * MSSQL_TEST_CONNECTION_STRING to run.
 */

import { runOnBehavior } from "@tests/contracts/public-client/on-behavior";
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

  runOnBehavior({ name: "SQL Server", createDriver: createMssqlDriver });
});
