/** Database feature flags consulted by query construction. */
export interface DatabaseAdapterCapabilities {
  /** Whether database supports RETURNING clause (PG, SQLite 3.35+). */
  supportsReturning: boolean;
  /** Whether database supports CTEs with data-modifying statements. */
  supportsCteWithMutations: boolean;
  /** Whether database supports FULL OUTER JOIN. */
  supportsFullOuterJoin: boolean;
  /** Whether database supports LATERAL joins. */
  supportsLateralJoins: boolean;
  /** Whether this driver instance supports vector operations. */
  supportsVector: boolean;
  /** Whether database supports target/set WHERE clauses in upsert. */
  supportsUpsertWhere: boolean;
  /**
   * Whether the dialect's upsert grammar ARBITRATES ON THE NAMED TARGET.
   *
   * PostgreSQL and SQLite spell `INSERT … ON CONFLICT (cols) DO UPDATE`: only a
   * collision on `cols` takes the update branch, and a collision on any OTHER
   * unique index is raised as the constraint error it is. MySQL spells
   * `ON DUPLICATE KEY UPDATE`, which carries no target at all and fires on ANY
   * unique collision (`mysql-adapter.ts` `onConflict` ignores its `_target`
   * parameter and says so) — so an unrelated collision would silently ADOPT and
   * update a row the caller never named.
   *
   * That difference is a wrong answer, not a missing optimization, which is why
   * it is a capability and not an inference. It reads `false` on exactly the same
   * adapters as {@link DatabaseAdapterCapabilities.supportsReturning} today, and
   * that is a COINCIDENCE of the three adapters shipped, not an implication:
   * MariaDB has `RETURNING` on `INSERT` and still arbitrates on any key. Do not
   * collapse the two.
   */
  supportsTargetedUpsert: boolean;
  /** Whether a mutation may reference its target table in a subquery. */
  supportsMutationTargetInSubquery: boolean;
  /**
   * Whether a single-table `UPDATE`/`DELETE` accepts a native row cap
   * (`... LIMIT n`). MySQL does; PostgreSQL and SQLite (in the default builds
   * this project targets — `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` is off) do not,
   * so `updateMany`/`deleteMany` `limit` is realized there by restricting the
   * mutation's `WHERE` to a primary-key subquery that carries the `LIMIT`.
   * See `buildBulkLimitWhere` in query-engine/operations/bulk-limit.ts.
   */
  supportsMutationRowLimit: boolean;
  /**
   * Whether a read can lock the rows it takes (`SELECT … FOR UPDATE`).
   * PostgreSQL and MySQL do; SQLite locks the whole database and omits the
   * clause, so a read taken only to lock rows is skipped there.
   */
  supportsRowLocks: boolean;
  /**
   * Whether a locking read whose exact match finds NOTHING still takes a lock.
   * MySQL (InnoDB) does: a gap or next-key lock that two concurrent misses
   * both hold and that each one's INSERT then waits on, a deadlock. So a read
   * whose other arm inserts the key it looked for reads unlocked there and is
   * confirmed under lock once it finds a row. PostgreSQL locks only the rows a
   * read returns, so there that read locks what it finds and needs no
   * confirmation. SQLite takes no row lock at all (`supportsRowLocks`), so
   * its confirmation stays: it is the read that sees what changed. Absent:
   * false.
   */
  locksMissingKeys?: boolean;
  /**
   * Whether a statement states each relation filter body it repeats ONCE, in
   * a `WITH`, as the key set every arm repeating it tests (a semijoin on the
   * correlated columns), rather than once per arm. A driver declares it for
   * a provider that bounds one statement's text or the relations one
   * statement references; a statement that repeats no body is unchanged, and
   * a recursive walk stays where it is. Absent: false.
   */
  sharesRelationBodies?: boolean;
  /**
   * Whether a many-to-many relation filter reads its junction joined to the
   * target, correlated in the filter's own `WHERE` (`EXISTS (SELECT 1 FROM
   * junction j JOIN target t ON t.key = j.target WHERE j.source = parent.key
   * AND …)`), rather than as the target's membership in a correlated junction
   * subquery. `true` where the dialect plans the joined form at least as well
   * everywhere measured (SQLite); `"unbounded"` where it does only in a
   * statement whose root read is unbounded, a count, an aggregate, a
   * `findMany` without `take` or a write: PostgreSQL turns the join into a
   * hashed semijoin there (10–300× faster scans) but plans it about 0.2 ms
   * more slowly, which a bounded read (a unique, first or existence read, a
   * `take`) pays without the scan to win it back. Absent: false.
   */
  joinsJunctionFilters?: boolean | "unbounded";
  /**
   * Whether a recursive CTE fails once it runs a fixed number of iterations
   * (MySQL's `cte_max_recursion_depth`, 1000 by default): a recursive filter
   * then keeps its walk in place, whose anchor holds the first hop, rather
   * than a reaching set, which spends one iteration per depth from its
   * anchor. Absent: false.
   */
  boundsRecursionIterations?: boolean;
  /**
   * The most terms one compound `SELECT` may chain, where the transport
   * bounds it below anything the engine writes: Cloudflare D1, 5. The engine
   * nests a longer union in derived tables of at most that many. Absent:
   * unbounded.
   */
  compoundSelectTerms?: number;
  /**
   * Whether the transport bounds expression depth below what nested relation
   * filters reach unless each level reads from a derived table SQLite
   * flattens (D1, depth 100; `SQLiteAdapter({ deepExpressions: false })`):
   * a relation filter's own `EXISTS` then joins no flag member. Absent: false.
   */
  boundsExpressionDepth?: boolean;
  /**
   * Where relation bodies are shared, the relations (`FROM` items) a
   * statement may reference before the engine trades plans for fewer:
   * PlanetScale Neki refuses a statement over 256. Over it, a recursive
   * filter's walk the statement repeats becomes one reaching set, then rows
   * join the key sets they test, each as far as the statement needs. Absent:
   * unbounded, so neither.
   */
  relationsPerStatement?: number;
}
