/**
 * Ordering and cursor query-plan witnesses (query-performance plan, Phase 5).
 *
 * These suites do not assert timings. They EXPLAIN the statement the client
 * actually emitted and assert the *plan shape*, which is what the phase
 * changes: a windowed read over an indexed NOT NULL column must walk the index
 * instead of sorting into a temporary B-tree.
 *
 * Why the plan and not the clock: a sort of 20 rows is fast whatever the plan,
 * so a timing assertion would only be honest at a volume that makes the suite
 * slow. The plan shape is the same evidence at 4,000 rows as at 100,000.
 */

import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, describe, expect, test } from "vitest";

// `bucket` is NOT NULL and `optional` is nullable, over the same row set and
// with the same composite index shape, so the two columns differ in exactly
// one property: whether a null placement is observable.
const orderRow = s
  .model({
    id: s.string().id(),
    bucket: s.int(),
    optional: s.int().nullable(),
    label: s.string(),
  })
  .index(["bucket", "id"])
  .index(["optional", "id"])
  .map("order_plan_rows");

const orderPlanSchema = { orderRow };

type OrderPlanClient = VibORMClient<
  VibORMConfig & { schema: typeof orderPlanSchema; driver: AnyDriver }
>;

const ROW_COUNT = 4000;

/** The MySQL emulation spelling or the native one — either states a placement. */
const NULL_PLACEMENT_REGEX = /IS NULL|NULLS FIRST/;

export interface OrderingPlanBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

export function runOrderingPlanBehavior({
  driverName,
  createDriver,
}: OrderingPlanBehaviorOptions) {
  describe(`${driverName} ordering query plan`, () => {
    let client: OrderPlanClient | undefined;
    let statements: Array<{ sql: string; params: unknown[] }> = [];
    let dialect = "";

    const connect = async () => {
      statements = [];
      const driver = createDriver();
      dialect = driver.dialect;
      client = createClient({
        schema: orderPlanSchema as never,
        driver,
        instrumentation: {
          logging: {
            query: (event) => {
              statements.push({
                sql: event.sql ?? "",
                params: event.params ?? [],
              });
            },
            includeSql: true,
            includeParams: true,
          },
        },
      }) as never;

      const c = client as OrderPlanClient as unknown as Record<string, any>;
      await push(client as never, { force: true });
      await c.orderRow.createMany({
        data: Array.from({ length: ROW_COUNT }, (_, i) => ({
          id: `r${String(i).padStart(5, "0")}`,
          bucket: i,
          optional: i % 9 === 0 ? null : i,
          label: `label-${i}`,
        })),
      });
      // Plan on real statistics, not on the empty-table defaults.
      await (client as OrderPlanClient).$executeRawUnsafe("ANALYZE");
      let seqScanSetting: string | undefined;
      if (dialect === "postgresql") {
        // PGlite ships with enable_seqscan=off, which would let the planner
        // take an index whatever it costs. Turn it back on so an index in the
        // plan means the index actually won on cost. The caller asserts the
        // setting took.
        await (client as OrderPlanClient).$executeRawUnsafe(
          "SET enable_seqscan = on"
        );
        const [setting] = await (client as OrderPlanClient).$queryRawUnsafe<{
          enable_seqscan: string;
        }>("SHOW enable_seqscan");
        seqScanSetting = setting?.enable_seqscan;
      }
      return { c, seqScanSetting };
    };

    /** EXPLAIN the one statement the client just emitted, with its own params. */
    const explainOnlyStatement = async (): Promise<string> => {
      const emitted = statements[0]!;
      const prefix =
        dialect === "postgresql" ? "EXPLAIN" : "EXPLAIN QUERY PLAN";
      const rows = await (client as OrderPlanClient).$queryRawUnsafe<
        Record<string, string>
      >(`${prefix} ${emitted.sql}`, ...emitted.params);
      return rows
        .map((row) =>
          dialect === "postgresql" ? row["QUERY PLAN"] : row.detail
        )
        .join("\n");
    };

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    test("a windowed order on a NOT NULL column walks the index", async () => {
      const { c, seqScanSetting } = await connect();
      if (dialect === "postgresql") {
        expect(seqScanSetting).toBe("on");
      }

      statements.length = 0;
      const page = await c.orderRow.findMany({
        orderBy: { bucket: "asc" },
        take: 20,
      });
      expect(page).toHaveLength(20);
      expect(page[0].bucket).toBe(0);
      expect(page[19].bucket).toBe(19);

      // One statement, and the placement key is gone from it: `bucket` and the
      // `id` tie-breaker are both NOT NULL, so neither carries one.
      expect(statements).toHaveLength(1);
      const emitted = statements[0]!.sql;
      expect(emitted).not.toContain("IS NULL");
      expect(emitted).not.toContain("NULLS FIRST");
      expect(emitted).not.toContain("NULLS LAST");

      const plan = await explainOnlyStatement();
      expect(plan).toContain("order_plan_rows_bucket_id_idx");
      // ...and the order comes off the index, not out of a sort.
      if (dialect === "postgresql") {
        expect(plan).not.toContain("Sort Key");
        expect(plan).not.toContain("Seq Scan");
      } else {
        // Not just "FOR ORDER BY": a placement that the index cannot supply
        // for the last key alone reports "FOR LAST TERM OF ORDER BY", which is
        // the same defect and must fail the same way.
        expect(plan).not.toContain("USE TEMP B-TREE");
      }
    }, 120_000);

    test("a nullable sort column keeps its placement and still orders correctly", async () => {
      const { c } = await connect();

      statements.length = 0;
      const nullsFirst = await c.orderRow.findMany({
        orderBy: { optional: { sort: "asc", nulls: "first" } },
        take: 5,
      });
      // The placement is observable here, so it is still stated.
      expect(statements[0]!.sql).toMatch(NULL_PLACEMENT_REGEX);
      expect(nullsFirst.every((row: any) => row.optional === null)).toBe(true);

      const nullsLast = await c.orderRow.findMany({
        orderBy: { optional: { sort: "asc", nulls: "last" } },
        take: 5,
      });
      expect(nullsLast.map((row: any) => row.optional)).toEqual([
        1, 2, 3, 4, 5,
      ]);
    }, 120_000);
  });
}
