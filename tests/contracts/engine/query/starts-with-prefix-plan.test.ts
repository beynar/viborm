import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type Dialect, Driver } from "@drivers";
import type { PGlite } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import Database from "better-sqlite3";
import { Client as PgClient } from "pg";
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
 *
 * PostgreSQL's range is NOT unconditional, and this file must not be read as
 * saying it is. It needs byte-ordered index keys, which a `C`-collated
 * database gives for free and a default-locale one does not. So the two
 * PostgreSQL describes below are deliberately split by substrate:
 *
 *   - PGlite is `datcollate = 'C'`, and its describe asserts that precondition
 *     before claiming anything, so it can never silently certify the general
 *     case.
 *   - The Docker leg (`PG_TEST_CONNECTION_STRING`, `en_US.utf8`) pins what
 *     actually happens without the precondition: neither spelling ranges, and
 *     what survives is the row estimate. Skipped when the container is absent.
 */

const ROW_COUNT = 20_000;
const TABLE = "prefix_plan_docs";
/** Rows whose title starts with 'name123': name123, name1230..name1239, etc. */
const PREFIX = "name123";
const PREFIX_MATCHES = 111;
/** The lower bound PostgreSQL derives from the prefix pattern. */
const PG_INDEX_RANGE = /Index Cond:.*title >= 'name123'/;
/** The planner's row estimate, as EXPLAIN spells it on the top plan node. */
const PG_ROW_ESTIMATE = /rows=(\d+)/;

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
 * The database is the worker's ONE PGlite and this file takes only a private
 * schema in it. A second Wasm Postgres of its own costs ~1.3 GiB, which is what
 * kept this file from sharing a process with anything else.
 *
 * The family is given NO models on purpose. This file builds its measured table
 * by hand — 20 000 rows, an index, ANALYZE — and every case below reads that one
 * table, so what it wants from the family is the namespace, not managed
 * contents. With no table registered when the family is provisioned, the
 * family's per-test TRUNCATE has nothing to erase and the measurement stands
 * from `beforeAll` to the last case; the schema is dropped CASCADE when the file
 * ends, taking the table and its index with it.
 */
const getFamily = usePGliteSchemaFamily({});

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

