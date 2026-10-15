/**
 * PGlite Driver Tests — K4 on the RBAC acceptance estate (plan §4.4, §7
 * "PGl", W-P1..W-P16): the row a write produces judged, in the statement that
 * writes it, against the independent oracle.
 */

import { runRbacAppPlacement } from "@tests/contracts/public-client/rbac-app-placement";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runRbacAppPlacement({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
  timeout: 600_000,
});
