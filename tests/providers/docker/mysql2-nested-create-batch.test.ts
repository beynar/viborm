/**
 * mysql2 nested create batching (parity-17): a nested `create` list is one
 * grouped INSERT per child table, chunked at the driver's bind budget, on a
 * provider without RETURNING.
 *
 * Requires MYSQL_TEST_CONNECTION_STRING (see `mysql2-writes-raw.test.ts`).
 */

import { runNestedCreateBatchBehavior } from "@tests/contracts/engine/write/nested-create-batch-behavior";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("MySQL2 Driver", () => {
  beforeEach(dropEveryLiveTable);

  runNestedCreateBatchBehavior({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });
});
