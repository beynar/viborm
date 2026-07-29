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
   * Whether the database has an EXACT decimal type it can compare and compute
   * with — `numeric` on PostgreSQL, `DECIMAL` on MySQL.
   *
   * SQLite does not. Its `DECIMAL` is a spelling with NUMERIC affinity, so any
   * fractional value ends up in an IEEE-754 double, and casting a text column
   * back to `NUMERIC`/`REAL` for a comparison puts the answer through that same
   * double. viborm therefore stores decimals as canonical TEXT on SQLite —
   * exact to write and to read, exact for equality — and REFUSES the operations
   * that would need exact ordering or exact arithmetic (`lt`/`lte`/`gt`/`gte`,
   * `orderBy`, `_min`/`_max`/`_sum`/`_avg`, atomic arithmetic). Answering them
   * at double precision would be a wrong answer with no way for the caller to
   * know, which this codebase treats as a defect rather than a compromise.
   */
  supportsExactDecimal: boolean;
}
