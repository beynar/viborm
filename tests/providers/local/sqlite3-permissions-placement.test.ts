/**
 * SQLite3 Driver Tests — K4 on the Permissions acceptance estate (plan §4.4, §7
 * "S3", W-P1..W-P16): the row a write produces judged, in the statement that
 * writes it, against the independent oracle.
 */

import { runPermissionsAppPlacement } from "@tests/contracts/public-client/permissions-app-placement";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runPermissionsAppPlacement({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
