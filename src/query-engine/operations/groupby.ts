/**
 * GroupBy Operation
 *
 * Builds SQL for groupBy queries with aggregate functions.
 * Returns records grouped by specified fields with optional aggregates.
 */

import { type Sql, sql } from "@sql";
import {
  buildAggregateColumn,
  buildCountAggregate,
} from "../builders/aggregate-utils";
import { buildSingleOrder } from "../builders/sort-order-builder";
import { buildWhere } from "../builders/where-builder";
import { getColumnName, getScalarFieldNames, getTableName } from "../context";
import { QueryEngineError, type QueryScope } from "../types";
import { getGroupByFields } from "./groupby-fields";
import { buildHaving } from "./groupby-having";

/**
 * GroupBy arguments
 */
export interface GroupByArgs {
  /** Fields to group by (required) */
  by: string | string[];
  /** Filter records before grouping */
  where?: Record<string, unknown>;
  /** Filter groups (HAVING clause) */
  having?: Record<string, unknown>;
  /** Order results */
  orderBy?: Record<string, unknown> | Record<string, unknown>[];
  /** Limit results */
  take?: number;
  /** Skip results */
  skip?: number;
  /** Count aggregates */
  _count?: true | Record<string, boolean>;
  /** Average aggregates */
  _avg?: Record<string, boolean>;
  /** Sum aggregates */
  _sum?: Record<string, boolean>;
  /** Min aggregates */
  _min?: Record<string, boolean>;
  /** Max aggregates */
  _max?: Record<string, boolean>;
}

/**
 * Build SQL for groupBy operation
 *
 * @param ctx - Query context
 * @param args - GroupBy arguments
 * @returns SQL statement
 */
export function buildGroupBy(ctx: QueryScope, args: GroupByArgs): Sql {
  const { adapter, rootAlias } = ctx;
  const tableName = getTableName(ctx.model);
  const scalarFields = getScalarFieldNames(ctx.model);

  // Normalize 'by' to array
  const byFields = getGroupByFields(args.by);

  // Validate by fields
  for (const field of byFields) {
    if (!scalarFields.includes(field)) {
      throw new QueryEngineError(
        `GroupBy field '${field}' not found on model '${ctx.model["~"].state.name}'`
      );
    }
  }

  if (byFields.length === 0) {
    throw new QueryEngineError(
      "GroupBy operation requires at least one field in 'by'"
    );
  }

  assertUnambiguousGroupByResult(byFields, args);

  // Build SELECT columns: grouped fields + aggregates
  const columns = buildGroupByColumns(ctx, byFields, args, rootAlias);

  // Build FROM
  const from = adapter.identifiers.table(tableName, rootAlias);

  // Build WHERE
  const where = buildWhere(ctx, args.where, rootAlias);

  // Build GROUP BY (resolve field names to column names)
  const groupByColumns = byFields.map((field) => {
    const columnName = getColumnName(ctx.model, field);
    return adapter.identifiers.column(rootAlias, columnName);
  });
  const groupBy = sql.join(groupByColumns, ", ");

  // Build HAVING
  const having = args.having
    ? buildHaving(ctx, args.having, rootAlias, byFields)
    : undefined;

  // Build ORDER BY (restricted to grouped fields and aggregates)
  const orderBy = buildGroupByOrderBy(ctx, args.orderBy, rootAlias, byFields);

  // Build LIMIT/OFFSET
  const limit =
    args.take !== undefined ? adapter.literals.value(args.take) : undefined;
  const offset =
    args.skip !== undefined ? adapter.literals.value(args.skip) : undefined;

  // Assemble query
  const parts: Parameters<typeof adapter.assemble.select>[0] = {
    columns: sql.join(columns, ", "),
    from,
  };

  if (where) parts.where = where;
  parts.groupBy = groupBy;
  if (having) parts.having = having;
  if (orderBy) parts.orderBy = orderBy;
  if (limit) parts.limit = limit;
  if (offset) parts.offset = offset;

  return adapter.assemble.select(parts);
}

function assertUnambiguousGroupByResult(
  byFields: readonly string[],
  args: GroupByArgs
): void {
  const aggregateNames = ["_count", "_avg", "_sum", "_min", "_max"] as const;
  for (const aggregateName of aggregateNames) {
    if (!byFields.includes(aggregateName)) continue;
    const spec = args[aggregateName];
    const hasOutput =
      spec === true ||
      (typeof spec === "object" &&
        spec !== null &&
        Object.values(spec).some((selected) => selected === true));
    if (hasOutput) {
      throw new QueryEngineError(
        `GroupBy cannot return both grouped scalar '${aggregateName}' and aggregate '${aggregateName}' in one result.`
      );
    }
  }
}

