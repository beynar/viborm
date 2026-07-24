import type { DatabaseAdapter } from "@adapters/database-adapter";
import { type Sql, sql } from "@sql";

/** Include options type for inline destructuring */
export type IncludeOptions = {
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown> | Record<string, unknown>[];
  take?: number;
  skip?: number;
};

/**
 * Assemble a standard inner query:
 * SELECT selectExpr FROM from [joins...] WHERE where [ORDER BY orderBy] [LIMIT take] [OFFSET skip]
 *
 * @internal Exported for testing
 */
export function assembleInnerQuery(
  adapter: DatabaseAdapter,
  selectExpr: Sql,
  from: Sql,
  joins: Sql[] | undefined,
  where: Sql,
  orderBy: Sql | undefined,
  take: number | undefined,
  skip: number | undefined
): Sql {
  const parts: Sql[] = [
    adapter.clauses.select(selectExpr),
    adapter.clauses.from(from),
  ];

  if (joins && joins.length > 0) {
    parts.push(...joins);
  }

  parts.push(adapter.clauses.where(where));

  if (orderBy) {
    parts.push(adapter.clauses.orderBy(orderBy));
  }

  if (take !== undefined) {
    parts.push(adapter.clauses.limit(adapter.literals.value(take)));
  } else if ((skip !== undefined || orderBy) && adapter.noLimitValue) {
    // MySQL/SQLite reject OFFSET without LIMIT; emit their "no limit" sentinel.
    // Also required with ORDER BY: without a LIMIT, MySQL merges the derived
    // table into the outer query and drops its ORDER BY, so JSON_ARRAYAGG
    // aggregates in arbitrary order. The sentinel forces materialization.
    parts.push(adapter.clauses.limit(adapter.noLimitValue));
  }

  if (skip !== undefined) {
    parts.push(adapter.clauses.offset(adapter.literals.value(skip)));
  }

  return sql.join(parts, " ");
}
