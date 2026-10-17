/**
 * `viborm/permissions` itself on PGlite (plan §7 "PGl"): the entry against the
 * oracle (`permissions-entry-behavior.ts`) and the verbs witnesses re-run through
 * it (`permissions-app-verbs.ts`, `through: "entry"`).
 */

import { runPermissionsAppVerbs } from "@tests/contracts/public-client/permissions-app-verbs";
import { runPermissionsEntryBehavior } from "@tests/contracts/public-client/permissions-entry-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const substrate = {
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  prepare: async (client: Parameters<typeof syncLiveSchema>[0]) => {
    await syncLiveSchema(client);
  },
};

// W-CAN6 asks every seeded row at every action: up to a minute a model here.
runPermissionsEntryBehavior({ ...substrate, timeout: 300_000 });
runPermissionsAppVerbs(substrate, { through: "entry" });
