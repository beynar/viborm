/**
 * D1 Driver Tests — K3 on the RBAC acceptance estate (plan §4.3, §7 "D1"):
 * verbs and written fields judged against the independent oracle, under
 * D1's own bind and statement limits. D1 has no callback transaction to roll
 * a write probe back in, so each probe is followed by `restore`: every table
 * emptied in one batch (foreign keys deferred to its end) and the seed
 * loaded again.
 *
 * Open (2026-10-15): W-W3's grant updateMany and W-W7's nested create under
 * a document are refused by D1 with "Expression tree is too large (maximum
 * depth 100)": their statements need an expression depth of 122 and 104
 * (measured with SQLite's SQLITE_LIMIT_EXPR_DEPTH), from nested EXISTS, not
 * from flat AND/OR chains. A provider fact the plan's D1 budget (§8: binds
 * and bytes) does not yet name; the owner's decision.
 */

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { loadRbacSeed } from "@tests/contracts/public-client/rbac-app-behavior";
import { runRbacAppVerbs } from "@tests/contracts/public-client/rbac-app-verbs";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const CREATE_TABLE = /^CREATE TABLE "([^"]+)"/;
const tables: string[] = [];

runRbacAppVerbs({
  name: "D1",
  createDriver: () => new D1Driver({ database: env.DB }),
  prepare: async (client) => {
    const preview = await createMigrationClient(client).push({ dryRun: true });
    for (const statement of preview.statements) {
      await env.DB.prepare(statement.sql).run();
      const table = CREATE_TABLE.exec(statement.sql)?.[1];
      if (table !== undefined) tables.push(table);
    }
  },
  restore: async (client) => {
    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
      ...tables.map((table) => env.DB.prepare(`DELETE FROM "${table}"`)),
    ]);
    await loadRbacSeed(client);
  },
  timeout: 600_000,
});
