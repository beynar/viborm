/**
 * SQL Server: `viborm/soft-delete` end to end. The shared suite; set
 * MSSQL_TEST_CONNECTION_STRING to run.
 */

import { runSoftDeleteBehavior } from "@tests/contracts/public-client/soft-delete-behavior";
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

  runSoftDeleteBehavior({
    name: "SQL Server",
    createDriver: createMssqlDriver,
    // A filtered unique index serves the partial-unique recipe; no ON
    // DELETE action on the self-reference (SQL Server refuses one there).
    heldSelfReference: true,
  });
});
