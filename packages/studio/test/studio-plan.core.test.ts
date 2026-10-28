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
import {
  adviseOn,
  aliasesOf,
  filtersOf,
  orderOf,
  type PlanContext,
  predicatesOf,
  schemasOf,
  type TableIndex,
  termsOf,
} from "../src/plan-advice";
import type { StudioField, StudioModel } from "../src/schema";

const FIXTURES = join(import.meta.dirname, "fixtures/plans");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const json = (name: string): unknown => JSON.parse(fixture(name));
type SqliteRow = Parameters<typeof sqlitePlan>[0][number];
/** SQLite's rows of a fixture: `EXPLAIN QUERY PLAN` as the driver hands it. */
const sqliteRows = (name: string): SqliteRow[] => JSON.parse(fixture(name));
const nodes = (tree: PlanTree) => [...walk(tree.root)];
const find = (tree: PlanTree, test: (node: PlanNode) => boolean) =>
  nodes(tree).find(test)!;

const field = (name: string, column = name): StudioField => ({
  name,
  column,
  type: "string",
  nullable: false,
  list: false,
  id: false,
  unique: false,
  searchable: true,
  optional: false,
  updatable: true,
});
const order: StudioModel = {
  name: "order",
  table: "orders",
  icon: "shoppingCart",
  fields: [
    field("id"),
    field("status"),
    field("total"),
    field("createdAt"),
    field("note"),
  ],
  relations: [],
};
/** An index as the catalog reads it: a b-tree over every row unless a test says otherwise. */
const index = (
  name: string,
  columns: string[],
  extra: Partial<TableIndex> = {}
): TableIndex => ({
  name,
  columns,
  descending: columns.map(() => false),
  unique: false,
  ordered: true,
  partial: false,
  ...extra,
});
const ORDERS_INDEXES = {
  orders: [
    index("orders_pkey", ["id"], { unique: true }),
    index("orders_customerId_idx", ["customerId"]),
  ],
};
const context = (
  dialect: PlanContext["dialect"],
  sql: string,
  extra: Partial<PlanContext> = {}
): PlanContext => ({
  dialect,
  sql,
  indexes: ORDERS_INDEXES,
  columns: {
    orders: ["id", "status", "total", "createdAt", "note", "customerId"],
    customer: ["id", "name", "country"],
  },
  tableRows: { orders: 200_000, customer: 20_000 },
  models: [order],
  ...extra,
});

