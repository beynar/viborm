/**
 * SQLite3 Driver Tests — K3 on the Permissions acceptance estate (plan §4.3, §7
 * "S3"): verbs and written fields judged against the independent oracle.
 */

import { runPermissionsAppVerbs } from "@tests/contracts/public-client/permissions-app-verbs";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runPermissionsAppVerbs({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
