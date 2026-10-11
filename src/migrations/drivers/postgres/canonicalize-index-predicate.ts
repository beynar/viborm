/**
 * Decision 7.4 — the declared partial-index predicate, canonicalized by the
 * database that will store it.
 *
 * PostgreSQL's catalog does not keep the statement it was given. `CREATE INDEX
 * … WHERE published = true` is parsed into a node tree, and
 * `pg_get_expr(indpred, indrelid)` deparses that tree back out as
 * `(published = true)`. The introspection reads the deparsed form; the
 * serializer holds the declared form; they never compare equal, so **every push
 * dropped and re-created every partial index**. SQLite has no such gap — it
 * stores the CREATE INDEX text verbatim — which is why only this dialect
 * implements the hook.
 *
 * The fix asks PostgreSQL itself. A predicate is put through the same parse and
 * deparse the catalog performs, and the differ compares the two answers. If
 * both texts deparse to one text they are one predicate; if either cannot be
 * deparsed, nothing is claimed and the drop/create stands. No client-side text
 * normalization can do this and stay fail-closed: flattening whitespace and
 * parentheses makes `a AND (b OR c)` read equal to `(a AND b) OR c`, and a real
 * predicate change would stop being seen.
 *
 * The vehicle is a session-local view: `SELECT 1 AS c FROM <table> WHERE <p>`,
 * read back with `pg_get_viewdef`. A view is the cheapest parse-and-store
 * PostgreSQL offers — no table scan, no data touched, only an ACCESS SHARE lock
 * on the table, and nothing outside this session can see it. A CHECK constraint
 * or a real index would each parse the same expression, but one locks the table
 * against writers and the other builds the index this is trying to avoid
 * building.
 *
 * Both sides of the comparison go through this same transform, so the answer
 * does not depend on `pg_get_viewdef` and `pg_get_expr` agreeing on
 * parenthesization — only on each being a function of the parsed tree.
 *
 * The predicate is interpolated, not bound: it is an expression, and no
 * parameter placeholder can carry one. It reaches here from the schema's own
 * `.index({ where })`, the same text the emitter already interpolates into
 * `CREATE INDEX`, so this widens nothing.
 */

const SCRATCH_VIEW_PREFIX = "viborm_index_predicate_";
const TRAILING_SEMICOLON = /;\s*$/;

type RawExecutor = <T>(
  sql: string,
  params?: unknown[]
) => Promise<{ rows: T[] }>;

/** Sends statements as ONE request, in one transaction, answering each. */
export type BatchExecutor = <T>(
  statements: readonly string[]
) => Promise<ReadonlyArray<{ rows: T[] }>>;

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Deparses each predicate through PostgreSQL and returns the answers
 * positionally.
 *
 * `table` arrives ALREADY QUALIFIED and quoted by the bound migration driver.
 * The scratch view is parsed on whatever `search_path` the session carries, so
 * a bare name would canonicalize this estate's predicate against a same-named
 * table in another schema — and then hand that answer to the differ as if it
 * described the estate's own index.
 *
 * Throws rather than reporting a failure per predicate. The caller runs this
 * inside one transaction: a statement that fails aborts it, every later
 * statement in it fails too, and the rollback is what removes the scratch views
 * — which must go, because a view referencing a table blocks dropping that
 * table later in the same push.
 *
 * Each pass creates, reads and drops its views. `executeBatch`, on a transport
 * with no session (Neon HTTP, plan D7), sends each pass as one request: its
 * statements in one transaction, so on one backend, where separate requests
 * may each land on another.
 */
export async function canonicalizeIndexPredicates(
  table: string,
  predicates: readonly string[],
  executeRaw: RawExecutor,
  executeBatch?: BatchExecutor
): Promise<ReadonlyArray<string | undefined>> {
  if (predicates.length === 0) return [];
  const run: BatchExecutor =
    executeBatch ??
    (async <T>(statements: readonly string[]) => {
      const results: { rows: T[] }[] = [];
      for (const sql of statements) results.push(await executeRaw<T>(sql));
      return results;
    });
  const deparse = async (queries: readonly (string | undefined)[]) => {
    // A position with no query has no answer, and no view.
    const live = [...queries.keys()].filter(
      (position) => queries[position] !== undefined
    );
    if (live.length === 0) return queries.map(() => undefined);
    const views = live.map((position) =>
      quoteIdentifier(`${SCRATCH_VIEW_PREFIX}${position}`)
    );
    const results = await run<Record<string, string | null>>([
      // OR REPLACE, not a bare CREATE: the projection is always `1 AS c`, so
      // a scratch view left on this pooled connection is replaceable rather
      // than a collision.
      ...live.map(
        (position, index) =>
          `CREATE OR REPLACE TEMP VIEW ${views[index]} AS ${queries[position]}`
      ),
      `SELECT ${views
        .map(
          (view, index) =>
            `pg_catalog.pg_get_viewdef('pg_temp.${view}'::regclass) AS "d${live[index]}"`
        )
        .join(", ")}`,
      `DROP VIEW ${views.map((view) => `pg_temp.${view}`).join(", ")}`,
    ]);
    const row = results[live.length]?.rows[0];
    return queries.map((query, position) =>
      query === undefined ? undefined : (row?.[`d${position}`] ?? undefined)
    );
  };

  // Two passes: one parse and deparse is not a fixed point. PostgreSQL
  // expands BETWEEN after its grammar has flattened AND, so a declared
  // `a BETWEEN x AND y AND b` parses to a nested AND, which its own deparse
  // (the catalog's text) reparses flat. Parsing each answer once more gives
  // the declared and the catalog spelling the same tree.
  const once = await deparse(
    predicates.map(
      (predicate) => `SELECT 1 AS c FROM ${table} WHERE ${predicate}`
    )
  );
  return deparse(once.map((query) => query?.replace(TRAILING_SEMICOLON, "")));
}
