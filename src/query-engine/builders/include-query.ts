import type { DatabaseAdapter, QueryParts } from "@adapters/database-adapter";
import type { Sql } from "@sql";

/** Include options type for inline destructuring */
export type IncludeOptions = {
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown> | Record<string, unknown>[];
  take?: number;
  skip?: number;
  /** whereUnique of the RELATED model — applied per parent inside the subquery */
  cursor?: Record<string, unknown>;
  /** Scalar field names of the RELATED model — deduplicated per parent */
  distinct?: string[];
};

/** The inner query of a relation include, before JSON aggregation. */
export interface InnerQueryParts {
  /** The projected expression (already aliased) */
  selectExpr: Sql;
  from: Sql;
  joins?: Sql[];
  where: Sql;
  orderBy?: Sql;
  take?: number;
  skip?: number;
  /** DISTINCT columns of the related model */
  distinct?: Sql;
  /** Output aliases of `selectExpr` — projected by the DISTINCT emulation */
  distinctColumnAliases?: string[];
}

/**
 * Assemble a standard inner query:
 * SELECT selectExpr FROM from [joins...] WHERE where [ORDER BY orderBy] [LIMIT take] [OFFSET skip]
 *
 * It goes through the adapter's own select assembly, so a relation window gets
 * the same `DISTINCT ON` / ROW_NUMBER-partition emulation the top-level window
 * gets — inside the subquery, which is already scoped to one parent row.
 *
 * @internal Exported for testing
 */
export function assembleInnerQuery(
  adapter: DatabaseAdapter,
  parts: InnerQueryParts
): Sql {
  const query: QueryParts = {
    columns: parts.selectExpr,
    from: parts.from,
    where: parts.where,
  };

  if (parts.joins && parts.joins.length > 0) {
    query.joins = parts.joins;
  }

  if (parts.orderBy) {
    query.orderBy = parts.orderBy;
  }

  if (parts.take !== undefined) {
    query.limit = adapter.literals.value(parts.take);
  } else if (
    (parts.skip !== undefined || parts.orderBy) &&
    adapter.noLimitValue
  ) {
    // MySQL/SQLite reject OFFSET without LIMIT; emit their "no limit" sentinel.
    // Also required with ORDER BY: without a LIMIT, MySQL merges the derived
    // table into the outer query and drops its ORDER BY, so JSON_ARRAYAGG
    // aggregates in arbitrary order. The sentinel forces materialization.
    query.limit = adapter.noLimitValue;
  }

  if (parts.skip !== undefined) {
    query.offset = adapter.literals.value(parts.skip);
  }

  if (parts.distinct) {
    query.distinct = parts.distinct;
    if (parts.distinctColumnAliases) {
      query.distinctColumnAliases = parts.distinctColumnAliases;
    }
  }

  return adapter.assemble.select(query);
}
