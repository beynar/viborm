import { getAdapterInternals } from "@adapters/adapter-internals";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { BunSQLiteDriver } from "@drivers/bun-sqlite";
import { D1Driver } from "@drivers/d1";
import { LibSQLDriver } from "@drivers/libsql";
import { SQLite3Driver } from "@drivers/sqlite3";
import { describe, expect, test } from "vitest";

const scratchDdl = (adapter: DatabaseAdapter): string[] =>
  getAdapterInternals(adapter)
    .batchRefs.setup("batch-1")
    .map((statement) => statement.toStatement());

const TEMP_SCRATCH =
  'CREATE TEMP TABLE IF NOT EXISTS "__viborm_batch_refs" ("batch_id" TEXT NOT NULL, "ref_key" TEXT NOT NULL, "ref_value" TEXT, PRIMARY KEY ("batch_id", "ref_key"))';
const MAIN_SCRATCH =
  'CREATE TABLE IF NOT EXISTS "__viborm_batch_refs" ("batch_id" TEXT NOT NULL, "ref_key" TEXT NOT NULL, "ref_value" TEXT, PRIMARY KEY ("batch_id", "ref_key"))';

describe("SQLite transport temporary objects", () => {
  // A local SQLite file must not gain a persistent engine table, so every
  // driver whose transport admits TEMP keeps the scratch there; D1's
  // authorizer refuses temporary objects, so D1 alone spells it in `main`
  // (live witness: tests/providers/workers/d1.test.ts).
  test.each([
    ["sqlite3", new SQLite3Driver(), TEMP_SCRATCH],
    ["libsql", new LibSQLDriver(), TEMP_SCRATCH],
    ["bun-sqlite", new BunSQLiteDriver(), TEMP_SCRATCH],
    ["d1", new D1Driver({ database: Object.create(null) }), MAIN_SCRATCH],
  ])("%s spells the batch reference scratch its transport admits", (_name, driver, ddl) => {
    expect(scratchDdl(driver.adapter)).toEqual([ddl]);
  });

  test("the adapter defaults to a transport that admits temporary objects", () => {
    expect(scratchDdl(new SQLiteAdapter())).toEqual([TEMP_SCRATCH]);
    expect(scratchDdl(new SQLiteAdapter({ temporaryObjects: false }))).toEqual([
      MAIN_SCRATCH,
    ]);
  });
});
