/**
 * PGlite Driver Tests — the Permissions acceptance estate (plan §6.1 U0, §7 "PGl"):
 * the §1.1 fixture pushed and seeded on embedded PostgreSQL, the hand-written
 * policy against the independent oracle.
 */

import { runPermissionsAppBehavior } from "@tests/contracts/public-client/permissions-app-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runPermissionsAppBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
