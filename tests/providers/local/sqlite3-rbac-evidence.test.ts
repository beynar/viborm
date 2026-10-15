/**
 * K5 against the oracle on in-memory SQLite3 (plan §7 "S3": W-EV1..W-EV4,
 * W-F1..W-F8); see `rbac-evidence-behavior.ts`.
 */

import { runRbacEvidenceBehavior } from "@tests/contracts/public-client/rbac-evidence-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runRbacEvidenceBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
