import { runRbacAdversarialBehavior } from "@tests/contracts/public-client/rbac-adversarial-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runRbacAdversarialBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
