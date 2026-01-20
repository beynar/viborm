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
import { buildOrderBy } from "../builders/orderby-builder";
import { buildWhere } from "../builders/where-builder";
import { getColumnName, getScalarFieldNames, getTableName } from "../context";
import { type QueryContext, QueryEngineError } from "../types";

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
        `GroupBy field '${field}' not found on model '${ctx.model["~"].state.name}'`
      );
    }
  }

  if (byFields.length === 0) {
    throw new QueryEngineError(
      "GroupBy operation requires at least one field in 'by'"
    );
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
  const having = args.having
    ? buildHaving(ctx, args.having, rootAlias, byFields)
    : undefined;

  // Build ORDER BY
  const orderBy = buildOrderBy(ctx, args.orderBy, rootAlias);

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
 * Prisma-style having uses field-keyed structure:
 * { fieldName: { _count: { gt: 5 }, _avg: { gte: 10 } } }
 *
 * Each field can have multiple aggregate filters applied.
 * Also supports logical operators: AND, OR, NOT
 */
function buildHaving(
  ctx: QueryContext,
  having: Record<string, unknown>,
  alias: string,
  byFields: string[]
): Sql | undefined {
  if (!having || typeof having !== "object") return undefined;

  const { adapter } = ctx;
  const conditions: Sql[] = [];

  for (const [key, value] of Object.entries(having)) {
    if (value === undefined) continue;

    // Handle logical operators (AND, OR, NOT)
    if (key === "AND") {
      const andCondition = buildHavingLogicalAnd(ctx, value, alias, byFields);
      if (andCondition) conditions.push(andCondition);
      continue;
    }

    if (key === "OR") {
      const orCondition = buildHavingLogicalOr(ctx, value, alias, byFields);
      if (orCondition) conditions.push(orCondition);
      continue;
    }

    if (key === "NOT") {
      const notCondition = buildHavingLogicalNot(ctx, value, alias, byFields);
      if (notCondition) conditions.push(notCondition);
      continue;
    }

    // Handle field-keyed having
    const fieldConditions = buildFieldKeyedHaving(
      ctx,
      key,
      value,
      alias,
      byFields
    );
    if (fieldConditions) conditions.push(fieldConditions);
  }

  if (conditions.length === 0) return undefined;
  return adapter.operators.and(...conditions);
}

/**
 * Build AND logical operator for HAVING
 */
function buildHavingLogicalAnd(
  ctx: QueryContext,
  value: unknown,
  alias: string,
  byFields: string[]
): Sql | undefined {
  const items = Array.isArray(value) ? value : [value];
  const conditions: Sql[] = [];

  for (const item of items) {
    const condition = buildHaving(
      ctx,
      item as Record<string, unknown>,
      alias,
      byFields
    );
    if (condition) conditions.push(condition);
  }

  if (conditions.length === 0) return undefined;
  return ctx.adapter.operators.and(...conditions);
}

/**
 * Build OR logical operator for HAVING
 */
function buildHavingLogicalOr(
  ctx: QueryContext,
  value: unknown,
  alias: string,
  byFields: string[]
): Sql | undefined {
  if (!Array.isArray(value)) return undefined;

  const conditions: Sql[] = [];

  for (const item of value) {
    const condition = buildHaving(
      ctx,
      item as Record<string, unknown>,
      alias,
      byFields
    );
    if (condition) conditions.push(condition);
  }

  if (conditions.length === 0) return undefined;
  return ctx.adapter.operators.or(...conditions);
}

/**
 * Build NOT logical operator for HAVING
 */
function buildHavingLogicalNot(
  ctx: QueryContext,
  value: unknown,
  alias: string,
  byFields: string[]
): Sql | undefined {
  const items = Array.isArray(value) ? value : [value];
  const conditions: Sql[] = [];

  for (const item of items) {
    const condition = buildHaving(
      ctx,
      item as Record<string, unknown>,
      alias,
      byFields
    );
    if (condition) conditions.push(condition);
  }

  if (conditions.length === 0) return undefined;

  const combined = ctx.adapter.operators.and(...conditions);
  return ctx.adapter.operators.not(combined);
}

/**
 * Build HAVING condition for Prisma-style field-keyed structure
 *
 * Example: { id: { _count: { gt: 5 }, _avg: { gte: 10 } } }
 * Where 'id' is the field name, and the value contains aggregate type keys
 */
function buildFieldKeyedHaving(
  ctx: QueryContext,
  fieldName: string,
  value: unknown,
  alias: string,
  byFields: string[]
): Sql | undefined {
  const { adapter } = ctx;

  // Detect whether this is an aggregate filter object (Prisma-style)
  const aggregateKeys = ["_count", "_avg", "_sum", "_min", "_max"] as const;
  const isObject =
    typeof value === "object" && value !== null && !Array.isArray(value);
  const valueKeys = isObject
    ? Object.keys(value as Record<string, unknown>)
    : [];
  const hasAggregateKey = valueKeys.some((k) =>
    (aggregateKeys as readonly string[]).includes(k)
  );

  // Direct field filters in HAVING are only valid for fields present in `by`
  // (Prisma rule: you can only filter on aggregate values or fields available in `by`)
  if (!(hasAggregateKey || byFields.includes(fieldName))) {
    throw new QueryEngineError(
      `Field '${fieldName}' used in 'having' must be included in 'by'.`
    );
  }

  // Aggregate filters: { fieldName: { _count: { gt: 5 } } }
  if (hasAggregateKey) {
    if (!isObject) return undefined;

    const conditions: Sql[] = [];

    // Resolve field name to column name
    const columnName = getColumnName(ctx.model, fieldName);
    const column = adapter.identifiers.column(alias, columnName);

    const aggregateValue = value as Record<string, unknown>;
    for (const [aggType, filter] of Object.entries(aggregateValue)) {
      if (filter === undefined) continue;

      // Build the aggregate expression
      let aggExpr: Sql;
      switch (aggType) {
        case "_count":
          aggExpr = adapter.aggregates.count(column);
          break;
        case "_avg":
          aggExpr = adapter.aggregates.avg(column);
          break;
        case "_sum":
          aggExpr = adapter.aggregates.sum(column);
          break;
        case "_min":
          aggExpr = adapter.aggregates.min(column);
          break;
        case "_max":
          aggExpr = adapter.aggregates.max(column);
          break;
        default:
          // Not an aggregate type - ignore
          continue;
      }

      // Build the comparison condition
      const filterCondition = buildScalarHaving(ctx, aggExpr, filter);
      if (filterCondition) conditions.push(filterCondition);
    }

    if (conditions.length === 0) return undefined;
    if (conditions.length === 1) return conditions[0];
    return adapter.operators.and(...conditions);
  }

  // Direct field filters: { fieldName: { equals: "x" } } or { fieldName: "x" }
  // Reuse WHERE builder to support the full filter operator set (contains, startsWith, mode, etc.)
  const normalizedFilter =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? value
      : { equals: value };
  return buildWhere(
    ctx,
    { [fieldName]: normalizedFilter } as Record<string, unknown>,
    alias
  );
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
        conditions.push(
          adapter.operators.eq(column, adapter.literals.value(value))
        );
        break;
      case "not":
        conditions.push(
          adapter.operators.neq(column, adapter.literals.value(value))
        );
        break;
      case "gt":
        conditions.push(
          adapter.operators.gt(column, adapter.literals.value(value))
        );
        break;
      case "gte":
        conditions.push(
          adapter.operators.gte(column, adapter.literals.value(value))
        );
        break;
      case "lt":
        conditions.push(
          adapter.operators.lt(column, adapter.literals.value(value))
        );
        break;
      case "lte":
        conditions.push(
          adapter.operators.lte(column, adapter.literals.value(value))
        );
        break;
      case "in":
        if (Array.isArray(value)) {
          const values = value.map((v) => adapter.literals.value(v));
          conditions.push(
            adapter.operators.in(column, adapter.literals.list(values))
          );
        }
        break;
      case "notIn":
        if (Array.isArray(value)) {
          const values = value.map((v) => adapter.literals.value(v));
          conditions.push(
            adapter.operators.notIn(column, adapter.literals.list(values))
          );
        }
        break;
      default: {
        throw new QueryEngineError(`Invalid operator: ${op}`);
      }
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return adapter.operators.and(...conditions);
}
