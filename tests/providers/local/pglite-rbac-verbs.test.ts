/**
 * PGlite Driver Tests — K3 on the RBAC acceptance estate (plan §4.3, §7
 * "PGl"): verbs and written fields judged against the independent oracle.
 */

import { runRbacAppVerbs } from "@tests/contracts/public-client/rbac-app-verbs";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runRbacAppVerbs({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