describe("review regressions", () => {
  test("index and maintenance suggestions retain the namespace of the explained relation", () => {
    const plan = postgresPlan(json("pg-page.json"));
    for (const dialect of ["postgresql", "mysql"] as const) {
      const sql =
        "SELECT q0.id FROM tenant.orders AS q0 WHERE q0.status = $1 ORDER BY q0.createdAt DESC, q0.id LIMIT 20";
      const advice = adviseOn(plan, context(dialect, sql));
      const table =
        dialect === "mysql" ? "`tenant`.`orders`" : '"tenant"."orders"';
      expect(
        advice.find((entry) => entry.id.startsWith("page-"))?.fix?.sql
      ).toContain(`ON ${table}`);
    }
    const stale = postgresPlan({
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Alias: "q0",
        "Actual Rows": 3000,
        "Actual Loops": 1,
        "Actual Total Time": 1,
        "Plan Rows": 1,
      },
    });
    expect(
      adviseOn(
        stale,
        context("postgresql", "SELECT * FROM tenant.orders AS q0")
      ).find((entry) => entry.id.startsWith("estimate-"))?.fix?.sql
    ).toBe('ANALYZE "tenant"."orders";');
  });
  test("two placements of one table retain their own sort and correlation", () => {
    const sql =
      "SELECT q0.id, (SELECT q1.id, (SELECT q2.id FROM orders AS q2 WHERE q1.id = q2.customerId AND q2.status = $1 ORDER BY q2.createdAt DESC, q2.id LIMIT 3) FROM customer AS q1 WHERE q0.customerId = q1.id LIMIT 1) FROM orders AS q0 WHERE q0.status = $2 ORDER BY q0.total DESC, q0.id LIMIT 20";
    const advice = adviseOn(
      postgresPlan(json("pg-repeated-table.json")),
      context("postgresql", sql)
    );
    const root = advice.find((entry) => entry.id.startsWith("page-"));
    const inner = advice.find((entry) => entry.id.startsWith("sort-"));
    expect(root?.fix?.sql).toContain('("status", "total" DESC, "id")');
    expect(inner?.fix?.sql).toContain(
      '("customerId", "status", "createdAt" DESC, "id")'
    );
    expect(root?.nodes).not.toContain(inner?.nodes[0]);
  });
  const includeSql =
    "SELECT q0.id, (SELECT q1.id FROM orders AS q1 WHERE (q0.id = q1.customerId AND q1.status = $1) ORDER BY q1.createdAt DESC, q1.id ASC LIMIT 5) FROM customer AS q0 ORDER BY q0.id LIMIT 1000";

  test("an anti-join sort cannot borrow a different table's filter columns", () => {
    const advice = adviseOn(
      postgresPlan(json("pg-anti-join.json")),
      context(
        "postgresql",
        "SELECT q0.id FROM customer AS q0 WHERE NOT EXISTS (SELECT 1 FROM orders AS q1 WHERE q0.id = q1.customerId AND q1.status = $1) ORDER BY q0.id LIMIT 20"
      )
    );
    for (const entry of advice) {
      if (entry.fix?.sql?.includes('ON "customer"'))
        expect(entry.fix.sql).not.toContain('"status"');
    }
  });

  test("mixed ordering requires compatible key directions, forward or backward", () => {
    const sql =
      "SELECT q0.id FROM orders AS q0 WHERE q0.status = $1 ORDER BY q0.createdAt DESC, q0.id ASC LIMIT 20";
    for (const [directions, covered] of [
      [[false, false, false], false],
      [[false, true, false], true],
      [[false, false, true], true],
    ] as const) {
      const advice = adviseOn(
        postgresPlan(json("pg-page.json")),
        context("postgresql", sql, {
          indexes: {
            orders: [
              index("page", ["status", "createdAt", "id"], {
                descending: directions,
              }),
            ],
          },
        })
      );
      expect(advice.some((entry) => entry.id.startsWith("page-"))).toBe(
        !covered
      );
    }
  });

  test("estimated correlated sorting uses rows per invocation, not the table size", () => {
    const advice = adviseOn(
      postgresPlan(json("pg-correlated-estimate.json")),
      context("postgresql", includeSql)
    );
    const sort = advice.find((entry) => entry.id.startsWith("sort-"));
    expect(sort?.title).toContain("3 estimated rows");
    expect(sort?.detail).toContain("per invocation");
    expect(sort?.fix?.sql).toContain(
      '("customerId", "status", "createdAt" DESC, "id")'
    );
    expect(sort?.title).not.toContain("200k");
  });

  test("SQLite's nested sort uses its sibling scan and the nested order", () => {
    const advice = adviseOn(
      sqlitePlan(sqliteRows("sqlite-correlated.json")),
      context("sqlite", includeSql)
    );
    const sort = advice.find((entry) => entry.id.startsWith("sort-"));
    expect(sort?.fix?.sql).toContain(
      '("customerId", "status", "createdAt" DESC, "id")'
    );
    expect(sort?.title).toContain("Plans to sort rows");
    expect(sort?.title).not.toContain("200k");
  });

  test("bound GLOB prefixes and suffix functions produce actionable, qualified advice", () => {
    const tree = sqlitePlan([{ id: 1, parent: 0, detail: "SCAN q0" }]);
    const prefix = adviseOn(
      tree,
      context(
        "sqlite",
        `SELECT '?' AS literal FROM orders AS q0 WHERE q0.note GLOB ?`,
        { params: ["Customer 12*"] }
      )
    );
    expect(prefix.some((entry) => entry.fix?.sql?.includes('("note")'))).toBe(
      true
    );
    expect(
      predicatesOf(`RIGHT(BINARY q0.note, OCTET_LENGTH('120')) = BINARY '120'`)
    ).toContainEqual({ alias: "q0", column: "note", kind: "suffix" });
    const suffix = adviseOn(
      tree,
      context(
        "sqlite",
        "SELECT * FROM orders AS q0 WHERE substr(q0.note, length(q0.note) - length(?) + 1) = ?",
        { params: ["120", "120"] }
      )
    );
    expect(
      suffix.some((entry) => entry.title.includes("searched by its end"))
    ).toBe(true);
  });

  test("pattern binding handles repeated escapes without backtracking", () => {
    const tree = sqlitePlan([{ id: 1, parent: 0, detail: "SCAN q0" }]);
    const escaped = "\\&".repeat(32);
    const advice = adviseOn(
      tree,
      context(
        "sqlite",
        `SELECT '${escaped} FROM orders AS q0 WHERE q0.note GLOB ?`,
        { params: ["Customer 12*"] }
      )
    );
    expect(advice).toBeDefined();
  });

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

  test("PostgreSQL prefix searches explain the pattern operator class", () => {
    const tree = postgresPlan({
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Alias: "q0",
        Filter: "note ~~ 'Ab%'::text",
      },
    });
    const prefix = adviseOn(
      tree,
      context(
        "postgresql",
        "SELECT * FROM orders AS q0 WHERE q0.note LIKE $1",
        { params: ["Ab%"] }
      )
    );
    expect(
      prefix.find((entry) => entry.id.startsWith("prefix-"))?.fix?.sql
    ).toContain("text_pattern_ops");
    expect(
      predicatesOf("LEFT(BINARY q0.note, OCTET_LENGTH('Ab')) = BINARY 'Ab'")
    ).toContainEqual({ alias: "q0", column: "note", kind: "prefix" });
  });

  test("a many-value lookup remains distinct from a single-value order prefix", () => {
    const tree = postgresPlan({
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Alias: "q0",
        Filter: "status = ANY ('{paid,shipped}'::text[])",
      },
    });
    const advice = adviseOn(
      tree,
      context("postgresql", "SELECT * FROM orders AS q0")
    );
    expect(advice[0]?.detail).toContain('Multiple lookups for "status"');
    expect(advice[0]?.fix?.sql).toContain('("status")');
  });

  test("ambiguous joined sorts and unknown group sizes do not invent work or indexes", () => {
    const tree = postgresPlan({
      Plan: {
        "Node Type": "Sort",
        "Sort Key": ["id"],
        Plans: [
          {
            "Node Type": "Index Scan",
            "Relation Name": "orders",
            "Index Cond": "id = 1",
          },
          {
            "Node Type": "Index Scan",
            "Relation Name": "customer",
            "Index Cond": "id = 1",
          },
        ],
      },
    });
    expect(
      adviseOn(
        tree,
        context(
          "postgresql",
          "SELECT o.id FROM orders AS o JOIN customer AS c ON o.customerId = c.id ORDER BY o.id"
        )
      )
    ).toEqual([]);
    expect(
      adviseOn(
        sqlitePlan([
          { id: 1, parent: 0, detail: "USE TEMP B-TREE FOR GROUP BY" },
        ]),
        context(
          "sqlite",
          "SELECT q0.status FROM orders AS q0 GROUP BY q0.status",
          { tableRows: {} }
        )
      )
    ).toEqual([]);
    expect(
      adviseOn(
        sqlitePlan([
          { id: 1, parent: 0, detail: "USE TEMP B-TREE FOR ORDER BY" },
        ]),
        context("sqlite", "SELECT q0.id FROM orders AS q0 ORDER BY q0.id")
      )
    ).toEqual([]);
  });
});

