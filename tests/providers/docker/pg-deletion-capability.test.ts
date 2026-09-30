/**
 * pg Driver Tests - the `deletion` capability (extension-capabilities plan
 * v3.1 §2.3) on a real PostgreSQL server: tombstones at every site core
 * deletes, the referential requirement, one instant per call, and
 * `mode: "hard"`, the behaviour SQLite3, batch-only SQLite3 and PGlite run.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { PgDriver } from "@drivers/pg";
import { runDeletionCapabilityBehavior } from "@tests/contracts/engine/write/deletion-capability-behavior";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  beforeEach(dropEveryLiveTable);

  runDeletionCapabilityBehavior({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
