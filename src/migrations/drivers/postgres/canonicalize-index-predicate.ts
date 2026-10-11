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
 */
export async function canonicalizeIndexPredicates(
  table: string,
  predicates: readonly string[],
  executeRaw: RawExecutor
): Promise<ReadonlyArray<string | undefined>> {
  if (predicates.length === 0) return [];
  const views = predicates.map((_, position) =>
    quoteIdentifier(`${SCRATCH_VIEW_PREFIX}${position}`)
  );

  const projection = views
    .map(
      (view, position) =>
        `pg_catalog.pg_get_viewdef('pg_temp.${view}'::regclass) AS "d${position}"`
    )
    .join(", ");
  const deparse = async (queries: readonly (string | undefined)[]) => {
    for (const [position, query] of queries.entries()) {
      // OR REPLACE, not a bare CREATE: the projection is always `1 AS c`, so
      // a scratch view left by an earlier call on this pooled connection, or
      // by the first pass, is replaceable rather than a collision.
      if (query === undefined) continue;
      await executeRaw(
        `CREATE OR REPLACE TEMP VIEW ${views[position]} AS ${query}`
      );
    }
    const { rows } = await executeRaw<Record<string, string | null>>(
      `SELECT ${projection}`
    );
    // A position not reparsed has no answer: its view still holds the
    // previous pass's definition, which is not a fixed point.
    return queries.map((query, position) =>
      query === undefined ? undefined : (rows[0]?.[`d${position}`] ?? undefined)
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
  const twice = await deparse(
    once.map((query) => query?.replace(TRAILING_SEMICOLON, ""))
  );

  await executeRaw(
    `DROP VIEW ${views.map((view) => `pg_temp.${view}`).join(", ")}`
  );
  return twice;
}