describe("coverage low value", () => {
  test("incomplete or nested list notation stays parseable without inventing a column", () => {
    expect(predicatesOf("(id = 1")).toEqual([]);
    expect(predicatesOf("id IN 1")).toEqual([{ column: "id", kind: "equal" }]);
    expect(predicatesOf("id IN (coalesce(1, 2), 3)")).toEqual([
      { column: "id", kind: "multi" },
    ]);
    const tree = postgresPlan({
      Plan: {
        "Node Type": "Limit",
        Plans: [
          { "Node Type": "Index Scan", "Relation Name": "orders", Alias: "q0" },
        ],
      },
    });
    expect(
      adviseOn(
        tree,
        context("postgresql", "SELECT * FROM orders AS q0 LIMIT 20")
      )
    ).toEqual([]);
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

describe("reading statements", () => {
  test("comparisons, by kind", () => {
    expect(
      predicatesOf(
        `("q0"."status" COLLATE BINARY = ? AND q0.total > 5 AND (name ~~ '%a%'::text) AND title LIKE 'Ab%' AND note IS NULL AND id IN (1, 2) AND (q1.id = q0."customerId") AND country <> 'FR' AND tag ~~ $1 AND cast(q0.status as char charset binary) = 'x' AND NOT a)`
      )
    ).toEqual([
      { alias: "q0", column: "status", kind: "equal" },
      { alias: "q0", column: "total", kind: "range" },
      { column: "name", kind: "contains" },
      { column: "title", kind: "prefix" },
      { column: "note", kind: "equal" },
      { column: "id", kind: "multi" },
      // A join names a column on each side.
      { alias: "q1", column: "id", kind: "join" },
      { alias: "q0", column: "customerId", kind: "join" },
      { column: "country", kind: "other" },
      { column: "tag", kind: "other" },
      { alias: "q0", column: "status", kind: "equal" },
      { column: "a", kind: "other" },
    ]);
    expect(predicatesOf("(1 = 1) AND (null IS NULL)")).toEqual([]);
  });

  test("what narrows: a branch of an OR, a function of the column, a list of one", () => {
    // PostgreSQL's recheck, the column bare on the right.
    expect(predicatesOf('(q0.id = "customerId")')).toEqual([
      { alias: "q0", column: "id", kind: "join" },
      { column: "customerId", kind: "join" },
    ]);
    expect(predicatesOf("(a = 1 OR b = 2) AND c = 3")).toEqual([
      { column: "a", kind: "other" },
      { column: "b", kind: "other" },
      { column: "c", kind: "equal" },
    ]);
    expect(predicatesOf("lower(email) = 'a' AND NOT (x = 1)")).toEqual([
      { column: "email", kind: "other" },
      { column: "x", kind: "other" },
    ]);
    // The search functions each database writes for `contains`.
    for (const search of [
      "locate(BINARY 'gift', BINARY q0.note) > 0",
      "instr(q0.note COLLATE BINARY, ?) > 0",
      "strpos(q0.note, 'gift') > 0",
    ])
      expect(predicatesOf(search), search).toEqual([
        { alias: "q0", column: "note", kind: "contains" },
      ]);
    expect(
      predicatesOf("q0.note GLOB '*gift*' AND q0.title GLOB 'Ab*'")
    ).toEqual([
      { alias: "q0", column: "note", kind: "contains" },
      { alias: "q0", column: "title", kind: "prefix" },
    ]);
    expect(
      predicatesOf(
        "status = ANY ('{paid}'::text[]) AND kind = ANY ('{a,b}'::text[]) AND tag = ANY ($1) AND n IN (?) AND m NOT IN (1, 2) AND t NOT LIKE 'a%' AND d BETWEEN 1 AND 2"
      )
    ).toEqual([
      { column: "status", kind: "equal" },
      { column: "kind", kind: "multi" },
      { column: "tag", kind: "multi" },
      { column: "n", kind: "equal" },
      { column: "m", kind: "other" },
      { column: "t", kind: "other" },
      { column: "d", kind: "range" },
    ]);
  });

  test("tables by alias, the order asked, what the statement filters", () => {
    const sql = `SELECT "q0"."id", ABS("q0"."total") >= 1 FROM "public"."orders" AS "q0" LEFT JOIN customer c ON c.id = "q0"."customerId" WHERE "q0"."status" = $1 ORDER BY "q0"."createdAt" DESC, "q0"."id" LIMIT 20`;
    expect(aliasesOf(sql)).toEqual({ q0: "orders", c: "customer" });
    expect(schemasOf(sql)).toEqual({ orders: "public" });
    expect(orderOf(sql)).toEqual([
      [
        { alias: "q0", column: "createdAt", desc: true },
        { alias: "q0", column: "id", desc: false },
      ],
    ]);
    // Each clause apart: the join's condition does not run into the WHERE.
    expect(filtersOf(sql)).toEqual([
      'c.id = "q0"."customerId"',
      '"q0"."status" = $1',
    ]);
    expect(
      filtersOf(sql)
        .flatMap(predicatesOf)
        .map((predicate) => `${predicate.alias}.${predicate.column}`)
    ).toEqual(["c.id", "q0.customerId", "q0.status"]);
    // An order by an expression has no column an index holds.
    expect(termsOf("count(q1.id) DESC")).toBeUndefined();
    expect(termsOf("")).toBeUndefined();
    expect(
      termsOf("q0.total DESC NULLS LAST, limit input to 20 row(s) per chunk")
    ).toEqual([{ alias: "q0", column: "total", desc: true }]);
  });
});

describe("advice", () => {
  const pgPage = postgresPlan(json("pg-page.json"));
  const PG_PAGE_SQL = `SELECT "q0"."id" FROM "public"."orders" AS "q0" WHERE ("q0"."status" = $1 AND "q0"."total" > $2) ORDER BY "q0"."createdAt" DESC, "q0"."id" ASC LIMIT $3`;

  test("a page sorted from a full scan: one index on the equalities, then the order", () => {
    for (const [dialect, tree, sql] of [
      ["postgresql", pgPage, PG_PAGE_SQL],
      [
        "mysql",
        mysqlPlan(fixture("mysql-page.txt")),
        PG_PAGE_SQL.replaceAll('"', "`"),
      ],
      ["sqlite", sqlitePlan(sqliteRows("sqlite-page.json")), PG_PAGE_SQL],
    ] as const) {
      const advice = adviseOn(tree, context(dialect, sql));
      expect(advice[0], dialect).toMatchObject({
        severity: tree.analyzed ? "critical" : "info",
        title:
          'Index "orders" on "status", "createdAt" DESC, "id" for this page',
      });
      // Directions mixed: the index holds them, which .index() cannot declare.
      const q = (name: string) =>
        dialect === "mysql" ? `\`${name}\`` : `"${name}"`;
      expect(advice[0]!.fix, dialect).toEqual({
        sql: `CREATE INDEX ${q("orders_status_createdAt_id_idx")} ON ${q("public")}.${q("orders")} (${q("status")}, ${q("createdAt")} DESC, ${q("id")});`,
        note: expect.stringContaining("migration"),
      });
      // No second index for the sort alone.
      expect(
        advice.filter((entry) => entry.id.startsWith("sort-")),
        dialect
      ).toEqual([]);
    }
    // Already there: nothing to say.
    expect(
      adviseOn(
        pgPage,
        context("postgresql", PG_PAGE_SQL, {
          indexes: {
            orders: [
              index("page", ["status", "createdAt", "id"], {
                descending: [false, true, false],
              }),
            ],
          },
        })
      ).filter((entry) => entry.id.startsWith("page-"))
    ).toEqual([]);
  });

  test("a join and a grouping: contains, and the sort-free plan", () => {
    const sql = `SELECT c.country FROM orders o JOIN customer c ON c.id = o."customerId" WHERE o.note LIKE '%gift%' GROUP BY c.country`;
    const pg = adviseOn(
      postgresPlan(json("pg-join.json")),
      context("postgresql", sql)
    );
    expect(
      pg.find((entry) => entry.id.startsWith("contains-"))?.fix?.sql
    ).toContain("gin_trgm_ops");
    const my = adviseOn(
      mysqlPlan(fixture("mysql-join.txt")),
      context("mysql", sql.replaceAll('"', ""))
    );
    expect(
      my.find((entry) => entry.id.startsWith("contains-"))?.fix?.sql
    ).toContain("FULLTEXT");
  });

  test("SQLite groups in a temporary b-tree", () => {
    const sql = `SELECT "q0"."status" FROM "orders" AS "q0" GROUP BY "q0"."status" ORDER BY "q0"."status"`;
    const advice = adviseOn(
      sqlitePlan(sqliteRows("sqlite-group.json")),
      context("sqlite", sql)
    );
    expect(advice.map((entry) => entry.title)).toContain(
      'Plans to group "orders" in a temporary b-tree'
    );
    // A small table, or no GROUP BY to read: nothing.
    expect(
      adviseOn(
        sqlitePlan(sqliteRows("sqlite-group.json")),
        context("sqlite", sql, { tableRows: { orders: 10 } })
      )
    ).toEqual([]);
    expect(
      adviseOn(
        sqlitePlan(sqliteRows("sqlite-group.json")),
        context("sqlite", 'SELECT 1 FROM "orders" AS "q0"')
      )
    ).toEqual([]);
  });

  /** A PostgreSQL scan node, as `postgresPlan` reads it, with what a test needs. */
  const scanTree = (
    extra: Record<string, unknown>,
    top: Record<string, unknown> = {}
  ): PlanTree =>
    postgresPlan([
      {
        "Planning Time": 0.1,
        "Execution Time": 50,
        ...top,
        Plan: {
          "Node Type": "Seq Scan",
          "Relation Name": "orders",
          Alias: "orders",
          "Plan Rows": 100,
          "Actual Rows": 100,
          "Actual Loops": 1,
          "Actual Total Time": 40,
          ...extra,
        },
      },
    ]);
  const ids = (advice: ReturnType<typeof adviseOn>) =>
    advice.map((entry) => entry.id.split("-")[0]);

  test("a full scan for a filter: an index, unless the filter keeps most rows or an index is there already", () => {
    const sql = 'SELECT * FROM "orders" WHERE "status" = $1';
    const removed = {
      Filter: "(status = 'paid'::text)",
      "Rows Removed by Filter": 199_900,
    };
    const advice = adviseOn(scanTree(removed), context("postgresql", sql));
    expect(advice[0]).toMatchObject({
      severity: "critical",
      title: 'Index "orders" on "status"',
    });
    // Run once per outer row.
    expect(
      adviseOn(
        scanTree({ ...removed, "Actual Loops": 4 }),
        context("postgresql", sql)
      )[0]!.detail
    ).toContain("4 runs");
    // Small: say so.
    expect(
      adviseOn(
        scanTree({
          Filter: "(status = 'paid'::text)",
          "Rows Removed by Filter": 200,
        }),
        context("postgresql", sql)
      )[0]
    ).toMatchObject({ severity: "info" });
    expect(
      adviseOn(
        scanTree({
          Filter: "(status = 'paid'::text)",
          "Rows Removed by Filter": 9000,
        }),
        context("postgresql", sql)
      )[0]
    ).toMatchObject({ severity: "warning" });
    // Keeps most rows.
    expect(
      adviseOn(
        scanTree({
          Filter: "(status = 'paid'::text)",
          "Rows Removed by Filter": 10,
        }),
        context("postgresql", sql)
      )[0]!.title
    ).toContain("keeps most rows");
    // An index leads with the column, unused.
    const unused = adviseOn(
      scanTree(removed),
      context("postgresql", sql, {
        indexes: {
          orders: [index("orders_status_idx", ["status"])],
        },
      })
    );
    expect(unused[0]).toMatchObject({
      title: 'Full scan of "orders" despite the index orders_status_idx',
      fix: { sql: 'ANALYZE "orders";' },
    });
    // No filter, or the query never reached it: nothing.
    expect(adviseOn(scanTree({}), context("postgresql", sql))).toEqual([]);
    expect(
      adviseOn(
        scanTree({ ...removed, "Actual Loops": 0 }),
        context("postgresql", sql)
      )
    ).toEqual([]);
    // A table no model maps: the SQL only.
    expect(
      adviseOn(
        scanTree(removed),
        context("postgresql", sql, { models: [] })
      )[0]!.fix
    ).not.toHaveProperty("schema");
  });

  test("searched anywhere in the text, per database", () => {
    const sql = 'SELECT * FROM "orders" WHERE "note" LIKE $1';
    const contains = {
      Filter: "(note ~~ '%gift%'::text)",
      "Rows Removed by Filter": 199_000,
    };
    expect(
      adviseOn(scanTree(contains), context("postgresql", sql))[0]
    ).toMatchObject({ severity: "warning" });
    expect(
      adviseOn(
        scanTree({ ...contains, "Rows Removed by Filter": 10 }),
        context("postgresql", sql)
      ).find((entry) => entry.id.startsWith("contains"))
    ).toMatchObject({ severity: "info" });
    const sqlite = sqlitePlan([{ id: 2, parent: 0, detail: "SCAN q0" }]);
    const advice = adviseOn(
      sqlite,
      context(
        "sqlite",
        `SELECT * FROM "orders" AS "q0" WHERE "q0"."note" LIKE '%gift%'`
      )
    );
    expect(advice[0]!.fix).toEqual({ note: expect.stringContaining("FTS5") });
  });

  test("estimates, spills, the table checked again, the bitmap, a cold cache, planning", () => {
    const sql = 'SELECT * FROM "orders"';
    expect(
      ids(
        adviseOn(
          scanTree({ "Plan Rows": 10, "Actual Rows": 50_000 }),
          context("postgresql", sql)
        )
      )
    ).toEqual(["estimate"]);
    expect(
      adviseOn(
        scanTree({ "Plan Rows": 10, "Actual Rows": 50_000 }),
        context("mysql", sql)
      )[0]!.fix?.sql
    ).toBe("ANALYZE TABLE `orders`;");
    // Under a limit the reading stops early: not a misestimate.
    const limited = postgresPlan({
      Plan: {
        "Node Type": "Limit",
        "Actual Loops": 1,
        "Actual Total Time": 1,
        "Actual Rows": 10,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "orders",
            "Plan Rows": 100_000,
            "Actual Rows": 10,
            "Actual Loops": 1,
            "Actual Total Time": 1,
          },
        ],
      },
    });
    expect(adviseOn(limited, context("postgresql", sql))).toEqual([]);
    expect(
      ids(
        adviseOn(
          scanTree({ "Node Type": "Hash", "Hash Batches": 4 }),
          context("postgresql", sql)
        )
      )
    ).toEqual(["hash"]);
    expect(
      ids(
        adviseOn(
          scanTree({
            "Node Type": "Index Only Scan",
            "Index Cond": "(id > 1)",
            "Heap Fetches": 90,
          }),
          context("postgresql", sql)
        )
      )
    ).toEqual(["heap"]);
    expect(
      adviseOn(
        scanTree({
          "Node Type": "Index Only Scan",
          "Index Cond": "(id > 1)",
          "Heap Fetches": 5,
        }),
        context("postgresql", sql)
      )
    ).toEqual([]);
    expect(
      ids(
        adviseOn(
          scanTree({
            "Node Type": "Bitmap Heap Scan",
            "Lossy Heap Blocks": 12,
          }),
          context("postgresql", sql)
        )
      )
    ).toEqual(["lossy"]);
    expect(
      ids(
        adviseOn(
          scanTree({
            "Node Type": "Bitmap Heap Scan",
            "Shared Hit Blocks": 100,
            "Shared Read Blocks": 5000,
          }),
          context("postgresql", sql)
        )
      )
    ).toEqual(["cold"]);
    expect(
      ids(
        adviseOn(
          scanTree(
            { "Node Type": "Result" },
            { "Planning Time": 20, "Execution Time": 2 }
          ),
          context("postgresql", sql)
        )
      )
    ).toEqual(["planning"]);
  });

  test("a sort the plan did itself: spilled, for a page, or of all the rows", () => {
    const sorted = (
      sort: Record<string, unknown>,
      top?: Record<string, unknown>
    ) =>
      postgresPlan({
        Plan: {
          ...top,
          "Node Type": top ? "Limit" : "Sort",
          "Actual Loops": 1,
          "Actual Total Time": 30,
          "Actual Rows": 20,
          Plans: [
            top
              ? {
                  "Node Type": "Sort",
                  "Actual Loops": 1,
                  "Actual Total Time": 30,
                  "Actual Rows": 20,
                  ...sort,
                  Plans: [
                    {
                      "Node Type": "Index Scan",
                      "Relation Name": "orders",
                      "Index Cond": "(status = 'x')",
                      "Actual Rows": 50_000,
                      "Actual Loops": 1,
                      "Actual Total Time": 10,
                    },
                  ],
                }
              : {
                  "Node Type": "Index Scan",
                  "Relation Name": "orders",
                  "Index Cond": "(status = 'x')",
                  "Actual Rows": 50_000,
                  "Actual Loops": 1,
                  "Actual Total Time": 10,
                },
          ],
          ...(top ? {} : sort),
        },
      });
    const sql =
      'SELECT * FROM "orders" AS "o" WHERE "o"."status" = $1 ORDER BY "o"."total"';
    const spilled = adviseOn(
      sorted({
        "Sort Key": ["o.total"],
        "Sort Method": "external merge",
        "Sort Space Type": "Disk",
        "Sort Space Used": 9000,
      }),
      context("postgresql", sql)
    );
    expect(spilled[0]).toMatchObject({
      id: expect.stringContaining("spill-"),
      severity: "critical",
      fix: { sql: "SET work_mem = '64MB';" },
    });
    expect(
      adviseOn(
        sorted({ "Sort Key": ["o.total"], "Sort Method": "external merge" }),
        context("mysql", sql)
      )[0]!.fix
    ).not.toHaveProperty("sql");
    const all = adviseOn(
      sorted({ "Sort Key": ["o.total"] }),
      context("postgresql", sql)
    );
    expect(all[0]).toMatchObject({
      title: 'Sorted 50k rows of "orders" by total',
      severity: "warning",
    });
    expect(all[0]!.fix?.sql).toContain('("status", "total")');
    const page = adviseOn(
      sorted({ "Sort Key": ["o.total"] }, { "Actual Rows": 20 }),
      context("postgresql", `${sql} LIMIT 20`)
    );
    expect(page[0]!.detail).toContain("Index avoids sorting before pagination");
    // Sorted already by an index there: nothing; too few rows: nothing; no key to read: nothing.
    expect(
      adviseOn(
        sorted({ "Sort Key": ["o.total"] }),
        context("postgresql", sql, {
          indexes: {
            orders: [index("x", ["status", "total"])],
          },
        })
      )
    ).toEqual([]);
    expect(
      adviseOn(
        postgresPlan({
          Plan: {
            "Node Type": "Sort",
            "Sort Key": ["o.total"],
            Plans: [
              {
                "Node Type": "Index Scan",
                "Relation Name": "orders",
                "Index Cond": "(id = 1)",
                "Plan Rows": 3,
              },
            ],
          },
        }),
        context("postgresql", sql, { tableRows: {} })
      )
    ).toEqual([]);
    expect(
      adviseOn(
        postgresPlan({
          Plan: { "Node Type": "Sort", Plans: [{ "Node Type": "Result" }] },
        }),
        context("postgresql", "SELECT 1")
      )
    ).toEqual([]);
  });

  test("the same fix is said once, gravest first", () => {
    const sql = 'SELECT * FROM "orders" WHERE "status" = $1';
    const scan = {
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      Filter: "(status = 'x')",
      "Rows Removed by Filter": 100_000,
      "Actual Rows": 1,
      "Actual Loops": 1,
      "Actual Total Time": 5,
    };
    const twice = postgresPlan({
      Plan: {
        "Node Type": "Append",
        "Actual Loops": 1,
        "Actual Total Time": 10,
        "Actual Rows": 2,
        Plans: [scan, scan],
      },
    });
    expect(adviseOn(twice, context("postgresql", sql))).toHaveLength(1);
  });
});

describe("advice, the rarer plans", () => {
  const ITEMS = ["id", "orderId", "createdAt", "price"];
  const withItems = (
    sql: string,
    extra: Partial<PlanContext> = {}
  ): PlanContext =>
    context("postgresql", sql, {
      columns: {
        orders: ["id", "status", "total", "createdAt", "note", "customerId"],
        order_items: ITEMS,
      },
      tableRows: { orders: 200_000, order_items: 600_000 },
      ...extra,
    });
  /** A subquery run once per order: the latest items of each, read in full every time. */
  const perOrder = (scan: Record<string, unknown> = {}) =>
    postgresPlan({
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Alias: "q0",
        "Actual Rows": 100,
        "Actual Loops": 1,
        "Actual Total Time": 900,
        Plans: [
          {
            "Node Type": "Limit",
            "Parent Relationship": "SubPlan",
            "Actual Rows": 3,
            "Actual Loops": 100,
            "Actual Total Time": 9,
            Plans: [
              {
                "Node Type": "Sort",
                "Sort Key": ['q1."createdAt" DESC'],
                "Actual Rows": 3,
                "Actual Loops": 100,
                "Actual Total Time": 9,
                Plans: [
                  {
                    "Node Type": "Seq Scan",
                    "Relation Name": "order_items",
                    Alias: "q1",
                    Filter: '("orderId" = q0.id)',
                    "Rows Removed by Filter": 599_994,
                    "Actual Rows": 6,
                    "Actual Loops": 100,
                    "Actual Total Time": 8,
                    ...scan,
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  const SUBQUERY_SQL = `SELECT "q0"."id", (SELECT json_agg(t) FROM (SELECT "q1"."id" FROM "order_items" AS "q1" WHERE "q1"."orderId" = "q0"."id" ORDER BY "q1"."createdAt" DESC LIMIT 3) AS t) FROM "orders" AS "q0"`;

  test("a subquery run once per row: the index begins with what ties it to that row", () => {
    const advice = adviseOn(perOrder(), withItems(SUBQUERY_SQL));
    const page = advice.find((entry) => entry.id.startsWith("page-"));
    expect(page).toMatchObject({
      severity: "critical",
      title: 'Index "order_items" on "orderId", "createdAt" DESC for this page',
    });
    expect(page!.detail).toContain("100 runs");
    expect(page!.detail).toContain("Index starts with orderId");
    // One way only: .index() says it.
    expect(page!.fix?.schema).toBeUndefined();
    expect(page!.fix?.sql).toBe(
      'CREATE INDEX "order_items_orderId_createdAt_idx" ON "order_items" ("orderId", "createdAt");'
    );
    // Most of each run's rows kept: still an index on the tie, and the sort said apart, once per order.
    const kept = adviseOn(
      perOrder({ "Rows Removed by Filter": 2, "Actual Rows": 6000 }),
      withItems(SUBQUERY_SQL)
    );
    expect(kept.map((entry) => entry.title)).toEqual([
      'Index "order_items" on "orderId"',
      'Sorted 600k rows of "order_items" by createdAt DESC',
    ]);
    expect(kept[1]!.detail).toContain("Repeated per orderId");
  });

  test("an index read end to end for its order: the equalities first", () => {
    const sql = `SELECT * FROM "orders" AS "q0" WHERE "q0"."status" = $1 ORDER BY "q0"."id" LIMIT 20`;
    const tree = postgresPlan({
      Plan: {
        "Node Type": "Limit",
        "Actual Rows": 20,
        "Actual Loops": 1,
        "Actual Total Time": 300,
        Plans: [
          {
            "Node Type": "Index Scan",
            "Relation Name": "orders",
            Alias: "q0",
            "Index Name": "orders_pkey",
            Filter: "((status = 'paid'::text) AND (status = 'paid'::text))",
            "Rows Removed by Filter": 150_000,
            "Actual Rows": 20,
            "Actual Loops": 1,
            "Actual Total Time": 300,
          },
        ],
      },
    });
    const [advice] = adviseOn(
      tree,
      context("postgresql", sql, { tableRows: { orders: 2_000_000 } })
    );
    expect(advice).toMatchObject({
      title: 'Index "orders" on "status", "id" for this page',
      fix: { schema: '// the "order" model\n.index(["status", "id"])' },
    });
    expect(advice!.detail).toContain("page order");
    expect(advice!.detail).toContain("Stopped at LIMIT (150k/2.0M rows).");
  });

  test("a range after the equalities; an index there that begins with them", () => {
    const sql = `SELECT * FROM "orders" WHERE "status" = $1 AND "total" > $2`;
    const scan = scanTree();
    function scanTree() {
      return postgresPlan({
        Plan: {
          "Node Type": "Seq Scan",
          "Relation Name": "orders",
          Filter: "((status = 'paid'::text) AND (total > 500))",
          "Rows Removed by Filter": 199_000,
          "Actual Rows": 1000,
          "Actual Loops": 1,
          "Actual Total Time": 40,
        },
      });
    }
    const [advice] = adviseOn(
      scan,
      context("postgresql", sql, {
        indexes: { orders: [index("orders_status_idx", ["status"])] },
      })
    );
    expect(advice).toMatchObject({
      title: 'Index "orders" on "status", "total"',
    });
    expect(advice!.detail).toContain("Extends orders_status_idx.");
    // A partial index, or a hash, holds not what a b-tree over every row does.
    for (const held of [
      index("orders_status_idx", ["status", "total"], { partial: true }),
      index("orders_status_idx", ["status", "total"], { ordered: false }),
    ])
      expect(
        adviseOn(
          scan,
          context("postgresql", sql, { indexes: { orders: [held] } })
        )[0]!.title
      ).toBe('Index "orders" on "status", "total"');
  });

  test("planned only: a table of unknown size, a prefix as a range", () => {
    const sqlite = sqlitePlan([{ id: 2, parent: 0, detail: "SCAN q0" }]);
    const [advice] = adviseOn(
      sqlite,
      context(
        "sqlite",
        `SELECT * FROM "orders" AS "q0" WHERE "q0"."note" LIKE 'Ab%'`,
        { tableRows: {} }
      )
    );
    expect(advice).toMatchObject({
      severity: "info",
      title: 'Index "orders" on "note"',
    });
    expect(advice!.detail).toContain("Scan planned; row count unknown");
  });

  test("sorts and groupings of a few thousand rows; a sort with no table under it", () => {
    const grouped = adviseOn(
      sqlitePlan(sqliteRows("sqlite-group.json")),
      context(
        "sqlite",
        `SELECT "q0"."status" FROM "orders" AS "q0" GROUP BY "q0"."status"`,
        { tableRows: { orders: 3000 } }
      )
    );
    expect(grouped[0]).toMatchObject({ severity: "info" });
    // Grouped by what the statement names bare: no table to read it from.
    expect(
      adviseOn(
        sqlitePlan(sqliteRows("sqlite-group.json")),
        context("sqlite", `SELECT status FROM "orders" GROUP BY status`)
      )
    ).toEqual([]);
    const sql = `SELECT * FROM "orders" AS "o" ORDER BY "o"."total"`;
    const sorted = adviseOn(
      postgresPlan({
        Plan: {
          "Node Type": "Sort",
          "Sort Key": ["o.total"],
          "Actual Rows": 3000,
          "Actual Loops": 1,
          "Actual Total Time": 4,
          Plans: [
            {
              "Node Type": "Function Scan",
              "Actual Rows": 3000,
              "Actual Loops": 1,
              "Actual Total Time": 1,
            },
          ],
        },
      }),
      context("postgresql", sql)
    );
    expect(sorted).toEqual([]);
    // Sorted by a column it names bare: the table under the sort.
    expect(
      adviseOn(
        postgresPlan({
          Plan: {
            "Node Type": "Sort",
            "Sort Key": ["total"],
            Plans: [{ "Node Type": "Seq Scan", "Relation Name": "orders" }],
          },
        }),
        context("postgresql", 'SELECT * FROM "orders" ORDER BY "total"')
      ).map((entry) => entry.title)
    ).toContain('Plans to sort rows of "orders" by total');
    // Spilled with nothing measured under it.
    expect(
      adviseOn(
        postgresPlan({
          Plan: {
            "Node Type": "Sort",
            "Sort Method": "external merge",
            "Sort Space Used": 10,
            Plans: [{ "Node Type": "Result" }],
          },
        }),
        context("postgresql", "SELECT 1")
      )[0]!.detail
    ).toBe("0 rows · 10 kB on disk.");
  });
});
