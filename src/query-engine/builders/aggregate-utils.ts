/**
 * Aggregate Utilities
 *
 * Shared helpers for building aggregate expressions.
 * Used by both aggregate and groupBy operations.
 */

import type { Sql } from "@sql";
import { getColumnName } from "../context";
import { getAggregateResultKey } from "../result-aliases";
import type { QueryScope } from "../types";
import { assertExactDecimalOperation } from "./decimal-portability";

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
  ctx: QueryScope,
  countSpec: true | Record<string, boolean>,
  alias: string
): Sql | undefined {
  const { adapter } = ctx;

  // Simple count all
  if (countSpec === true) {
    return adapter.identifiers.aliased(
      adapter.aggregates.count(),
      getAggregateResultKey("_count")
    );
  }

  // Object with field selections
  const entries = Object.entries(countSpec).filter(([, include]) => include);
  if (entries.length === 0) {
    return undefined;
  }

  // Build JSON object with count for each field
  const pairs: [string, Sql][] = entries.map(([field]) => {
    if (field === "_all") {
      return ["_all", adapter.aggregates.count()];
    }
    // Resolve field name to actual column name (handles .map() overrides)
    const columnName = getColumnName(ctx.model, field);
    return [
      field,
      adapter.aggregates.count(adapter.identifiers.column(alias, columnName)),
    ];
  });

  return adapter.identifiers.aliased(
    adapter.json.objectFromColumns(pairs),
    getAggregateResultKey("_count")
  );
}

/**
 * Build aggregate column expression for count, avg, sum, min, or max
 *
 * @param ctx - Query context
 * @param spec - Scalar specification { fieldName: true, ... } or true for count all
 * @param alias - Table alias
 * @param aggType - Aggregate type
 * @returns SQL expression for aggregate (aliased) or undefined if no fields
 */
export function buildAggregateColumn(
  ctx: QueryScope,
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
  if (spec === true) {
    return undefined;
  }

  const entries = Object.entries(spec).filter(([, include]) => include);
  if (entries.length === 0) {
    return undefined;
  }

  // Get the appropriate aggregate function
  const aggFn = getAggregateFn(adapter, aggType);
  const aggName = getAggregateResultKey(`_${aggType}`);

  const scalars = ctx.model["~"].state.scalars;
  const pairs: [string, Sql][] = entries.map(([field]) => {
    // Every aggregate over a decimal — min/max included, since they are an
    // ordering — needs an exact decimal type to be exact. Refused where there
    // is none rather than computed through a double.
    assertExactDecimalOperation(ctx, field, `_${aggType}`);
    // Resolve field name to actual column name (handles .map() overrides)
    const columnName = getColumnName(ctx.model, field);
    let expr = aggFn(adapter.identifiers.column(alias, columnName));
    // BigInt/Decimal aggregates lose precision as JSON numbers — cast to
    // TEXT like select-builder does; the result parser converts back
    const scalarType = scalars[field]?.["~"].state.type;
    if (scalarType === "bigint" || scalarType === "decimal") {
      expr = adapter.expressions.cast(expr, "text");
    }
    return [field, expr];
  });

  return adapter.identifiers.aliased(
    adapter.json.objectFromColumns(pairs),
    aggName
  );
}

/**
 * Get the aggregate function from adapter based on type
 */
function getAggregateFn(
  adapter: QueryScope["adapter"],
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
    default:
      return adapter.aggregates.count;
  }
}
