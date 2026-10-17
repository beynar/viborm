/**
 * D1 Driver Tests — the Permissions acceptance estate (plan §6.1 U0, §7 "D1"): the
 * §1.1 fixture created from the SQLite plan `push` previews (D1 declares no
 * migration capability, so the statements are executed here), seeded, and
 * the hand-written policy against the independent oracle for a sample of
 * actors, under D1's own bind and statement limits. The plain-`where` page
 * and grant predicates bind 106 to 190 values, over D1's 100; equal values
 * bind once, numbered, so every statement fits and every pair must match
 * the oracle (plan Z2, K2(d), W-K2f).
 */

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { runPermissionsAppBehavior } from "@tests/contracts/public-client/permissions-app-behavior";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

runPermissionsAppBehavior({
  name: "D1",
  createDriver: () => new D1Driver({ database: env.DB }),
  prepare: async (client) => {
    const preview = await createMigrationClient(client).push({ dryRun: true });
    for (const statement of preview.statements) {
      await env.DB.prepare(statement.sql).run();
    }
  },
  actors: ["u01", "u05", "u22", "u46", "k05-documents-share", "k21-everything"],
});
