/**
 * PGlite Driver Tests — K3 on the Permissions acceptance estate (plan §4.3, §7
 * "PGl"): verbs and written fields judged against the independent oracle.
 */

import { runPermissionsAppVerbs } from "@tests/contracts/public-client/permissions-app-verbs";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runPermissionsAppVerbs({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
