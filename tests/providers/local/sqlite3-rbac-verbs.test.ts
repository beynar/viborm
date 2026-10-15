/**
 * SQLite3 Driver Tests — K3 on the RBAC acceptance estate (plan §4.3, §7
 * "S3"): verbs and written fields judged against the independent oracle.
 */

import { runRbacAppVerbs } from "@tests/contracts/public-client/rbac-app-verbs";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runRbacAppVerbs({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
