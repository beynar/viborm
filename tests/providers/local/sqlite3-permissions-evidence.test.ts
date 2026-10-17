/**
 * K5 against the oracle on in-memory SQLite3 (plan §7 "S3": W-EV1..W-EV4,
 * W-F1..W-F8); see `permissions-evidence-behavior.ts`.
 */

import { runPermissionsEvidenceBehavior } from "@tests/contracts/public-client/permissions-evidence-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runPermissionsEvidenceBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
