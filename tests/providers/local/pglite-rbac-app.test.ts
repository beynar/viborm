/**
 * PGlite Driver Tests — the RBAC acceptance estate (plan §6.1 U0, §7 "PGl"):
 * the §1.1 fixture pushed and seeded on embedded PostgreSQL, the hand-written
 * policy against the independent oracle.
 */

import { runRbacAppBehavior } from "@tests/contracts/public-client/rbac-app-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runRbacAppBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
