/**
 * `viborm/rbac` itself on PGlite (plan §7 "PGl"): the entry against the
 * oracle (`rbac-entry-behavior.ts`) and the verbs witnesses re-run through
 * it (`rbac-app-verbs.ts`, `through: "entry"`).
 */

import { runRbacAppVerbs } from "@tests/contracts/public-client/rbac-app-verbs";
import { runRbacEntryBehavior } from "@tests/contracts/public-client/rbac-entry-behavior";
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
runRbacEntryBehavior({ ...substrate, timeout: 300_000 });
runRbacAppVerbs(substrate, { through: "entry" });
