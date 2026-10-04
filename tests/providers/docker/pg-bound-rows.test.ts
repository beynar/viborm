/**
 * pg Driver Tests - rows bound to the call (extension-capabilities plan v4
 * §2.1, §6 "Bound rows") on a real PostgreSQL server: the same behaviour
 * SQLite3, batch-only SQLite3, SQLite3 without RETURNING and PGlite run,
 * over the pg driver's own transport.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { PgDriver } from "@drivers/pg";
import { runBoundRowsBehavior } from "@tests/contracts/engine/query/bound-rows-behavior";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  beforeEach(dropEveryLiveTable);
  // The provider files share one database: leave it as empty as it was found.
  afterAll(dropEveryLiveTable);

  runBoundRowsBehavior({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
