/**
 * D1 Driver Tests — K4, the produced row (rbac plan §4.4, R4, OD-13) on
 * Workers D1: a batch-only transport (a write's statements ride one batch;
 * a database-generated key reaches the rows after it through the batch
 * scratch) with D1's expression depth, bind and statement limits:
 * tests/contracts/engine/query/produced-row-behavior.ts. Storage is isolated
 * per test, so each test pushes the fixture's tables again.
 */

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { runProducedRowBehavior } from "@tests/contracts/engine/query/produced-row-behavior";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

runProducedRowBehavior({
  name: "D1",
  createDriver: () => new D1Driver({ database: env.DB }),
  prepare: async (client) => {
    const preview = await createMigrationClient(client).push({ dryRun: true });
    for (const statement of preview.statements)
      await env.DB.prepare(statement.sql).run();
  },
});
