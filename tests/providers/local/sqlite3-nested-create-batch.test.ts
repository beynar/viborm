/**
 * SQLite3 nested create batching (parity-17): a nested `create` list is one
 * grouped INSERT per child table, chunked at the driver's bind budget.
 */

import { runNestedCreateBatchBehavior } from "@tests/contracts/engine/write/nested-create-batch-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

describe("SQLite3 Driver", () => {
  runNestedCreateBatchBehavior({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
});
