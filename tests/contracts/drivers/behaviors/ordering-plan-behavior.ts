import { defineContract } from "@tests/contracts/contract";
/**
 * Ordering and cursor query-plan witnesses (query-performance plan, Phase 5).
 *
 * Most of these suites do not assert timings. They EXPLAIN the statement the
 * client actually emitted and assert the *plan shape*, which is what the phase
 * changes: a windowed read over an indexed NOT NULL column must walk the index
 * instead of sorting into a temporary B-tree, and a cursor over NOT NULL sort
 * columns must seek into the index instead of walking it under a filter.
 *
 * Why the plan and not the clock: a sort of 20 rows is fast whatever the plan,
 * so a timing assertion would only be honest at a volume that makes the suite
 * slow. The plan shape is the same evidence at 4,000 rows as at 100,000.
 *
 * The exception is the parity suite, which asserts row-for-row equality rather
 * than any plan: the two cursor spellings must page identically.
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

// Three sort columns over one row set, so a comparison between them isolates
// exactly one variable:
//
//   bucket  NOT NULL, duplicated  — takes the bare direction and the row-value
//                                   cursor; the duplicates force the identity
//                                   tie-breaker to decide page boundaries
//   mirror  nullable, never null  — identical values to `bucket`, but declared
//                                   nullable, so it keeps the null-guarded
//                                   predicate. This is the parity oracle: same
//                                   data, same order, the other spelling
//   optional nullable, with nulls — the placement is genuinely observable here
const orderRow = s
  .model({
    id: s.string().id(),
    bucket: s.int(),
    mirror: s.int().nullable(),
    optional: s.int().nullable(),
    label: s.string(),
  })
  .index(["bucket", "id"])
  .index(["mirror", "id"])
  .index(["optional", "id"])
  .map("order_plan_rows");

const orderPlanSchema = { orderRow };

type OrderPlanClient = VibORMClient<
  VibORMConfig & { schema: typeof orderPlanSchema; driver: AnyDriver }
>;

const ROW_COUNT = 4000;
/** Rows per distinct `bucket` value, so the tie-breaker decides boundaries. */
const GROUP_SIZE = 7;

/** The MySQL emulation spelling or the native one — either states a placement. */
const NULL_PLACEMENT_REGEX = /IS NULL|NULLS FIRST/;

/**
 * PostgreSQL's seek, stated about the OUTER relation and nothing else: the scan of
 * `t0` through the composite index must be bounded by a ROW-value index condition.
 *
 * Anchored to the line that follows the `t0` scan node because a bare
 * `toContain("Index Cond")` is satisfied by the cursor row's OWN primary-key
 * lookup — which both cursor spellings emit — and so held on the regressed plan
 * (`Nested Loop Semi Join` with the OR-of-ANDs in a `Join Filter` over a full
 * `Index Scan` of t0). Measured: with the SQL assertions disabled and the row-value
 * spelling forced off, the old plan assertions passed on both dialects.
 */
