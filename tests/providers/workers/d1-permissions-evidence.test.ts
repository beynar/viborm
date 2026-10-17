/**
 * D1 Driver Tests — K5's evidence on D1 (plan §7 "D1": W-EV1..W-EV4) against
 * the oracle (`permissions-evidence-behavior.ts`) over the sampled actors, under
 * D1's own limits: 100 bound values, 100 KB of text and an expression depth
 * of 100 per statement. D1 has no callback transaction to roll a write probe
 * back in, so each probe is followed by `restore`: every table emptied in
 * one batch (foreign keys deferred to its end) and the seed loaded again.
 */

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { loadPermissionsSeed } from "@tests/contracts/public-client/permissions-app-behavior";
import { runPermissionsEvidenceBehavior } from "@tests/contracts/public-client/permissions-evidence-behavior";
import { SAMPLED_ACTORS } from "@tests/contracts/public-client/permissions-sampled-actors";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const CREATE_TABLE = /^CREATE TABLE "([^"]+)"/;
const tables: string[] = [];

runPermissionsEvidenceBehavior({
  name: "D1",
  createDriver: () => new D1Driver({ database: env.DB }),
  prepare: async (client) => {
    const preview = await createMigrationClient(client).push({ dryRun: true });
    for (const statement of preview.statements) {
      await env.DB.prepare(statement.sql).run();
      const table = CREATE_TABLE.exec(statement.sql)?.[1];
      if (table !== undefined && !tables.includes(table)) tables.push(table);
    }
  },
  restore: async (client) => {
    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
      ...tables.map((table) => env.DB.prepare(`DELETE FROM "${table}"`)),
    ]);
    await loadPermissionsSeed(client);
  },
  actors: SAMPLED_ACTORS,
  fields: false,
  timeout: 900_000,
});
