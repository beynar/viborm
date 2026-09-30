/**
 * The `deletion` capability at every site the engine deletes (extension
 * capabilities plan v3.1 §2.3, Appendix deletion sites), on in-memory SQLite:
 * the interactive route, and the batch-only substrate where every referential
 * requirement is a premise of the atomic batch instead of a read. PGlite runs
 * the same behaviour in `tests/providers/local/pglite-deletion-capability.test.ts`.
 */

import { runDeletionCapabilityBehavior } from "@tests/contracts/engine/write/deletion-capability-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { createBatchOnlySQLite3Driver } from "@tests/providers/local/sqlite3-fixtures";
import { describe } from "vitest";

describe("the deletion capability's sites", () => {
  runDeletionCapabilityBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runDeletionCapabilityBehavior({
    name: "SQLite3 batch-only",
    createDriver: createBatchOnlySQLite3Driver,
  });
});
