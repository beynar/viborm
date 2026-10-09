import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { sql } from "@sql";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";
import {
  AGGREGATE_PLAN_AUTHORS,
  AGGREGATE_PLAN_ROWS,
  aggregatePlanReads,
  aggregatePlanSchema,
} from "./aggregate-plan-fixtures";

/** A sort, a primary-key ordered scan or a derived table: none is needed. */
const WINDOWED = /\bSort\b|_pkey|Subquery Scan/;

test("unpaged count/aggregate/exist read the table itself, not a key-ordered window", async () => {
  const db = createClient({
    schema: aggregatePlanSchema,
    driver: new PGliteDriver({ client: openTestPGlite() }),
  });
  try {
    await syncLiveSchema(db);
    await db.$executeRaw(
      sql`INSERT INTO "author" ("email", "createdAt") SELECT 'a' || g || '@x.io', now() FROM generate_series(1, ${AGGREGATE_PLAN_AUTHORS}) g`
    );
    await db.$executeRaw(
      sql`INSERT INTO "post" ("title", "views", "authorId", "createdAt", "updatedAt") SELECT 't' || g, g, g % ${AGGREGATE_PLAN_AUTHORS} + 1, now(), now() FROM generate_series(1, ${AGGREGATE_PLAN_ROWS}) g`
    );
    await db.$executeRaw(sql`ANALYZE`);
    const reads = await aggregatePlanReads(db, async (statement) =>
      (
        await db.$queryRaw<{ "QUERY PLAN": string }>(sql`EXPLAIN ${statement}`)
      ).map((row) => row["QUERY PLAN"])
    );
    for (const { label, paged, value, expected, plans } of reads) {
      expect(value, label).toEqual(expected);
      expect(plans, label).toHaveLength(1);
      const plan = plans[0]!.join(" | ");
      // Control: a paged count still reads its ordered window.
      if (paged) expect(plan, label).toMatch(WINDOWED);
      else expect(plan, label).not.toMatch(WINDOWED);
    }
  } finally {
    await db.$disconnect();
  }
}, 60_000);
