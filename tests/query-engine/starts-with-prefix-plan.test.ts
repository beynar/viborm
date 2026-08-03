import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type Dialect, Driver } from "@drivers";
import { PGlite } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { createSchemaRegistry } from "@validation";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * The measurement Decision 7.3 rests on, run as a test.
 *
 * The claim is not "the SQL says LIKE" — that is pinned next door in
 * `starts-with-prefix-sql.test.ts`. The claim is that a planner turns the
 * emitted predicate into an INDEX RANGE, and that the spelling it replaced
 * could not be. So these take the statement the engine actually builds, hand
 * it to a real planner over a real index, and read the plan back.
 *
 * Both halves matter and both are asserted: the new spelling ranges, and the
 * old one scans. Without the second half a planner that ranged on everything
 * would pass this file while proving nothing.
 */

const ROW_COUNT = 20_000;
const TABLE = "prefix_plan_docs";
/** Rows whose title starts with 'name123': name123, name1230..name1239, etc. */
const PREFIX = "name123";
const PREFIX_MATCHES = 111;
/** The lower bound PostgreSQL derives from the prefix pattern. */
const PG_INDEX_RANGE = /Index Cond:.*title >= 'name123'/;

class MockDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `prefix-plan-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // SQL-only driver.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (transaction: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const Doc = s
  .model({
    id: s.string().id(),
    title: s.string(),
  })
  .map(TABLE);

const schema = { Doc };

beforeAll(() => hydrateSchemaNames(schema));

/**
 * The WHERE predicate the engine builds for `where`, and its bound values.
 *
 * Only the predicate is taken: the SELECT list is irrelevant to the plan
 * shape, and pinning it here would couple this file to the projection builder.
 */
function predicateFor(
  adapter: DatabaseAdapter,
  dialect: Dialect,
  where: Record<string, unknown>,
  placeholder: "$n" | "?"
): { predicate: string; values: unknown[] } {
  const engine = new QueryEngine(
    new MockDriver(adapter, dialect),
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
  const query = engine.build(Doc, "findMany", { where });
  const statement = query.toStatement(placeholder);
  const predicate = statement.slice(
    statement.indexOf("WHERE") + "WHERE ".length
  );
  // The predicate is qualified with the query's own alias; this file runs it
  // against a bare table, so the alias qualifier is dropped.
  return {
    predicate: predicate.replace(/["`]t0["`]\./g, ""),
    values: query.values,
  };
}

