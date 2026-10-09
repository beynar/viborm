import { createClient } from "@drivers/sqlite3";
import { sql } from "@sql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";
import {
  AGGREGATE_PLAN_AUTHORS,
  AGGREGATE_PLAN_ROWS,
  aggregatePlanReads,
  aggregatePlanSchema,
} from "./aggregate-plan-fixtures";

const STAMP = "2026-01-01T00:00:00.000Z";
/**
 * The budget covers the per-statement DateTime storage scan every typed
 * SQLite statement still runs over all 100k rows (~20 s per read here); the
 * plans themselves take milliseconds.
 */
const BUDGET_MS = 240_000;
/** A derived table, a materialized subquery or a sort: none is needed. */
const WINDOWED = /CO-ROUTINE|MATERIALIZE|TEMP B-TREE/;

test(
  "unpaged count/aggregate/exist read the table itself, not a key-ordered window",
  async () => {
    const db = createClient({ schema: aggregatePlanSchema });
    try {
      await syncLiveSchema(db);
      await db.$executeRaw(
        sql`WITH RECURSIVE g(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM g WHERE x < ${AGGREGATE_PLAN_AUTHORS}) INSERT INTO "author" ("email", "createdAt") SELECT 'a' || x || '@x.io', ${STAMP} FROM g`
      );
      await db.$executeRaw(
        sql`WITH RECURSIVE g(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM g WHERE x < ${AGGREGATE_PLAN_ROWS}) INSERT INTO "post" ("title", "views", "authorId", "createdAt", "updatedAt") SELECT 't' || x, x, x % ${AGGREGATE_PLAN_AUTHORS} + 1, ${STAMP}, ${STAMP} FROM g`
      );
      const reads = await aggregatePlanReads(db, async (statement) =>
        (
          await db.$queryRaw<{ detail: string }>(
            sql`EXPLAIN QUERY PLAN ${statement}`
          )
        ).map((row) => row.detail)
      );
      for (const { label, paged, value, expected, plans } of reads) {
        expect(value, label).toEqual(expected);
        expect(plans, label).toHaveLength(1);
        const plan = plans[0]!.join(" | ");
        // Control: a paged count still reads its ordered window.
        if (paged) expect(plan, label).toMatch(WINDOWED);
        else expect(plan, label).not.toMatch(WINDOWED);
      }
      // The plain count keeps SQLite's btree count over the narrowest index.
      expect(reads[0]!.plans[0]!.join(" | ")).toContain("USING COVERING INDEX");
    } finally {
      await db.$disconnect();
    }
  },
  BUDGET_MS
);
