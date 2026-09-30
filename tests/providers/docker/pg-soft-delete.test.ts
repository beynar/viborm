/**
 * pg Driver Tests - `viborm/soft-delete` (extension-capabilities plan v3.1
 * §1.1) on a real PostgreSQL server: the plan's use block end to end, the
 * partial-unique recipe included.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { PgDriver } from "@drivers/pg";
import { runSoftDeleteBehavior } from "@tests/contracts/public-client/soft-delete-behavior";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  beforeEach(dropEveryLiveTable);

  runSoftDeleteBehavior({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
