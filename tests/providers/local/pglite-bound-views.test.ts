/**
 * PGlite Driver Tests — bound views (Permissions plan K6, §7 "PGl" for W-AS1..W-AS7)
 * over the Permissions acceptance estate: `extension-bound-views-behavior.ts`, the
 * runner SQLite3 runs in `extension-bound-views.core.test.ts`, against the
 * independent oracle.
 */

import { withRows } from "@extensions/rows-runtime";
import { runBoundViewsBehavior } from "@tests/contracts/public-client/extension-bound-views-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

// The behavior applies bare object literals that declare `rows`.
withRows();

runBoundViewsBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
  timeout: 300_000,
});
