import { getAdapterInternals } from "@adapters/adapter-internals";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { describe, expect, test } from "vitest";

const scratchDdl = (adapter: SQLiteAdapter): string[] =>
  getAdapterInternals(adapter)
    .batchRefs.setup("batch-1")
    .map((statement) => statement.toStatement());

const COLUMNS =
  '"__viborm_batch_refs" ("batch_id" TEXT NOT NULL, "ref_key" TEXT NOT NULL, "ref_value" TEXT, PRIMARY KEY ("batch_id", "ref_key"))';

describe("SQLite batch reference scratch", () => {
  // The adapter spells the scratch from the transport's fact; which driver
  // states which fact is pinned in tests/contracts/drivers/sqlite-temporary-objects.core.test.ts.
  test("a transport that admits temporary objects keeps the scratch in TEMP", () => {
    expect(scratchDdl(new SQLiteAdapter())).toEqual([
      `CREATE TEMP TABLE IF NOT EXISTS ${COLUMNS}`,
    ]);
  });

  test("a transport without temporary objects spells an ordinary table", () => {
    expect(scratchDdl(new SQLiteAdapter({ temporaryObjects: false }))).toEqual([
      `CREATE TABLE IF NOT EXISTS ${COLUMNS}`,
    ]);
  });
});
