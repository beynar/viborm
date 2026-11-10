/**
 * pg Driver Tests - `viborm/on` on a real PostgreSQL server.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { PgDriver } from "@drivers/pg";
import { runOnBehavior } from "@tests/contracts/public-client/on-behavior";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  beforeEach(dropEveryLiveTable);
  // The provider files share one database: leave it as empty as it was found.
  afterAll(dropEveryLiveTable);

  runOnBehavior({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
