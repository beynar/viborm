/**
 * `viborm/rbac` itself on in-memory SQLite3 (plan §7 "S3"): the entry's
 * filtering, refusals, answers and composition against the oracle
 * (`rbac-entry-behavior.ts`, raw SQL included), and the verbs witnesses
 * re-run through it (`rbac-app-verbs.ts`, `through: "entry"`).
 */

import { runRbacAppVerbs } from "@tests/contracts/public-client/rbac-app-verbs";
import { runRbacEntryBehavior } from "@tests/contracts/public-client/rbac-entry-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const substrate = {
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  prepare: async (client: Parameters<typeof syncLiveSchema>[0]) => {
    await syncLiveSchema(client);
  },
};

runRbacEntryBehavior({ ...substrate, raw: true });
runRbacAppVerbs(substrate, { through: "entry" });