describe("PostgreSQL prefix plans (C-collated substrate)", () => {
  let db: PGlite;
  /**
   * The measured table, SCHEMA-QUALIFIED. Every statement in this describe is
   * verbatim SQL that no driver rewrites, and an unqualified name would resolve
   * against `public`, where this file has no table at all.
   */
  let table: string;

  beforeAll(async () => {
    const family = getFamily();
    db = family.database;
    table = `"${family.namespace}"."${TABLE}"`;
    await db.exec(
      `CREATE TABLE ${table} (id text PRIMARY KEY, title text NOT NULL);`
    );
    await db.exec(
      `INSERT INTO ${table} (id, title)
       SELECT g::text, 'name' || g || '_suffix' FROM generate_series(1,${ROW_COUNT}) g;`
    );
    await db.exec(`CREATE INDEX prefix_plan_title ON ${table} (title);`);
    await db.exec(`ANALYZE ${table};`);
  }, 120_000);

  // No teardown of the database here: it belongs to the worker and serves every
  // other suite in this process. The family drops this file's schema — and with
  // it the table and index above — when the file finishes.

  const planFor = async (predicate: string, values: unknown[]) => {
    const result = await db.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (COSTS OFF) SELECT id FROM ${table} WHERE ${predicate}`,
      values
    );
    return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
  };

  test("PRECONDITION: this database is C-collated, which is what buys the range", async () => {
    // Every claim below depends on it. On a default-locale cluster a plain
    // btree stores locale sort keys, `match_pattern_prefix` cannot use them,
    // and the range disappears — see the `en_US.utf8` describe at the bottom
    // of this file. Asserting it here keeps this describe from reading as a
    // statement about PostgreSQL in general.
    const collation = await db.query<{ datcollate: string }>(
      "SELECT datcollate FROM pg_database WHERE datname = current_database()"
    );
    expect(collation.rows[0]?.datcollate).toBe("C");
  });

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
      `SELECT id FROM ${table} WHERE ${predicate}`,
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

/**
 * The same measurement without the collation precondition, on the Docker leg
 * the plan's Rules make mandatory (`postgres:16`, `datcollate = en_US.utf8` —
 * what a default `initdb` produces).
 *
 * This describe exists because the PGlite one above cannot see the common
 * case. It pins two things: that the index range is genuinely gone here, and
 * that what remains — the row estimate — is real and is why the spelling still
 * stands. Both are what Decision 7.3 now claims; neither was witnessed before.
 */
const PG_CONNECTION_STRING = process.env.PG_TEST_CONNECTION_STRING;
const describeIfDockerPg = PG_CONNECTION_STRING ? describe : describe.skip;
const LOCALE_TABLE = "prefix_plan_locale_probe";
/** A prefix wide enough that a flat default estimate is visibly wrong. */
const WIDE_PREFIX = "name1";
const WIDE_PREFIX_MATCHES = 11_111;

describeIfDockerPg("PostgreSQL prefix plans (default-locale substrate)", () => {
  let client: PgClient;

  beforeAll(async () => {
    client = new PgClient({ connectionString: PG_CONNECTION_STRING });
    await client.connect();
    // Own table, own teardown: the sibling driver suites push() against this
    // same database and drop whatever their schema does not name.
    await client.query(`DROP TABLE IF EXISTS ${LOCALE_TABLE}`);
    await client.query(
      `CREATE TABLE ${LOCALE_TABLE} (id text PRIMARY KEY, title text NOT NULL)`
    );
    await client.query(
      `INSERT INTO ${LOCALE_TABLE} (id, title)
       SELECT g::text, 'name' || g || '_suffix' FROM generate_series(1,${ROW_COUNT}) g`
    );
    // The only index viborm's emitter can produce: no operator class.
    await client.query(
      `CREATE INDEX ${LOCALE_TABLE}_title ON ${LOCALE_TABLE} (title)`
    );
    await client.query(`ANALYZE ${LOCALE_TABLE}`);
  }, 120_000);

  afterAll(async () => {
    await client?.query(`DROP TABLE IF EXISTS ${LOCALE_TABLE}`);
    await client?.end();
  });

  const planFor = async (predicate: string, values: unknown[]) => {
    const result = await client.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT id FROM ${LOCALE_TABLE} WHERE ${predicate}`,
      values
    );
    return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
  };

  /** The planner's row estimate for a predicate, read off the top plan node. */
  const estimateFor = async (predicate: string, values: unknown[]) => {
    const plan = await planFor(predicate, values);
    const match = plan.match(PG_ROW_ESTIMATE);
    if (!match) {
      throw new Error(`no row estimate in plan: ${plan}`);
    }
    return Number(match[1]);
  };

  const shippedPredicate = (prefix: string) =>
    predicateFor(
      new PostgresAdapter(),
      "postgresql",
      { title: { startsWith: prefix } },
      "$n"
    );

  test("PRECONDITION: this cluster is NOT C-collated", async () => {
    // The whole point of this describe. If someone re-creates the container
    // with `--locale=C` these assertions would start passing for the wrong
    // reason, so the substrate is asserted, not assumed.
    const collation = await client.query<{ datcollate: string }>(
      "SELECT datcollate FROM pg_database WHERE datname = current_database()"
    );
    expect(collation.rows[0]?.datcollate).not.toBe("C");
  });

  test("the shipped spelling does NOT range here — and neither did the one it replaced", async () => {
    const { predicate, values } = shippedPredicate(PREFIX);
    const shipped = await planFor(predicate, values);
    expect(shipped).toContain("Seq Scan");
    expect(shipped).not.toContain("Index Cond");

    const replaced = await planFor("LEFT(title, LENGTH($1)) = $1", [PREFIX]);
    expect(replaced).toContain("Seq Scan");
    expect(replaced).not.toContain("Index Cond");
  });

  test("it is still exact — the seq scan answers with the same rows", async () => {
    const { predicate, values } = shippedPredicate(PREFIX);
    const rows = await client.query(
      `SELECT id FROM ${LOCALE_TABLE} WHERE ${predicate}`,
      values
    );
    expect(rows.rowCount).toBe(PREFIX_MATCHES);
  });

  test("what survives is the estimate: LIKE tracks the data, LEFT is a constant", async () => {
    const narrow = await shippedPredicate(PREFIX);
    const wide = await shippedPredicate(WIDE_PREFIX);
    const narrowEstimate = await estimateFor(narrow.predicate, narrow.values);
    const wideEstimate = await estimateFor(wide.predicate, wide.values);

    const narrowLeft = await estimateFor("LEFT(title, LENGTH($1)) = $1", [
      PREFIX,
    ]);
    const wideLeft = await estimateFor("LEFT(title, LENGTH($1)) = $1", [
      WIDE_PREFIX,
    ]);

    // The truths the two prefixes actually have, two orders of magnitude apart.
    const wideRows = await client.query(
      `SELECT id FROM ${LOCALE_TABLE} WHERE ${wide.predicate}`,
      wide.values
    );
    expect(wideRows.rowCount).toBe(WIDE_PREFIX_MATCHES);

    // `LEFT(...)` is an opaque function call: the planner cannot tell the two
    // prefixes apart and guesses the same number for both.
    expect(wideLeft).toBe(narrowLeft);
    expect(wideLeft).toBeLessThan(WIDE_PREFIX_MATCHES / 10);

    // The shipped spelling tracks instead — the estimate moves with the data.
    expect(wideEstimate).toBeGreaterThan(narrowEstimate * 10);
    expect(wideEstimate).toBeGreaterThan(wideLeft * 10);
  });

  test("only an operator-class index restores the range — and viborm cannot emit one", async () => {
    // Named so the fix is unambiguous if it is ever taken: this is the index
    // `generateCreateIndex` has no vocabulary for, which is why Decision 7.3
    // records the companion index as an open residual rather than shipping it.
    await client.query(
      `CREATE INDEX ${LOCALE_TABLE}_title_pat ON ${LOCALE_TABLE} (title text_pattern_ops)`
    );
    try {
      await client.query(`ANALYZE ${LOCALE_TABLE}`);
      const { predicate, values } = shippedPredicate(PREFIX);
      const plan = await planFor(predicate, values);
      expect(plan).toContain(`Index Scan on ${LOCALE_TABLE}_title_pat`);
      expect(plan).toContain("Index Cond");
    } finally {
      await client.query(`DROP INDEX ${LOCALE_TABLE}_title_pat`);
      await client.query(`ANALYZE ${LOCALE_TABLE}`);
    }
  });
});
