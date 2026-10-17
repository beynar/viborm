/**
 * SQLite3 Driver Tests — the Permissions acceptance estate (plan §6.1 U0, §7 "S3"):
 * the §1.1 fixture pushed and seeded in memory, the hand-written policy
 * against the independent oracle, and the oracle's own sanity and witness
 * table, which need no database and run once, here.
 */

import { runPermissionsAppBehavior } from "@tests/contracts/public-client/permissions-app-behavior";
import { runPermissionsOracleChecks } from "@tests/contracts/public-client/permissions-app-oracle-checks";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runPermissionsOracleChecks();

runPermissionsAppBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
