/**
 * pg Driver Tests - fields an extension writes (extension-capabilities plan
 * v4 §2.2, §6 "Data") on a real PostgreSQL server: the same behaviour
 * SQLite3, batch-only SQLite3, SQLite3 without RETURNING and PGlite run,
 * over the pg driver's own transport.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { PgDriver } from "@drivers/pg";
import { runExtensionDataBehavior } from "@tests/contracts/engine/write/extension-data-behavior";
import { runStampedRequiredBehavior } from "@tests/contracts/engine/write/stamped-required-behavior";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  beforeEach(dropEveryLiveTable);

  runExtensionDataBehavior({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
  runStampedRequiredBehavior({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