describe("PostgreSQL prefix plans", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(
      `CREATE TABLE ${TABLE} (id text PRIMARY KEY, title text NOT NULL);`
    );
    await db.exec(
      `INSERT INTO ${TABLE} (id, title)
       SELECT g::text, 'name' || g || '_suffix' FROM generate_series(1,${ROW_COUNT}) g;`
    );
    await db.exec(`CREATE INDEX prefix_plan_title ON ${TABLE} (title);`);
    await db.exec(`ANALYZE ${TABLE};`);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  const planFor = async (predicate: string, values: unknown[]) => {
    const result = await db.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (COSTS OFF) SELECT id FROM ${TABLE} WHERE ${predicate}`,
      values
    );
    return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
  };

  test("default-mode startsWith becomes an index range", async () => {
    const { predicate, values } = predicateFor(
      new PostgresAdapter(),
      "postgresql",
      { title: { startsWith: PREFIX } },
      "$n"
    );
    const plan = await planFor(predicate, values);

    expect(plan).toContain("Index Scan on prefix_plan_title");
    // The range itself, not merely "an index was touched".
    expect(plan).toMatch(PG_INDEX_RANGE);
    expect(plan).not.toContain("Seq Scan");
  });

  test("the range narrows to the matching rows, and they are the right ones", async () => {
    const { predicate, values } = predicateFor(
      new PostgresAdapter(),
      "postgresql",
      { title: { startsWith: PREFIX } },
      "$n"
    );
    const rows = await db.query<{ id: string }>(
      `SELECT id FROM ${TABLE} WHERE ${predicate}`,
      values
    );
    expect(rows.rows).toHaveLength(PREFIX_MATCHES);
  });

  test("the spelling 7.3 replaced could not range — it seq-scans", async () => {
    // The `LEFT(col, LENGTH($1)) = $1` shape, still reachable through a
    // field-reference operand. Wrapping the column in a function is exactly
    // what forecloses the range, which is the whole finding.
    const plan = await planFor("LEFT(title, LENGTH($1)) = $1", [PREFIX]);
    expect(plan).toContain("Seq Scan");
    expect(plan).not.toContain("Index Cond");
  });

  test("endsWith seq-scans under either spelling, which is why it did not move", async () => {
    const { predicate, values } = predicateFor(
      new PostgresAdapter(),
      "postgresql",
      { title: { endsWith: "9_suffix" } },
      "$n"
    );
    expect(await planFor(predicate, values)).toContain("Seq Scan");
    // The LIKE spelling it was NOT moved to fares no better: a suffix pattern
    // has no prefix to range on.
    expect(
      await planFor(`title LIKE $1 ESCAPE '\\'`, ["%9\\_suffix"])
    ).toContain("Seq Scan");
  });
});

describe("SQLite prefix plans", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec(
      `CREATE TABLE ${TABLE} (id TEXT PRIMARY KEY, title TEXT NOT NULL);`
    );
    const insert = db.prepare(`INSERT INTO ${TABLE} (id, title) VALUES (?, ?)`);
    db.transaction(() => {
      for (let i = 1; i <= ROW_COUNT; i++) {
        insert.run(String(i), `name${i}_suffix`);
      }
    })();
    // An ordinary index — BINARY collation, which is all `push()` ever emits.
    db.exec(`CREATE INDEX prefix_plan_title ON ${TABLE} (title);`);
    db.exec("ANALYZE;");
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

  const planFor = (predicate: string, values: unknown[]) =>
    db
      .prepare(`EXPLAIN QUERY PLAN SELECT id FROM ${TABLE} WHERE ${predicate}`)
      .all(...values)
      .map((row) => (row as { detail: string }).detail)
      .join("\n");

  test("default-mode startsWith becomes an index range", () => {
    const { predicate, values } = predicateFor(
      new SQLiteAdapter(),
      "sqlite",
      { title: { startsWith: PREFIX } },
      "?"
    );
    const plan = planFor(predicate, values);

    expect(plan).toContain(
      "SEARCH prefix_plan_docs USING INDEX prefix_plan_title"
    );
    // The range itself. SQLite spells a GLOB prefix bound exactly like a LIKE
    // one, which is the point: the index does the narrowing, not a filter.
    expect(plan).toContain("title>? AND title<?");
    expect(plan).not.toContain("SCAN ");
  });

  test("the range returns exactly the matching rows", () => {
    const { predicate, values } = predicateFor(
      new SQLiteAdapter(),
      "sqlite",
      { title: { startsWith: PREFIX } },
      "?"
    );
    const rows = db
      .prepare(`SELECT id FROM ${TABLE} WHERE ${predicate}`)
      .all(...values);
    expect(rows).toHaveLength(PREFIX_MATCHES);
  });

  test("the spelling 7.3 replaced could not range — it scans", () => {
    const plan = planFor("substr(title, 1, length(?)) COLLATE BINARY = ?", [
      PREFIX,
      PREFIX,
    ]);
    expect(plan).toContain("SCAN ");
  });

  test("escaped LIKE would have scanned AND answered case-insensitively", () => {
    // Why SQLite took GLOB rather than the escaped LIKE the decision named.
    // Both halves of the refusal, on the same connection and index.
    expect(planFor(`title LIKE ? ESCAPE '\\'`, [`${PREFIX}%`])).toContain(
      "SCAN "
    );
    const likeUpper = db
      .prepare(
        `SELECT count(*) AS c FROM ${TABLE} WHERE title LIKE ? ESCAPE '\\'`
      )
      .get(`${PREFIX.toUpperCase()}%`) as { c: number };
    expect(likeUpper.c).toBe(PREFIX_MATCHES);

    // GLOB, which is what shipped, refuses the wrong case.
    const globUpper = db
      .prepare(`SELECT count(*) AS c FROM ${TABLE} WHERE title GLOB ?`)
      .get(`${PREFIX.toUpperCase()}*`) as { c: number };
    expect(globUpper.c).toBe(0);
  });
});
