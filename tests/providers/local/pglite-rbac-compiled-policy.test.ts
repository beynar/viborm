/**
 * The compiled §1.1 policy against the oracle on embedded PostgreSQL (plan §7
 * "PGl": W-H1, W-A1..W-A6); see `rbac-compiled-policy-behavior.ts`.
 */

import { runCompiledPolicyBehavior } from "@tests/contracts/public-client/rbac-compiled-policy-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runCompiledPolicyBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
