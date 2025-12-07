/**
 * Aggregate Utilities
 *
 * Shared helpers for building aggregate expressions.
 * Used by both aggregate and groupBy operations.
 */

import { Sql } from "@sql";
import type { QueryContext } from "../types";
import { getColumnName } from "../context";

/**
 * Aggregate function types
 */
export type AggregateType = "count" | "avg" | "sum" | "min" | "max";

/**
 * Build _count aggregate expression
 *
 * Accepts:
 * - true: count all rows (COUNT(*))
 * - { _all: true, fieldName: true, ... }: count specific fields wrapped in JSON
 *
 * @param ctx - Query context
 * @param countSpec - Count specification
 * @param alias - Table alias
 * @returns SQL expression for count aggregate (aliased)
 */
export function buildCountAggregate(
  ctx: QueryContext,
  countSpec: true | Record<string, boolean>,
  alias: string
): Sql | undefined {
  const { adapter } = ctx;

  // Simple count all
  if (countSpec === true) {
    return adapter.identifiers.aliased(adapter.aggregates.count(), "_count");
  }

  // Object with field selections
  const entries = Object.entries(countSpec).filter(([, include]) => include);
  if (entries.length === 0) return undefined;

  // Build JSON object with count for each field
  const pairs: [string, Sql][] = entries.map(([field]) => {
    if (field === "_all") {
      return ["_all", adapter.aggregates.count()];
    }
    // Resolve field name to actual column name (handles .map() overrides)
    const columnName = getColumnName(ctx.model, field);
    return [field, adapter.aggregates.count(adapter.identifiers.column(alias, columnName))];
  });

  return adapter.identifiers.aliased(adapter.json.objectFromColumns(pairs), "_count");
}

/**
 * Build aggregate column expression for count, avg, sum, min, or max
 *
 * @param ctx - Query context
 * @param spec - Field specification { fieldName: true, ... } or true for count all
 * @param alias - Table alias
 * @param aggType - Aggregate type
 * @returns SQL expression for aggregate (aliased) or undefined if no fields
 */
export function buildAggregateColumn(
  ctx: QueryContext,
  spec: true | Record<string, boolean>,
  alias: string,
  aggType: AggregateType
): Sql | undefined {
  const { adapter } = ctx;

  // Handle count specially - can be `true` or object
  if (aggType === "count") {
    return buildCountAggregate(ctx, spec, alias);
  }

  // For other aggregates, spec must be an object
  if (spec === true) return undefined;

  const entries = Object.entries(spec).filter(([, include]) => include);
  if (entries.length === 0) return undefined;

  // Get the appropriate aggregate function
  const aggFn = getAggregateFn(adapter, aggType);
  const aggName = `_${aggType}`;

  const pairs: [string, Sql][] = entries.map(([field]) => {
    // Resolve field name to actual column name (handles .map() overrides)
    const columnName = getColumnName(ctx.model, field);
    return [field, aggFn(adapter.identifiers.column(alias, columnName))];
  });

  return adapter.identifiers.aliased(adapter.json.objectFromColumns(pairs), aggName);
}

/**
 * Get the aggregate function from adapter based on type
 */
function getAggregateFn(
  adapter: QueryContext["adapter"],
  aggType: "avg" | "sum" | "min" | "max"
): (expr: Sql) => Sql {
  switch (aggType) {
    case "avg":
      return adapter.aggregates.avg;
    case "sum":
      return adapter.aggregates.sum;
    case "min":
      return adapter.aggregates.min;
    case "max":
      return adapter.aggregates.max;
  }
}
