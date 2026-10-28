import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  mysqlPlan,
  type PlanNode,
  type PlanTree,
  postgresPlan,
  sqlitePlan,
  walk,
} from "../src/plan";
import { aliasesOf, schemasOf } from "../src/plan-catalog";

const FIXTURES = join(import.meta.dirname, "fixtures/plans");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const json = (name: string): unknown => JSON.parse(fixture(name));
type SqliteRow = Parameters<typeof sqlitePlan>[0][number];
/** SQLite's rows of a fixture: `EXPLAIN QUERY PLAN` as the driver hands it. */
const sqliteRows = (name: string): SqliteRow[] => JSON.parse(fixture(name));
const nodes = (tree: PlanTree) => [...walk(tree.root)];
const find = (tree: PlanTree, test: (node: PlanNode) => boolean) =>
  nodes(tree).find(test)!;

test("quoted catalog names preserve embedded identifier quotes", () => {
  const sql =
    'SELECT * FROM "tenant""east"."sales""2026" AS "q 0" JOIN `db``west`.`orders``archive` AS `q 1` ON 1=1';
  expect(aliasesOf(sql)).toEqual({
    "q 0": 'sales"2026',
    "q 1": "orders`archive",
  });
  expect(schemasOf(sql)).toEqual({
    'sales"2026': 'tenant"east',
    "orders`archive": "db`west",
  });
});

describe("PostgreSQL's plan", () => {
  test("a page of sorted rows: times of its own, rows, buffers, conditions", () => {
    const tree = postgresPlan(json("pg-page.json"));
    expect(tree.analyzed).toBe(true);
    expect(tree.planningTime).toBeGreaterThan(0);
    expect(tree.executionTime).toBeGreaterThan(0);
    expect(tree.root.kind).toBe("limit");
    const scan = find(tree, (node) => node.relation === "orders");
    expect(scan).toMatchObject({ alias: "q0", fullScan: true, kind: "scan" });
    expect(scan.conditions.map((condition) => condition.label)).toContain(
      "Filter"
    );
    expect(
      scan.facts.find((fact) => fact.label === "Rows Removed by Filter")
    ).toBeDefined();
    expect(scan.buffers?.hit).toBeGreaterThan(0);
    // A node's own time is its time less its children's, never below zero.
    for (const node of nodes(tree)) {
      expect(node.actual!.self).toBeGreaterThanOrEqual(0);
      expect(node.actual!.self).toBeLessThanOrEqual(node.actual!.time + 1e-9);
    }
    const sort = find(tree, (node) => node.kind === "sort");
    expect(sort.conditions[0]).toMatchObject({ label: "Sort Key" });
  });

  test("a join and a grouping", () => {
    const tree = postgresPlan(json("pg-join.json"));
    expect(nodes(tree).some((node) => node.kind === "join")).toBe(true);
    expect(nodes(tree).some((node) => node.kind === "aggregate")).toBe(true);
  });

  test("workers in parallel: their time is their average, not their sum", () => {
    const tree = postgresPlan([
      {
        Plan: {
          "Node Type": "Gather",
          "Actual Total Time": 10,
          "Actual Loops": 1,
          "Actual Rows": 5,
          Plans: [
            {
              "Node Type": "Parallel Seq Scan",
              "Relation Name": "orders",
              "Actual Total Time": 8,
              "Actual Loops": 3,
              "Actual Rows": 2,
            },
          ],
        },
      },
    ]);
    const scan = tree.root.children[0]!;
    expect(scan.actual).toMatchObject({ time: 8, self: 8, loops: 3 });
    expect(scan.fullScan).toBe(true);
    expect(tree.root.actual?.self).toBe(2);
    // Planned, not run: no actual, no time.
    const planned = postgresPlan([
      {
        Plan: {
          "Node Type": "Index Scan",
          "Index Cond": "(id = 1)",
          "Plan Rows": 1,
          "Total Cost": "8.3",
        },
      },
    ]);
    expect(planned.analyzed).toBe(false);
    expect(planned.root).toMatchObject({
      fullScan: false,
      estimate: { rows: 1, cost: 8.3 },
    });
    expect(planned.root.actual).toBeUndefined();
    // An index read end to end, no condition on it: every row.
    const walked = postgresPlan({
      Plan: {
        "Node Type": "Index Only Scan",
        "Actual Loops": 0,
        "Actual Total Time": 0,
      },
    });
    expect(walked.root).toMatchObject({ fullScan: true, neverExecuted: true });
  });

  test("what a node leaves out: its type, its index, its pages read", () => {
    const tree = postgresPlan({
      Plan: {
        "Shared Hit Blocks": 4,
        Plans: [{ "Node Type": "Index Scan", "Index Name": "orders_pkey" }],
      },
    });
    expect(tree.root).toMatchObject({
      operation: "Plan",
      buffers: { hit: 4, read: 0, dirtied: 0, written: 0 },
    });
    expect(tree.root).not.toHaveProperty("index");
    expect(tree.root.children[0]).toMatchObject({ index: "orders_pkey" });
  });

  test("an answer with no plan is refused", () => {
    expect(() => postgresPlan([])).toThrow("no plan");
    expect(() => postgresPlan([{ Plan: 3 }])).toThrow("no plan");
  });
});

