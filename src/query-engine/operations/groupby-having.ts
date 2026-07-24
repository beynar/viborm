import type { Sql } from "@sql";
import { buildWhere } from "../builders/where-builder";
import { getColumnName } from "../context";
import { QueryEngineError, type QueryScope } from "../types";

export function buildHaving(
  ctx: QueryScope,
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
  ctx: QueryScope,
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
  ctx: QueryScope,
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
  ctx: QueryScope,
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
  ctx: QueryScope,
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
      `Scalar '${fieldName}' used in 'having' must be included in 'by'.`
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
  ctx: QueryScope,
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
          value === null
            ? adapter.operators.isNull(column)
            : adapter.operators.eq(column, adapter.literals.value(value))
        );
        break;
      case "not":
        conditions.push(
          value === null
            ? adapter.operators.isNotNull(column)
            : adapter.operators.neq(column, adapter.literals.value(value))
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
      case "in": {
        if (!Array.isArray(value)) {
          throw new QueryEngineError(
            "HAVING operation 'in' requires an array value."
          );
        }
        // Empty array matches nothing; IN () is invalid SQL
        if (value.length === 0) {
          conditions.push(adapter.literals.false());
          break;
        }
        const values = value.map((v) => adapter.literals.value(v));
        conditions.push(
          adapter.operators.in(column, adapter.literals.list(values))
        );
        break;
      }
      case "notIn": {
        if (!Array.isArray(value)) {
          throw new QueryEngineError(
            "HAVING operation 'notIn' requires an array value."
          );
        }
        // Empty array matches everything
        if (value.length === 0) {
          conditions.push(adapter.literals.true());
          break;
        }
        const values = value.map((v) => adapter.literals.value(v));
        conditions.push(
          adapter.operators.notIn(column, adapter.literals.list(values))
        );
        break;
      }
      default: {
        throw new QueryEngineError(`Invalid operator: ${op}`);
      }
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return adapter.operators.and(...conditions);
}
