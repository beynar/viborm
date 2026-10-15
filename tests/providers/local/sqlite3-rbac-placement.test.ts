/**
 * SQLite3 Driver Tests — K4 on the RBAC acceptance estate (plan §4.4, §7
 * "S3", W-P1..W-P16): the row a write produces judged, in the statement that
 * writes it, against the independent oracle.
 */

import { runRbacAppPlacement } from "@tests/contracts/public-client/rbac-app-placement";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runRbacAppPlacement({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
