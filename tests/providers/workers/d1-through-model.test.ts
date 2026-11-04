/**
 * D1 Driver Tests — a declared model as the junction, on a batch-only transport
 * (a write's statements ride one batch) with D1's depth and bind limits. Storage
 * is isolated per test, so each test pushes the fixture's tables again.
 */

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { runThroughModelGovernedBehavior } from "@tests/contracts/engine/query/through-model-governed-behavior";
import { runThroughModelBehavior } from "@tests/contracts/engine/write/through-model-behavior";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const prepare = async (client: never) => {
  const preview = await createMigrationClient(client).push({ dryRun: true });
  for (const statement of preview.statements)
    await env.DB.prepare(statement.sql).run();
};

runThroughModelBehavior({
  name: "D1",
  createDriver: () => new D1Driver({ database: env.DB }),
  prepare,
});
runThroughModelGovernedBehavior({
  name: "D1",
  createDriver: () => new D1Driver({ database: env.DB }),
  prepare,
});
