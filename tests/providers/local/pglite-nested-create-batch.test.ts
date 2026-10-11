/**
 * PGlite nested create batching (parity-17): a nested `create` list is one
 * grouped INSERT per child table, chunked at the driver's bind budget.
 */

import { runNestedCreateBatchBehavior } from "@tests/contracts/engine/write/nested-create-batch-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  runNestedCreateBatchBehavior({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
});
