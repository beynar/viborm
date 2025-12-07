/**
 * OrderBy Builder
 *
 * Builds ORDER BY clauses from orderBy input.
 */

import { sql, Sql } from "@sql";
import type { QueryContext } from "../types";
import { isScalarField, getColumnName } from "../context";

type SortOrder = "asc" | "desc";
type NullsOrder = "first" | "last";

interface OrderByItem {
  [field: string]: SortOrder | { sort: SortOrder; nulls?: NullsOrder };
}

/**
 * Build ORDER BY clause
 *
 * @param ctx - Query context
 * @param orderBy - OrderBy input (object or array of objects)
 * @param alias - Current table alias
 * @returns SQL for ORDER BY or undefined if no ordering
 */
export function buildOrderBy(
  ctx: QueryContext,
  orderBy: Record<string, unknown> | Record<string, unknown>[] | undefined,
  alias: string
): Sql | undefined {
  if (!orderBy) return undefined;

  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  const orders: Sql[] = [];

  for (const item of items) {
    for (const [field, value] of Object.entries(item)) {
      if (value === undefined) continue;

      // Skip relation ordering for now (would need join or subquery)
      if (!isScalarField(ctx.model, field)) continue;

      // Resolve field name to actual column name (handles .map() overrides)
      const columnName = getColumnName(ctx.model, field);
      const column = ctx.adapter.identifiers.column(alias, columnName);
      const orderSql = buildSingleOrder(ctx, column, value);
      if (orderSql) orders.push(orderSql);
    }
  }

  if (orders.length === 0) return undefined;

  return sql.join(orders, ", ");
}

/**
 * Build a single order expression
 */
function buildSingleOrder(
  ctx: QueryContext,
  column: Sql,
  value: unknown
): Sql | undefined {
  const { adapter } = ctx;

  // Simple string: "asc" or "desc"
  if (typeof value === "string") {
    return value === "desc"
      ? adapter.orderBy.desc(column)
      : adapter.orderBy.asc(column);
  }

  // Object with sort and optional nulls
  if (typeof value === "object" && value !== null) {
    const { sort, nulls } = value as { sort?: SortOrder; nulls?: NullsOrder };

    let orderExpr = sort === "desc"
      ? adapter.orderBy.desc(column)
      : adapter.orderBy.asc(column);

    // Apply nulls ordering if specified
    if (nulls === "first") {
      orderExpr = adapter.orderBy.nullsFirst(orderExpr);
    } else if (nulls === "last") {
      orderExpr = adapter.orderBy.nullsLast(orderExpr);
    }

    return orderExpr;
  }

  return undefined;
}

