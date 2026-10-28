import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { dialectOf, explainStatements } from "../src/explain";

const FIXTURES = join(import.meta.dirname, "fixtures/plans");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/** A client whose raw queries answer as a database would, by what the statement starts with. */
function client(answers: [string, (params: unknown[]) => unknown][]) {
  const asked: { sql: string; params: unknown[] }[] = [];
  return {
    asked,
    $queryRawUnsafe(sql: string, ...params: unknown[]) {
      asked.push({ sql, params });
      const answer = answers.find(([part]) => sql.includes(part));
      if (!answer) return Promise.reject(new Error(`unexpected: ${sql}`));
      try {
        return Promise.resolve(answer[1](params));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}

const TAB_SEPARATED = /^\d+\t\d+\t\S/;
const PAGE_SQL = `SELECT "q0"."id" FROM "public"."orders" AS "q0" WHERE ("q0"."status" = $1 AND "q0"."total" > $2) ORDER BY "q0"."createdAt" DESC, "q0"."id" ASC LIMIT $3`;

test("PostgreSQL catalog preserves quotes in mapped table and schema names", async () => {
  const pg = client([
    [
      "EXPLAIN",
      () => [
        {
          "QUERY PLAN": [
            {
              Plan: { "Node Type": "Seq Scan", "Relation Name": 'sales"2026' },
            },
          ],
        },
      ],
    ],
    ["FROM pg_index", () => []],
    ["FROM pg_class", () => []],
  ]);
  const [result] = await explainStatements(
    pg,
    "postgresql",
    [{ sql: 'SELECT * FROM "tenant""east"."sales""2026" AS "q0"' }],
    [],
    false
  );
  expect(result?.error).toBeUndefined();
  expect(pg.asked[1]?.params).toEqual([['"tenant""east"."sales""2026"']]);
});

test("PostgreSQL transactionless drivers refuse Analyze before replay and retain Estimate", async () => {
  const pg = client([
    [
      "EXPLAIN",
      () => [{ "QUERY PLAN": [{ Plan: { "Node Type": "Result" } }] }],
    ],
  ]);
  const unsupported = {
    ...pg,
    $driver: { supportsTransactions: false },
    $transaction() {
      throw new Error("must not call interactive transactions");
    },
  };
  const [analyzed] = await explainStatements(
    unsupported,
    "postgresql",
    [{ sql: "SELECT 1" }],
    []
  );
  expect(analyzed?.error).toContain("Use Estimate");
  expect(pg.asked).toHaveLength(0);
  const [estimated] = await explainStatements(
    unsupported,
    "postgresql",
    [{ sql: "SELECT 1" }],
    [],
    false
  );
  expect(estimated?.plan?.analyzed).toBe(false);
});

test("MySQL CTE reads put their timeout on the outer SELECT", async () => {
  const my = client([
    ["EXPLAIN", () => [{ EXPLAIN: fixture("mysql-page.txt") }]],
    ["information_schema", () => []],
  ]);
  const sql =
    "WITH `SELECT` AS (SELECT 'SELECT )' AS value /* SELECT ) */), other AS (SELECT 2) SELECT * FROM `SELECT`";
  await explainStatements(my, "mysql", [{ sql }], []);
  expect(my.asked[0]?.sql).toBe(
    `EXPLAIN ANALYZE ${sql.replace("SELECT *", "SELECT /*+ MAX_EXECUTION_TIME(30000) */ *")}`
  );
});

test("dialects by the name a driver gives", () => {
  expect(dialectOf("postgresql")).toBe("postgresql");
  expect(dialectOf("mysql")).toBe("mysql");
  expect(dialectOf("MariaDB")).toBe("mysql");
  expect(dialectOf("sqlite")).toBe("sqlite");
  expect(dialectOf("libsql")).toBe("sqlite");
  expect(dialectOf("d1")).toBe("sqlite");
  expect(dialectOf("mssql")).toBeUndefined();
});

test("PostgreSQL: the plan of the statement with its values, the catalog, the advice", async () => {
  const answers: [string, (params: unknown[]) => unknown][] = [
    ["SET LOCAL statement_timeout", () => []],
    [
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)",
      () => [{ "QUERY PLAN": fixture("pg-page.json") }],
    ],
    [
      "FROM pg_index",
      () => [
        {
          table: "orders",
          name: "orders_pkey",
          unique: true,
          method: "btree",
          partial: false,
          definition: "CREATE UNIQUE INDEX orders_pkey ON orders (id)",
          columns: ["id"],
          descending: [true],
        },
        {
          table: "orders",
          name: "orders_note_trgm",
          unique: false,
          method: "gin",
          partial: true,
          definition: "CREATE INDEX …",
          columns: ["note"],
        },
        { table: "orders", name: "odd", columns: null },
      ],
    ],
    [
      "FROM pg_class c",
      () => [
        {
          table: "orders",
          rows: "200000",
          columns: ["id", "status", "total", "createdAt"],
        },
      ],
    ],
  ];
  const pg = client(answers);
  // ANALYZE runs the statement again: in a transaction whose time limit ends with it.
  const transactions: unknown[] = [];
  const withTransaction = {
    ...pg,
    $driver: { supportsTransactions: true },
    $transaction(run: (tx: object) => Promise<unknown>) {
      transactions.push(run);
      return run(pg);
    },
  };
  const [explained] = await explainStatements(
    withTransaction,
    "postgresql",
    [{ sql: PAGE_SQL, params: ["paid", 500, 20] }],
    []
  );
  expect(transactions).toHaveLength(1);
  expect(pg.asked[0]!.sql).toBe("SET LOCAL statement_timeout = 30000");
  expect(pg.asked[1]).toEqual({
    sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${PAGE_SQL}`,
    params: ["paid", 500, 20],
  });
  // The relation as the statement named it, schema and all.
  expect(pg.asked[2]!.params).toEqual([['"public"."orders"']]);
  expect(explained!.plan).toMatchObject({
    dialect: "postgresql",
    analyzed: true,
    tableRows: { orders: 200_000 },
    columns: { orders: ["id", "status", "total", "createdAt"] },
    indexes: {
      orders: [
        {
          name: "orders_pkey",
          unique: true,
          ordered: true,
          partial: false,
          descending: [true],
        },
        { name: "orders_note_trgm", ordered: false, partial: true },
        { name: "odd", columns: [], ordered: false },
      ],
    },
  });
  expect(JSON.parse(explained!.plan!.raw)).toEqual(
    JSON.parse(fixture("pg-page.json"))
  );
  expect(explained!.plan!.advice[0]!.title).toContain("for this page");
  // Estimated only, by a driver that parses the JSON column: the plan, not run, no transaction.
  const parsed = client([
    [
      "EXPLAIN (FORMAT JSON)",
      () => [{ "QUERY PLAN": JSON.parse(fixture("pg-page.json")) }],
    ],
    ["FROM pg_index", () => []],
    ["FROM pg_class", () => []],
  ]);
  const [again] = await explainStatements(
    parsed,
    "postgresql",
    [{ sql: 'SELECT * FROM "orders"' }],
    [],
    false
  );
  expect(again!.plan!.root.operation).toBe("Limit");
  expect(parsed.asked[1]!.params).toEqual([['"orders"']]);
});

test("MySQL: EXPLAIN ANALYZE, its aliases named as tables, the catalog", async () => {
  const sql = PAGE_SQL.replaceAll('"', "`").replace("`public`.", "");
  const my = client([
    ["EXPLAIN ANALYZE", () => [{ EXPLAIN: fixture("mysql-page.txt") }]],
    [
      "information_schema.STATISTICS",
      () => [
        { t: "orders", n: "PRIMARY", nu: 0, c: "id", k: "BTREE" },
        { t: "orders", n: "orders_page", nu: 1, c: "status", k: "BTREE" },
        { t: "orders", n: "orders_page", nu: 1, c: "createdAt", k: "BTREE" },
        { t: "orders", n: "orders_note_ft", nu: 1, c: "note", k: "FULLTEXT" },
      ],
    ],
    [
      "information_schema.COLUMNS",
      () => [
        { t: "orders", c: "id" },
        { t: "orders", c: "status" },
      ],
    ],
    ["information_schema.TABLES", () => [{ t: "orders", r: 199_642 }]],
  ]);
  const [explained] = await explainStatements(my, "mysql", [{ sql }], []);
  // Run again under MySQL's own time limit, as a hint.
  expect(my.asked[0]!.sql).toBe(
    `EXPLAIN ANALYZE ${sql.replace("SELECT", "SELECT /*+ MAX_EXECUTION_TIME(30000) */")}`
  );
  const plan = explained!.plan!;
  expect(plan.indexes.orders?.map((index) => index.name)).toEqual([
    "PRIMARY",
    "orders_page",
    "orders_note_ft",
  ]);
  expect(plan.indexes.orders?.[1]).toMatchObject({
    columns: ["status", "createdAt"],
    ordered: true,
  });
  expect(plan.indexes.orders?.[2]).toMatchObject({ ordered: false });
  expect(plan.columns).toEqual({ orders: ["id", "status"] });
  expect(plan.tableRows).toEqual({ orders: 199_642 });
  expect(plan.raw).toBe(fixture("mysql-page.txt"));
  const catalogCalls = my.asked.filter((entry) =>
    entry.sql.includes("information_schema")
  );
  expect(catalogCalls).toHaveLength(3);
  for (const entry of catalogCalls)
    expect(entry.params).toEqual([null, "orders"]);
  const qualified = client([
    ["EXPLAIN FORMAT=TREE", () => [{ EXPLAIN: fixture("mysql-page.txt") }]],
    ["information_schema", () => []],
  ]);
  await explainStatements(
    qualified,
    "mysql",
    [{ sql: sql.replace("FROM `orders`", "FROM `tenant`.`orders`") }],
    [],
    false
  );
  for (const entry of qualified.asked.filter((query) =>
    query.sql.includes("information_schema")
  )) {
    expect(entry.params).toEqual(["tenant", "orders"]);
    expect(entry.sql).toContain("TABLE_SCHEMA = COALESCE(?, DATABASE())");
  }
  // Estimated only: the tree, without running it.
  const estimated = client([
    ["EXPLAIN FORMAT=TREE", () => [{ EXPLAIN: fixture("mysql-page.txt") }]],
    ["information_schema", () => []],
  ]);
  await explainStatements(estimated, "mysql", [{ sql }], [], false);
  expect(estimated.asked[0]!.sql).toBe(`EXPLAIN FORMAT=TREE ${sql}`);
  // The scan of the statement's alias reads "orders"; a subquery's derived rows are no table.
  const scans = [
    plan.root,
    ...plan.root.children.flatMap(function all(node): (typeof plan.root)[] {
      return [node, ...node.children.flatMap(all)];
    }),
  ].filter((node) => node.operation === "Table scan");
  expect(scans.find((node) => node.alias === "q0")).toMatchObject({
    relation: "orders",
    fullScan: true,
  });
  // Refused by the database: said, not thrown.
  const old = client([
    [
      "EXPLAIN",
      () => {
        throw new Error("not supported");
      },
    ],
  ]);
  expect(
    await explainStatements(old, "mysql", [{ sql: "SELECT 1" }], [])
  ).toEqual([{ sql: "SELECT 1", error: "not supported" }]);
  const odd = client([
    [
      "EXPLAIN",
      () => {
        return Promise.reject("odd");
      },
    ],
  ]);
  expect(await explainStatements(odd, "mysql", [{}], [], false)).toEqual([
    { sql: "", error: "odd" },
  ]);
  // PostgreSQL answering no row: no plan.
  expect(
    (
      await explainStatements(
        client([["EXPLAIN", () => []]]),
        "postgresql",
        [{ sql: "SELECT 1" }],
        [],
        false
      )
    )[0]!.error
  ).toContain("no plan");
  // A plan with no row: refused as such.
  const empty = client([["EXPLAIN", () => []]]);
  expect(
    (await explainStatements(empty, "mysql", [{ sql: "SELECT 1" }], []))[0]!
      .error
  ).toContain("no plan");
});

test("Analyze refuses statements it cannot execute under a database timeout", async () => {
  const noReplay = client([]);
  for (const unsupported of [
    noReplay,
    {
      ...noReplay,
      $transaction() {
        /* Capability presence only; Analyze must refuse before dispatch. */
      },
    },
    {
      ...noReplay,
      $driver: null,
      $transaction() {
        /* Capability presence only; Analyze must refuse before dispatch. */
      },
    },
  ]) {
    const [result] = await explainStatements(
      unsupported,
      "postgresql",
      [{ sql: "SELECT 1" }],
      []
    );
    expect(result?.error).toContain("Use Estimate");
  }
  const [unsupported] = await explainStatements(noReplay, "mysql", [{}], []);
  expect(unsupported?.error).toContain("Cannot safely bound");
  expect(noReplay.asked).toHaveLength(0);
});

test("SQLite: the plan, the statement's own time, the catalog by pragma", async () => {
  const sql = `SELECT "q0"."status" FROM "orders" AS "q0" GROUP BY "q0"."status"`;
  const lite = client([
    ["EXPLAIN QUERY PLAN", () => JSON.parse(fixture("sqlite-group.json"))],
    [
      "PRAGMA table_info",
      () => [
        { name: "id", pk: 1, type: "INTEGER" },
        { name: "status", pk: 0 },
        { name: "customerId", pk: 0 },
      ],
    ],
    [
      "PRAGMA index_list",
      () => [
        { name: "orders_customerId_idx", unique: 0, partial: 0 },
        { name: "orders_open", unique: 0, partial: 1 },
      ],
    ],
    [
      'PRAGMA index_xinfo("orders_customerId_idx")',
      () => [
        { name: "customerId", key: 1, desc: 1 },
        { name: null, key: 0, desc: 0 },
      ],
    ],
    ["PRAGMA index_xinfo", () => [{ name: "status", key: 1, desc: 0 }]],
    ["SELECT count", () => [{ rows: 200_000 }]],
  ]);
  const [explained] = await explainStatements(
    lite,
    "sqlite",
    [{ sql, duration: 40 }],
    []
  );
  expect(explained!.plan).toMatchObject({
    analyzed: false,
    executionTime: 40,
    tableRows: { orders: 200_000 },
    columns: { orders: ["id", "status", "customerId"] },
    indexes: {
      orders: [
        // The rowid key, which index_list leaves out.
        { name: "PRIMARY KEY", unique: true, columns: ["id"] },
        {
          name: "orders_customerId_idx",
          unique: false,
          partial: false,
          columns: ["customerId"],
        },
        { name: "orders_open", partial: true, columns: ["status"] },
      ],
    },
  });
  expect(explained!.plan!.raw.split("\n")[0]).toMatch(TAB_SEPARATED);
  // The only index on "status" is partial: it holds not every row, so the grouping still wants one.
  expect(explained!.plan!.advice.map((entry) => entry.title)).toContain(
    'Plans to group "orders" in a temporary b-tree'
  );
  // No time measured, a table with no count, no table read: what is known.
  const bare = client([
    [
      "EXPLAIN QUERY PLAN",
      () => [{ id: 1, parent: 0, detail: "SCAN CONSTANT ROW" }],
    ],
  ]);
  const [constant] = await explainStatements(
    bare,
    "sqlite",
    [{ sql: "SELECT 1" }],
    []
  );
  expect(constant!.plan).toMatchObject({ indexes: {}, tableRows: {} });
  expect(constant!.plan).not.toHaveProperty("executionTime");
  const uncounted = client([
    ["EXPLAIN QUERY PLAN", () => [{ id: 1, parent: 0, detail: "SCAN t" }]],
    ["PRAGMA table_info", () => []],
    ["PRAGMA index_list", () => "not rows"],
    ["SELECT count", () => []],
  ]);
  const [counted] = await explainStatements(
    uncounted,
    "sqlite",
    [{ sql: 'SELECT * FROM "t" AS "t"' }],
    []
  );
  expect(counted!.plan!.tableRows).toEqual({ t: 0 });
});