describe("MySQL's plan", () => {
  test("a page of sorted rows, with a dependent subquery", () => {
    const tree = mysqlPlan(fixture("mysql-page.txt"));
    expect(tree.analyzed).toBe(true);
    const scan = find(tree, (node) => node.fullScan);
    expect(scan).toMatchObject({ operation: "Table scan", alias: "q0" });
    expect(scan.actual!.rows).toBe(200_000);
    const filter = find(tree, (node) => node.operation === "Filter");
    expect(filter.conditions[0]!.label).toBe("Filter");
    const sort = find(tree, (node) => node.kind === "sort");
    expect(sort.conditions[0]!.label).toBe("Sort Key");
    const limit = find(tree, (node) => node.kind === "limit");
    expect(limit.conditions[0]!.label).toBe("Limit");
    const lookup = find(
      tree,
      (node) => node.index === "order_items_orderId_idx"
    );
    expect(lookup.conditions[0]).toEqual({
      label: "Index Cond",
      text: "orderId=q0.id",
    });
  });

  test("a join, a temporary table, a step never reached", () => {
    const tree = mysqlPlan(fixture("mysql-join.txt"));
    const join = find(tree, (node) => node.kind === "join");
    expect(join.operation).toBe("Nested loop inner join");
    const never = mysqlPlan(
      "-> Hash join (a.id = b.id)  (cost=1 rows=1) (never executed)\n    -> Aggregate: count(0)  (cost=1 rows=1) (never executed)\n    -> Covering index scan on b using k  (cost=1 rows=1)\n    -> Stream results  (cost=1 rows=1)"
    );
    expect(never.analyzed).toBe(false);
    expect(never.root).toMatchObject({
      neverExecuted: true,
      conditions: [{ label: "Join Cond", text: "a.id = b.id" }],
    });
    expect(
      never.root.children.map((child) => child.conditions[0]?.label)
    ).toEqual(["Group Key", undefined, undefined]);
    expect(never.root.children[1]).toMatchObject({ alias: "b", index: "k" });
  });

  test("estimated, with a dependent subquery beside the statement: no time to add up", () => {
    const tree = mysqlPlan(
      "-> Table scan on q0  (cost=20 rows=200)\n-> Select #2 (subquery in projection; dependent)\n    -> Index lookup on q1 using k (orderId=q0.id)  (cost=1 rows=3)"
    );
    expect(tree.analyzed).toBe(false);
    expect(tree.root).toMatchObject({ operation: "Query" });
    expect(tree.root).not.toHaveProperty("actual");
    expect(tree.root.children).toHaveLength(2);
  });

  test("an answer with no plan is refused", () => {
    expect(() => mysqlPlan("")).toThrow("no plan");
  });
});

describe("SQLite's plan", () => {
  test("a scan, a subquery through an index, a sort in a temporary b-tree", () => {
    const tree = sqlitePlan(sqliteRows("sqlite-page.json"));
    expect(tree.analyzed).toBe(false);
    expect(tree.root.operation).toBe("Query");
    const [scan, subquery, sort] = tree.root.children;
    expect(scan).toMatchObject({ alias: "q0", fullScan: true, kind: "scan" });
    expect(subquery!.children[0]).toMatchObject({
      alias: "q3",
      index: "order_items_orderId_idx",
      kind: "index",
      conditions: [{ label: "Index Cond", text: "orderId=?" }],
    });
    expect(sort!.kind).toBe("sort");
  });

  test("a row by its key", () => {
    const tree = sqlitePlan(sqliteRows("sqlite-key.json"));
    expect(tree.root.children[0]).toMatchObject({
      index: "PRIMARY KEY",
      fullScan: false,
    });
    expect(() => sqlitePlan([])).toThrow("no plan");
    // Rows that hang from no top: nothing under the query.
    expect(
      sqlitePlan([{ id: 3, parent: 2, detail: "SCAN t" }]).root.children
    ).toEqual([]);
  });
});

test("catalog names retain aliases and namespaces", () => {
  const sql =
    'SELECT * FROM "public"."orders" AS "q0" LEFT JOIN customer c ON c.id = "q0"."customerId"';
  expect(aliasesOf(sql)).toEqual({ q0: "orders", c: "customer" });
  expect(schemasOf(sql)).toEqual({ orders: "public" });
});
