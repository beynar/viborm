import { runRbacAdversarialBehavior } from "@tests/contracts/public-client/rbac-adversarial-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runRbacAdversarialBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
