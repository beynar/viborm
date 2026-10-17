/**
 * The compiled §1.1 policy against the oracle on embedded PostgreSQL (plan §7
 * "PGl": W-H1, W-A1..W-A6); see `permissions-compiled-policy-behavior.ts`.
 */

import { runCompiledPolicyBehavior } from "@tests/contracts/public-client/permissions-compiled-policy-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runCompiledPolicyBehavior({
  name: "PGlite",
  // The cap witness compares two policies across every actor and action.
  // Embedded PostgreSQL can exceed the ordinary 30s test limit on CI.
  timeout: 120_000,
  createDriver: createInMemoryPGliteDriver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
