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
}
