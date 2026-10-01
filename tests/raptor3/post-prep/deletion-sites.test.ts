/**
 * The `deletion` capability at every site the engine deletes (extension
 * capabilities plan v3.1 §2.3, Appendix deletion sites), on in-memory SQLite:
 * the interactive route, the batch-only substrate where every referential
 * requirement is a premise of the atomic batch instead of a read, and a driver
 * without RETURNING (MySQL's shape), where a root write reads its row back.
 * PGlite runs the same behaviour in
 * `tests/providers/local/pglite-deletion-capability.test.ts`.
 */

import { runDeletionCapabilityBehavior } from "@tests/contracts/engine/write/deletion-capability-behavior";
import { runExtensionDataBehavior } from "@tests/contracts/engine/write/extension-data-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import {
  createBatchOnlySQLite3Driver,
  createNonReturningSQLite3Driver,
} from "@tests/providers/local/sqlite3-fixtures";
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
  runDeletionCapabilityBehavior({
    name: "SQLite3 without RETURNING",
    createDriver: createNonReturningSQLite3Driver,
  });
});

describe("the data capability's sites", () => {
  runExtensionDataBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runExtensionDataBehavior({
    name: "SQLite3 batch-only",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runExtensionDataBehavior({
    name: "SQLite3 without RETURNING",
    createDriver: createNonReturningSQLite3Driver,
  });
});