/**
 * Build columns for groupBy query (grouped fields + aggregates)
 * Uses shared aggregate helpers
 */
function buildGroupByColumns(
  ctx: QueryScope,
  byFields: string[],
  args: GroupByArgs,
  alias: string
): Sql[] {
  const { adapter } = ctx;
  const columns: Sql[] = [];

  // Add grouped fields (resolve field names to column names)
  for (const field of byFields) {
    const columnName = getColumnName(ctx.model, field);
    columns.push(
      adapter.identifiers.aliased(
        adapter.identifiers.column(alias, columnName),
        field
      )
    );
  }

  // Add _count aggregate
  if (args._count) {
    const countCol = buildCountAggregate(ctx, args._count, alias);
    if (countCol) columns.push(countCol);
  }

  // Add _avg aggregate
  if (args._avg) {
    const avgCol = buildAggregateColumn(ctx, args._avg, alias, "avg");
    if (avgCol) columns.push(avgCol);
  }

  // Add _sum aggregate
  if (args._sum) {
    const sumCol = buildAggregateColumn(ctx, args._sum, alias, "sum");
    if (sumCol) columns.push(sumCol);
  }

  // Add _min aggregate
  if (args._min) {
    const minCol = buildAggregateColumn(ctx, args._min, alias, "min");
    if (minCol) columns.push(minCol);
  }

  // Add _max aggregate
  if (args._max) {
    const maxCol = buildAggregateColumn(ctx, args._max, alias, "max");
    if (maxCol) columns.push(maxCol);
  }

  return columns;
}

const AGGREGATE_ORDER_KEYS = new Set([
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
]);

/**
 * Build ORDER BY for groupBy.
 *
 * Only grouped (`by`) fields and aggregate orderings are valid — ordering by
 * a non-grouped column is invalid SQL on Postgres. Aggregate orderings use
 * Prisma's shape: { _count: { field: "desc" } } (with _all supported for _count).
 */
function buildGroupByOrderBy(
  ctx: QueryScope,
  orderBy: GroupByArgs["orderBy"],
  alias: string,
  byFields: string[]
): Sql | undefined {
  if (!orderBy) return undefined;

  const { adapter } = ctx;
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  const orders: Sql[] = [];

  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (value === undefined) continue;

      if (AGGREGATE_ORDER_KEYS.has(key)) {
        if (typeof value !== "object" || value === null) {
          throw new QueryEngineError(
            `GroupBy orderBy '${key}' requires an object mapping fields to sort directions.`
          );
        }
        for (const [field, direction] of Object.entries(value)) {
          if (direction === undefined) continue;
          const aggExpr = buildOrderByAggregate(ctx, key, field, alias);
          orders.push(buildSingleOrder(ctx, aggExpr, direction));
        }
        continue;
      }

      if (!byFields.includes(key)) {
        throw new QueryEngineError(
          `GroupBy orderBy field '${key}' must be included in 'by' or be an aggregate (_count, _avg, _sum, _min, _max).`
        );
      }
      const columnName = getColumnName(ctx.model, key);
      const column = adapter.identifiers.column(alias, columnName);
      orders.push(buildSingleOrder(ctx, column, value));
    }
  }

  if (orders.length === 0) return undefined;
  return sql.join(orders, ", ");
}

function buildOrderByAggregate(
  ctx: QueryScope,
  aggKey: string,
  field: string,
  alias: string
): Sql {
  const { adapter } = ctx;

  if (aggKey === "_count" && field === "_all") {
    return adapter.aggregates.count();
  }

  const columnName = getColumnName(ctx.model, field);
  const column = adapter.identifiers.column(alias, columnName);

  switch (aggKey) {
    case "_count":
      return adapter.aggregates.count(column);
    case "_avg":
      return adapter.aggregates.avg(column);
    case "_sum":
      return adapter.aggregates.sum(column);
    case "_min":
      return adapter.aggregates.min(column);
    case "_max":
      return adapter.aggregates.max(column);
    default:
      throw new QueryEngineError(`Unknown orderBy aggregate '${aggKey}'.`);
  }
}

/**
 * Build HAVING clause from having specification
 *
 * Prisma-style having uses field-keyed structure:
 * { fieldName: { _count: { gt: 5 }, _avg: { gte: 10 } } }
 *
 * Each field can have multiple aggregate filters applied.
 * Also supports logical operators: AND, OR, NOT
 */
