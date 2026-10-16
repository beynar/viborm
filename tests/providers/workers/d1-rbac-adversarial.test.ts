import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { runRbacAdversarialBehavior } from "@tests/contracts/public-client/rbac-adversarial-behavior";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

runRbacAdversarialBehavior({
  name: "D1",
  createDriver: () => new D1Driver({ database: env.DB }),
  prepare: async (client) => {
    const preview = await createMigrationClient(client).push({ dryRun: true });
    for (const statement of preview.statements)
      await env.DB.prepare(statement.sql).run();
  },
});
