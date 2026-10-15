/**
 * K5 against the oracle on embedded PostgreSQL (plan §7 "PGl": W-EV1..W-EV4,
 * W-F1..W-F8); see `rbac-evidence-behavior.ts`.
 */

import { runRbacEvidenceBehavior } from "@tests/contracts/public-client/rbac-evidence-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runRbacEvidenceBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
