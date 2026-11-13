/**
 * SQL Server: the `deletion` capability: tombstones written without
 * RETURNING. The shared suite; set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { runDeletionCapabilityBehavior } from "@tests/contracts/engine/write/deletion-capability-behavior";
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

  runDeletionCapabilityBehavior({
    name: "SQL Server",
    createDriver: createMssqlDriver,
    restrictedDelete: 4,
  });
});
