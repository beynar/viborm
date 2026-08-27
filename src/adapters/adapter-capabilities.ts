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
  /**
   * Whether this driver instance supports geospatial types and operations
   * (PostGIS on PostgreSQL). Absence means unsupported, so a custom adapter
   * written before this flag existed keeps its meaning.
   *
   * Migration introspection reads it beside {@link supportsVector} to tell an
   * enabled extension type from an unknown external UDT. SQL building keeps
   * reading the `geospatial` member the driver replaces with a throwing stub —
   * that replacement is the fail-closed path, this flag is the question
   * introspection asks without comparing function objects.
   */
  supportsGeospatial?: boolean;
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
