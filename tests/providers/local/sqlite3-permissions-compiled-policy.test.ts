/**
 * The compiled §1.1 policy against the oracle on in-memory SQLite3 (plan §7
 * "S3": W-H1, W-A1..W-A6); see `permissions-compiled-policy-behavior.ts`.
 */

import { runCompiledPolicyBehavior } from "@tests/contracts/public-client/permissions-compiled-policy-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

runCompiledPolicyBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});
