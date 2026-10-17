/**
 * D1 Driver Tests — K3 on the Permissions acceptance estate (plan §4.3, §7 "D1"):
 * verbs and written fields judged against the independent oracle, under
 * D1's own bind and statement limits. D1 has no callback transaction to roll
 * a write probe back in, so each probe is followed by `restore`: every table
 * emptied in one batch (foreign keys deferred to its end) and the seed
 * loaded again.
 *
 * D1 compiles with an expression depth of 100 ("Expression tree is too
 * large"), and SQLite counts nested EXISTS about quadratically: W-W3's grant
 * updateMany needed 122, W-W7's nested create under a document 104. The D1
 * driver declares `deepExpressions: false`, so every relation filter reads
 * its rows from a derived table: 51 and 46 (SQLITE_LIMIT_EXPR_DEPTH), one
 * statement, the same plan.
 */

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { loadPermissionsSeed } from "@tests/contracts/public-client/permissions-app-behavior";
import { runPermissionsAppVerbs } from "@tests/contracts/public-client/permissions-app-verbs";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const CREATE_TABLE = /^CREATE TABLE "([^"]+)"/;
const tables: string[] = [];

runPermissionsAppVerbs({
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
    await loadPermissionsSeed(client);
  },
  timeout: 600_000,
});
