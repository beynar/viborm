/**
 * GroupBy Operation
 *
 * Builds SQL for groupBy queries with aggregate functions.
 * Returns records grouped by specified fields with optional aggregates.
 */

import { sql, Sql } from "@sql";
import type { QueryContext } from "../types";
import { QueryEngineError } from "../types";
import { getTableName, getScalarFieldNames, getColumnName } from "../context";
import { buildWhere } from "../builders/where-builder";
import { buildOrderBy } from "../builders/orderby-builder";
import { buildCountAggregate, buildAggregateColumn } from "../builders/aggregate-utils";

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
export function buildGroupBy(ctx: QueryContext, args: GroupByArgs): Sql {
  const { adapter, rootAlias } = ctx;
  const tableName = getTableName(ctx.model);
  const scalarFields = getScalarFieldNames(ctx.model);

  // Normalize 'by' to array
  const byFields = Array.isArray(args.by) ? args.by : [args.by];

  // Validate by fields
  for (const field of byFields) {
    if (!scalarFields.includes(field)) {
      throw new QueryEngineError(
        `GroupBy field '${field}' not found on model '${ctx.model.name}'`
      );
    }
  }

  if (byFields.length === 0) {
    throw new QueryEngineError("GroupBy operation requires at least one field in 'by'");
  }

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
  const having = args.having ? buildHaving(ctx, args.having, rootAlias) : undefined;

  // Build ORDER BY
  const orderBy = buildOrderBy(ctx, args.orderBy, rootAlias);

  // Build LIMIT/OFFSET
  const limit = args.take !== undefined ? adapter.literals.value(args.take) : undefined;
  const offset = args.skip !== undefined ? adapter.literals.value(args.skip) : undefined;

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

/**
 * Build columns for groupBy query (grouped fields + aggregates)
 * Uses shared aggregate helpers
 */
function buildGroupByColumns(
  ctx: QueryContext,
  byFields: string[],
  args: GroupByArgs,
  alias: string
): Sql[] {
  const { adapter } = ctx;
  const columns: Sql[] = [];

  // Add grouped fields (resolve field names to column names)
  for (const field of byFields) {
    const columnName = getColumnName(ctx.model, field);
    columns.push(adapter.identifiers.column(alias, columnName));
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

/**
 * Build HAVING clause from having specification
 *
 * Having can filter on:
 * - Scalar fields (same as WHERE)
 * - Aggregate results: _count, _avg, _sum, _min, _max
 */
function buildHaving(
  ctx: QueryContext,
  having: Record<string, unknown>,
  alias: string
): Sql | undefined {
  const { adapter } = ctx;
  const conditions: Sql[] = [];

  for (const [key, value] of Object.entries(having)) {
    if (value === undefined) continue;

    // Check if it's an aggregate filter
    if (key === "_count" || key === "_avg" || key === "_sum" || key === "_min" || key === "_max") {
      const aggConditions = buildAggregateHaving(ctx, key, value as Record<string, unknown>, alias);
      if (aggConditions) conditions.push(aggConditions);
      continue;
    }

    // Scalar field filter (same as WHERE) - resolve to column name
    const columnName = getColumnName(ctx.model, key);
    const column = adapter.identifiers.column(alias, columnName);
    const scalarCondition = buildScalarHaving(ctx, column, value);
    if (scalarCondition) conditions.push(scalarCondition);
  }

  if (conditions.length === 0) return undefined;
  return adapter.operators.and(...conditions);
}

/**
 * Build aggregate HAVING condition
 *
 * Example: { _count: { id: { gt: 5 } } }
 */
function buildAggregateHaving(
  ctx: QueryContext,
  aggType: string,
  spec: Record<string, unknown>,
  alias: string
): Sql | undefined {
  const { adapter } = ctx;
  const conditions: Sql[] = [];

  for (const [field, filter] of Object.entries(spec)) {
    if (filter === undefined) continue;

    // Build the aggregate expression based on aggregate type
    let aggExpr: Sql;
    // Resolve field name to column name (skip for _all)
    const columnName = field === "_all" ? undefined : getColumnName(ctx.model, field);
    const column = columnName ? adapter.identifiers.column(alias, columnName) : undefined;

    switch (aggType) {
      case "_count":
        aggExpr = column ? adapter.aggregates.count(column) : adapter.aggregates.count();
        break;
      case "_avg":
        if (!column) continue; // _avg doesn't support _all
        aggExpr = adapter.aggregates.avg(column);
        break;
      case "_sum":
        if (!column) continue; // _sum doesn't support _all
        aggExpr = adapter.aggregates.sum(column);
        break;
      case "_min":
        if (!column) continue; // _min doesn't support _all
        aggExpr = adapter.aggregates.min(column);
        break;
      case "_max":
        if (!column) continue; // _max doesn't support _all
        aggExpr = adapter.aggregates.max(column);
        break;
      default:
        continue;
    }

    // Build the comparison condition
    const filterCondition = buildScalarHaving(ctx, aggExpr, filter);
    if (filterCondition) conditions.push(filterCondition);
  }

  if (conditions.length === 0) return undefined;
  return adapter.operators.and(...conditions);
}

/**
 * Build scalar HAVING condition (comparison operators)
 */
function buildScalarHaving(
  ctx: QueryContext,
  column: Sql,
  filter: unknown
): Sql | undefined {
  const { adapter } = ctx;

  // Direct value (equality)
  if (typeof filter !== "object" || filter === null) {
    return adapter.operators.eq(column, adapter.literals.value(filter));
  }

  const conditions: Sql[] = [];
  const filterObj = filter as Record<string, unknown>;

  for (const [op, value] of Object.entries(filterObj)) {
    if (value === undefined) continue;

    switch (op) {
      case "equals":
        conditions.push(adapter.operators.eq(column, adapter.literals.value(value)));
        break;
      case "not":
        conditions.push(adapter.operators.neq(column, adapter.literals.value(value)));
        break;
      case "gt":
        conditions.push(adapter.operators.gt(column, adapter.literals.value(value)));
        break;
      case "gte":
        conditions.push(adapter.operators.gte(column, adapter.literals.value(value)));
        break;
      case "lt":
        conditions.push(adapter.operators.lt(column, adapter.literals.value(value)));
        break;
      case "lte":
        conditions.push(adapter.operators.lte(column, adapter.literals.value(value)));
        break;
      case "in":
        if (Array.isArray(value)) {
          const values = value.map(v => adapter.literals.value(v));
          conditions.push(adapter.operators.in(column, adapter.literals.list(values)));
        }
        break;
      case "notIn":
        if (Array.isArray(value)) {
          const values = value.map(v => adapter.literals.value(v));
          conditions.push(adapter.operators.notIn(column, adapter.literals.list(values)));
        }
        break;
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return adapter.operators.and(...conditions);
}
