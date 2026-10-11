/**
 * D1 Driver Tests — a scalar list bound as one parameter (engine-09). D1 binds
 * at most 100 values per statement, so before 1.2.0 a 101-member `in` was
 * already refused; the list is now one of them.
 */

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";
import { runBoundMemberListBehavior } from "@tests/contracts/engine/query/bound-member-list-behavior";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

runBoundMemberListBehavior({
  name: "D1",
  dialect: "sqlite",
  createDriver: () => new D1Driver({ database: env.DB }),
  rows: 2000,
  crossColumnOr: false,
  // What `push` creates on SQLite; D1 declares no migration capability.
  tables: [
    `CREATE TABLE "bml_orders" ("id" INTEGER NOT NULL PRIMARY KEY, "reference" TEXT NOT NULL UNIQUE, "note" TEXT, "priority" INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE "bml_codecs" ("id" BLOB NOT NULL PRIMARY KEY, "ref" BLOB NOT NULL UNIQUE, "big" INTEGER NOT NULL, "amount" INTEGER NOT NULL, "at" TEXT NOT NULL)`,
    `CREATE TABLE "bml_epochs" ("id" INTEGER NOT NULL PRIMARY KEY, "at" INTEGER NOT NULL)`,
  ],
});
