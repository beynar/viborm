/**
 * D1 Driver Tests — K4 on the RBAC acceptance estate (plan §4.4, §7 "D1",
 * W-P1..W-P16): the row a write produces judged, in the statement that
 * writes it, against the independent oracle, under D1's own expression
 * depth, bind and statement limits, over the sampled actors. D1 has no
 * callback transaction: a probe that wrote is undone through the base
 * client, or by `restore` (every table emptied in one batch, foreign keys
 * deferred to its end, and the seed loaded again).
 *
 * A grant MOVE does not fit D1: its one statement judges `grants.place` on
 * the new row beside `grants.admin` on the old one, 261 KB at expression
 * depth 180 against D1's 100 KB and 100 (plan §8; reported under §9.3). D1
 * refuses the statement before it runs: QueryError, nothing written.
 */

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { loadRbacSeed } from "@tests/contracts/public-client/rbac-app-behavior";
import { runRbacAppPlacement } from "@tests/contracts/public-client/rbac-app-placement";
import { SAMPLED_ACTORS } from "@tests/contracts/public-client/rbac-sampled-actors";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const CREATE_TABLE = /^CREATE TABLE "([^"]+)"/;
const tables: string[] = [];

runRbacAppPlacement(
  {
    name: "D1",
    createDriver: () => new D1Driver({ database: env.DB }),
    prepare: async (client) => {
      const preview = await createMigrationClient(client).push({
        dryRun: true,
      });
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
    actors: SAMPLED_ACTORS,
    timeout: 1_800_000,
  },
  { oversizedGrantMoves: true }
);
