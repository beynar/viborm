/**
 * `viborm/permissions` itself on in-memory SQLite3 (plan §7 "S3"): the entry's
 * filtering, refusals, answers and composition against the oracle
 * (`permissions-entry-behavior.ts`, raw SQL included), and the verbs witnesses
 * re-run through it (`permissions-app-verbs.ts`, `through: "entry"`).
 */

import { runPermissionsAppVerbs } from "@tests/contracts/public-client/permissions-app-verbs";
import { runPermissionsEntryBehavior } from "@tests/contracts/public-client/permissions-entry-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const substrate = {
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  prepare: async (client: Parameters<typeof syncLiveSchema>[0]) => {
    await syncLiveSchema(client);
  },
};

runPermissionsEntryBehavior({ ...substrate, raw: true });
runPermissionsAppVerbs(substrate, { through: "entry" });
