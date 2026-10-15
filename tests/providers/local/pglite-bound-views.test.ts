/**
 * PGlite Driver Tests — bound views (RBAC plan K6, §7 "PGl" for W-AS1..W-AS7)
 * over the RBAC acceptance estate: `extension-bound-views-behavior.ts`, the
 * runner SQLite3 runs in `extension-bound-views.core.test.ts`, against the
 * independent oracle.
 */

import { runBoundViewsBehavior } from "@tests/contracts/public-client/extension-bound-views-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runBoundViewsBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
  timeout: 300_000,
});