const PG_OUTER_ROW_VALUE_SEEK_REGEX =
  /Index Scan using order_plan_rows_bucket_id_idx on order_plan_rows t0[^\n]*\n\s*Index Cond: \(ROW\(/;

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
        data: Array.from({ length: ROW_COUNT }, (_, i) => {
          const bucket = Math.floor(i / GROUP_SIZE);
          return {
            id: `r${String(i).padStart(5, "0")}`,
            bucket,
            // Same values as `bucket`, and never null: the two columns differ
            // only in what the schema says about them.
            mirror: bucket,
            optional: i % 9 === 0 ? null : i,
            label: `label-${i}`,
          };
        }),
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

    // --- Unit 5.1 ----------------------------------------------------------

    test("an EXPLICIT non-default placement on a NOT NULL column is elided too", async () => {
      // The P2/P3/P5 review's blocking finding: the elision must not key on the
      // requested placement matching the dialect default. A NOT NULL column has
      // no nulls to place, so ANY requested placement is semantically inert —
      // and keeping it re-creates the headline PostgreSQL regression (Sort Key
      // instead of the index walk). This is the one shape no other test spells:
      // asc + nulls:'first' is the NON-default placement for ascending order.
      const { c, seqScanSetting } = await connect();
      if (dialect === "postgresql") {
        expect(seqScanSetting).toBe("on");
      }

      statements.length = 0;
      const page = await c.orderRow.findMany({
        orderBy: { bucket: { sort: "asc", nulls: "first" } },
        take: 20,
      });
      expect(page).toHaveLength(20);
      expect(page[0].bucket).toBe(0);

      expect(statements).toHaveLength(1);
      const emitted = statements[0]!.sql;
      expect(emitted).not.toContain("IS NULL");
      expect(emitted).not.toContain("NULLS FIRST");
      expect(emitted).not.toContain("NULLS LAST");

      const plan = await explainOnlyStatement();
      expect(plan).toContain("order_plan_rows_bucket_id_idx");
      if (dialect === "postgresql") {
        expect(plan).not.toContain("Sort Key");
      }
    }, 120_000);

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
      expect(page[0].id).toBe("r00000");

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

    // --- Unit 5.2 ----------------------------------------------------------

    test("a cursor over NOT NULL sort columns seeks into the index", async () => {
      const { c, seqScanSetting } = await connect();
      if (dialect === "postgresql") {
        expect(seqScanSetting).toBe("on");
      }

      // Page from deep in the order, where a walk-and-filter would have to
      // cross everything before it and a seek does not.
      const deep = `r0${String(ROW_COUNT - 200).padStart(4, "0")}`;
      statements.length = 0;
      const page = await c.orderRow.findMany({
        cursor: { id: deep },
        orderBy: { bucket: "asc" },
        take: 20,
      });
      expect(page).toHaveLength(20);
      expect(page[0].id).toBe(deep);

      expect(statements).toHaveLength(1);
      const emitted = statements[0]!.sql;
      expect(emitted).toContain(") >= (SELECT");
      expect(emitted).not.toContain("EXISTS");

      const plan = await explainOnlyStatement();
      // Every assertion below names the OUTER relation by its ALIAS, and each of
      // them names the composite index, so no separate "the index is in the plan"
      // line is needed. Both cursor spellings locate the cursor row by its own
      // primary key, and THAT lookup is a seek in both — an `Index Cond` on
      // PostgreSQL, a `SEARCH` on SQLite — so an assertion that does not say WHICH
      // relation seeks is satisfied by the walk-and-filter plan this unit replaced.
      if (dialect === "postgresql") {
        // The seek is a ROW-value bound on t0's index, not a join filter.
        expect(plan).toMatch(PG_OUTER_ROW_VALUE_SEEK_REGEX);
        // ...and the other relation — the cursor row, addressed by its primary
        // key, which the regex above says nothing about — is not scanned either.
        expect(plan).not.toContain("Seq Scan");
      } else {
        // SEARCH is a seek; SCAN is a walk.
        expect(plan).toContain(
          "SEARCH t0 USING INDEX order_plan_rows_bucket_id_idx ("
        );
        // The outer table must not ALSO appear as a walk — a plan can seek t0 once
        // and still cross it elsewhere. Spelled with the alias because SQLite
        // prints only aliases: the earlier `SCAN order_plan_rows` named a string
        // the planner never emits, so it could not have failed on any plan.
        expect(plan).not.toContain("SCAN t0");
      }
    }, 120_000);

    test("both cursor spellings page identically over duplicate sort keys", async () => {
      const { c } = await connect();

      // `bucket` and `mirror` hold the same values on every row. `bucket` is
      // NOT NULL so it takes the row-value comparison; `mirror` is declared
      // nullable so it keeps the null-guarded predicate that shipped before
      // this unit. Same data, same order, two spellings — so any disagreement
      // is the new spelling's fault.
      const pageThrough = async (field: "bucket" | "mirror") => {
        const pages: Array<Array<{ id: string; value: number }>> = [];
        let cursor: string | undefined;
        // Seven rows share each sort value, so a page of five never aligns
        // with a group boundary and the tie-breaker decides every page edge.
        for (let i = 0; i < 6; i++) {
          const page = await c.orderRow.findMany({
            orderBy: { [field]: "asc" },
            take: 5,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          });
          if (page.length === 0) {
            break;
          }
          pages.push(
            page.map((row: any) => ({ id: row.id, value: row[field] }))
          );
          cursor = page.at(-1).id;
        }
        return pages;
      };

      statements.length = 0;
      const notNullPages = await pageThrough("bucket");
      const rowValueSpellings = statements.filter((entry) =>
        entry.sql.includes(") >= (SELECT")
      ).length;

      statements.length = 0;
      const nullablePages = await pageThrough("mirror");
      const guardedSpellings = statements.filter((entry) =>
        entry.sql.includes("__viborm_cursor_0")
      ).length;

      // The two runs really did take the two different paths.
      expect(rowValueSpellings).toBeGreaterThan(0);
      expect(guardedSpellings).toBe(rowValueSpellings);

      expect(notNullPages).toHaveLength(6);
      expect(notNullPages.flat()).toHaveLength(30);
      expect(notNullPages).toEqual(nullablePages);
      // ...and the pages are a contiguous run of the total order, not a set
      // that merely happens to match between two identical bugs.
      expect(notNullPages.flat().map((row) => row.id)).toEqual(
        Array.from({ length: 30 }, (_, i) => `r${String(i).padStart(5, "0")}`)
      );
    }, 120_000);

    test("a descending cursor pages in the order an independent sort gives", async () => {
      const { c } = await connect();

      // `normalizeCursorOrder` appends the identity tie-breaker ascending, so
      // this is `bucket DESC, id ASC` — a mixed order, which no row value can
      // spell. The oracle is an independent JS sort of the same seed data, so
      // a gate that let the row-value spelling through here would be caught by
      // wrong rows rather than by a plan shape.
      const expected = Array.from({ length: ROW_COUNT }, (_, i) => ({
        id: `r${String(i).padStart(5, "0")}`,
        bucket: Math.floor(i / GROUP_SIZE),
      }))
        .sort((a, b) => b.bucket - a.bucket || a.id.localeCompare(b.id))
        .slice(0, 30)
        .map((row) => row.id);

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 6; i++) {
        const page = await c.orderRow.findMany({
          orderBy: { bucket: "desc" },
          take: 5,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        seen.push(...page.map((row: any) => row.id));
        cursor = page.at(-1).id;
      }

      expect(seen).toEqual(expected);
    }, 120_000);

    test("a cursor over a column holding nulls pages through them", async () => {
      const { c } = await connect();

      // `optional` really does hold nulls, and this places them first, so
      // every cursor in this run points at a row whose sort value IS null.
      // A row-value comparison would compare against a NULL row, yield NULL,
      // and return nothing — so the nullability half of the gate is
      // answerable in rows, not only in the spelling.
      const expected = Array.from({ length: ROW_COUNT }, (_, i) => ({
        id: `r${String(i).padStart(5, "0")}`,
        optional: i % 9 === 0 ? null : i,
      }))
        .sort(
          (a, b) =>
            Number(a.optional !== null) - Number(b.optional !== null) ||
            (a.optional ?? 0) - (b.optional ?? 0) ||
            a.id.localeCompare(b.id)
        )
        .slice(0, 30)
        .map((row) => row.id);

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 6; i++) {
        const page = await c.orderRow.findMany({
          orderBy: { optional: { sort: "asc", nulls: "first" } },
          take: 5,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        seen.push(...page.map((row: any) => row.id));
        cursor = page.at(-1).id;
      }

      expect(seen).toEqual(expected);
      // One in nine rows is null, so 30 rows do not reach the non-null
      // region: every row here, and so every cursor row, has a null sort
      // value. That is exactly what a row value cannot compare.
      expect(seen[0]).toBe("r00000");
      expect(seen[1]).toBe("r00009");
      expect(seen).toHaveLength(30);
    }, 120_000);

    test("a cursor that matches no row leaves an empty window", async () => {
      const { c } = await connect();

      const page = await c.orderRow.findMany({
        cursor: { id: "no-such-row" },
        orderBy: { bucket: "asc" },
        take: 5,
      });
      expect(page).toEqual([]);
    }, 120_000);
  });
}

export const orderingPlanContract = defineContract({
  id: "drivers.ordering-plan",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runOrderingPlanBehavior,
});
