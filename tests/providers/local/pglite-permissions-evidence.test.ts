/**
 * K5 against the oracle on embedded PostgreSQL (plan §7 "PGl": W-EV1..W-EV4,
 * W-F1..W-F8); see `permissions-evidence-behavior.ts`.
 */

import { runPermissionsEvidenceBehavior } from "@tests/contracts/public-client/permissions-evidence-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runPermissionsEvidenceBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
