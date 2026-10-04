/**
 * MySQL2 Driver Tests - the `deletion` capability (extension-capabilities
 * plan v3.1 §2.3) on MySQL: tombstones written without RETURNING, the
 * referential requirement, one instant per call, and `mode: "hard"`, the
 * behaviour SQLite3, batch-only SQLite3 and PGlite run.
 *
 * NOTE: These tests require a running MySQL database.
 */

import { runDeletionCapabilityBehavior } from "@tests/contracts/engine/write/deletion-capability-behavior";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("MySQL2 Driver", () => {
  beforeEach(dropEveryLiveTable);
  // The provider files share one database: leave it as empty as it was found.
  afterAll(dropEveryLiveTable);

  runDeletionCapabilityBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });
});
