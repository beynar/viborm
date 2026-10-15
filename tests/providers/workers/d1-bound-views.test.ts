/**
 * D1 Driver Tests — bound views (RBAC plan K6, §7 "D1" for W-AS1..W-AS7)
 * over the RBAC acceptance estate: `extension-bound-views-behavior.ts`, the
 * runner SQLite3 runs in `extension-bound-views.core.test.ts`, against the
 * independent oracle. D1 declares no callback transaction: W-AS3 pins that a
 * bound view's interactive transaction is refused exactly as the base
 * client's is, and that its array transaction keeps the binding.
 */

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { runBoundViewsBehavior } from "@tests/contracts/public-client/extension-bound-views-behavior";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

runBoundViewsBehavior({
  name: "D1",
  createDriver: () => new D1Driver({ database: env.DB }),
  prepare: async (client) => {
    const preview = await createMigrationClient(client).push({ dryRun: true });
    for (const statement of preview.statements) {
      await env.DB.prepare(statement.sql).run();
    }
  },
  callbackTransactions: false,
  timeout: 600_000,
});
