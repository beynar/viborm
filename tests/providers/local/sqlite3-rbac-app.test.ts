/**
 * SQLite3 Driver Tests — the RBAC acceptance estate (plan §6.1 U0, §7 "S3"):
 * the §1.1 fixture pushed and seeded in memory, the hand-written policy
 * against the independent oracle, and the oracle's own sanity and witness
 * table, which need no database and run once, here.
 */

import { runRbacAppBehavior } from "@tests/contracts/public-client/rbac-app-behavior";
import { runRbacOracleChecks } from "@tests/contracts/public-client/rbac-app-oracle-checks";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runRbacOracleChecks();

runRbacAppBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
