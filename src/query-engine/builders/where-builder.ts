/**
 * Where Builder
 *
 * Builds WHERE clauses from filter objects.
 * Handles scalar filters, logical operators (AND/OR/NOT),
 * and delegates relation filters to relation-filter-builder.
 */

import { sql, Sql } from "@sql";
import type { QueryContext } from "../types";
import {
  isScalarField,
  isRelation,
  getRelationInfo,
  getColumnName,
} from "../context";
import { buildRelationFilter } from "./relation-filter-builder";

/**
 * Build a WHERE clause from a where input object
 *
 * @param ctx - Query context
 * @param where - Where input object
 * @param alias - Current table alias
 * @returns SQL for WHERE clause or undefined if no conditions
 */
export function buildWhere(
  ctx: QueryContext,
  where: Record<string, unknown> | undefined,
  alias: string,
): Sql | undefined {
  if (!where || Object.keys(where).length === 0) {
    return undefined;
  }

  const conditions: Sql[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;

    // Handle logical operators
    if (key === "AND") {
      const andCondition = buildLogicalAnd(ctx, value, alias);
      if (andCondition) conditions.push(andCondition);
      continue;
    }

    if (key === "OR") {
      const orCondition = buildLogicalOr(ctx, value, alias);
      if (orCondition) conditions.push(orCondition);
      continue;
    }

    if (key === "NOT") {
      const notCondition = buildLogicalNot(ctx, value, alias);
      if (notCondition) conditions.push(notCondition);
      continue;
    }

    // Handle scalar field filters
    if (isScalarField(ctx.model, key)) {
      const fieldCondition = buildScalarFilter(ctx, key, value, alias);
      if (fieldCondition) conditions.push(fieldCondition);
      continue;
    }

    // Handle relation filters
    if (isRelation(ctx.model, key)) {
      const relationInfo = getRelationInfo(ctx, key);
      if (relationInfo) {
        const relationCondition = buildRelationFilter(
          ctx,
          relationInfo,
          value as Record<string, unknown>,
          alias,
        );
        if (relationCondition) conditions.push(relationCondition);
      }
      continue;
    }
  }

  if (conditions.length === 0) {
    return undefined;
  }

  return ctx.adapter.operators.and(...conditions);
}

/**
 * Build AND logical operator
 */
function buildLogicalAnd(
  ctx: QueryContext,
  value: unknown,
  alias: string,
): Sql | undefined {
  const items = Array.isArray(value) ? value : [value];
  const conditions: Sql[] = [];

  for (const item of items) {
    const condition = buildWhere(ctx, item as Record<string, unknown>, alias);
    if (condition) conditions.push(condition);
  }

  if (conditions.length === 0) return undefined;
  return ctx.adapter.operators.and(...conditions);
}

/**
 * Build OR logical operator
 */
function buildLogicalOr(
  ctx: QueryContext,
  value: unknown,
  alias: string,
): Sql | undefined {
  if (!Array.isArray(value)) return undefined;

  const conditions: Sql[] = [];

  for (const item of value) {
    const condition = buildWhere(ctx, item as Record<string, unknown>, alias);
    if (condition) conditions.push(condition);
  }

  if (conditions.length === 0) return undefined;
  return ctx.adapter.operators.or(...conditions);
}

/**
 * Build NOT logical operator
 */
function buildLogicalNot(
  ctx: QueryContext,
  value: unknown,
  alias: string,
): Sql | undefined {
  const items = Array.isArray(value) ? value : [value];
  const conditions: Sql[] = [];

  for (const item of items) {
    const condition = buildWhere(ctx, item as Record<string, unknown>, alias);
    if (condition) conditions.push(condition);
  }

  if (conditions.length === 0) return undefined;

  const combined = ctx.adapter.operators.and(...conditions);
  return ctx.adapter.operators.not(combined);
}

/** Filter mode for case sensitivity */
type FilterMode = "default" | "insensitive";

/**
 * Build a scalar field filter
 *
 * Schema validation normalizes all values to filter objects:
 * - Simple values become { equals: value }
 * - null becomes { equals: null }
 */
function buildScalarFilter(
  ctx: QueryContext,
  fieldName: string,
  value: unknown,
  alias: string,
): Sql | undefined {
  // Resolve field name to actual column name (handles .map() overrides)
  const columnName = getColumnName(ctx.model, fieldName);
  const column = ctx.adapter.identifiers.column(alias, columnName);

  // Schema validation guarantees value is always a filter object
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `Filter for '${fieldName}' must be a filter object (schema validation should have normalized this)`,
    );
  }

  // Filter object with operations like equals, contains, gt, etc.
  const filter = value as Record<string, unknown>;
  const conditions: Sql[] = [];

  // Extract mode for case-insensitive operations
  const mode: FilterMode =
    filter.mode === "insensitive" ? "insensitive" : "default";

  for (const [op, opValue] of Object.entries(filter)) {
    if (opValue === undefined) continue;
    if (op === "mode") continue; // Skip mode itself, it's a modifier

    const condition = buildFilterOperation(ctx, column, op, opValue, mode);
    if (condition) conditions.push(condition);
  }

  if (conditions.length === 0) return undefined;
  return ctx.adapter.operators.and(...conditions);
}

/**
 * Build a single filter operation
 *
 * @param ctx - Query context
 * @param column - Column SQL expression
 * @param operation - Filter operation name
 * @param value - Filter value
 * @param mode - Case sensitivity mode (default or insensitive)
 */
function buildFilterOperation(
  ctx: QueryContext,
  column: Sql,
  operation: string,
  value: unknown,
  mode: FilterMode = "default",
): Sql | undefined {
  const { adapter } = ctx;
  const lit = (v: unknown) => adapter.literals.value(v);
  const isInsensitive = mode === "insensitive";

  switch (operation) {
    // Equality
    case "equals":
      if (value === null) return adapter.operators.isNull(column);
      return adapter.operators.eq(column, lit(value));

    case "not":
      if (value === null) return adapter.operators.isNotNull(column);
      if (typeof value === "object" && value !== null) {
        // Nested filter: { not: { contains: "foo" } }
        const nested = buildScalarFilterObject(
          ctx,
          column,
          value as Record<string, unknown>,
          mode,
        );
        return nested ? adapter.operators.not(nested) : undefined;
      }
      return adapter.operators.neq(column, lit(value));

    // Comparison
    case "lt":
      return adapter.operators.lt(column, lit(value));

    case "lte":
      return adapter.operators.lte(column, lit(value));

    case "gt":
      return adapter.operators.gt(column, lit(value));

    case "gte":
      return adapter.operators.gte(column, lit(value));

    // Set membership
    case "in":
      if (!Array.isArray(value) || value.length === 0) return undefined;
      const inValues = value.map((v) => lit(v));
      return adapter.operators.in(column, adapter.literals.list(inValues));

    case "notIn":
      if (!Array.isArray(value) || value.length === 0) return undefined;
      const notInValues = value.map((v) => lit(v));
      return adapter.operators.notIn(
        column,
        adapter.literals.list(notInValues),
      );

    // String operations (respect case sensitivity mode)
    case "contains": {
      const containsPattern = sql`${"%" + String(value) + "%"}`;
      return isInsensitive
        ? adapter.operators.ilike(column, containsPattern)
        : adapter.operators.like(column, containsPattern);
    }

    case "startsWith": {
      const startsPattern = sql`${String(value) + "%"}`;
      return isInsensitive
        ? adapter.operators.ilike(column, startsPattern)
        : adapter.operators.like(column, startsPattern);
    }

    case "endsWith": {
      const endsPattern = sql`${"%" + String(value)}`;
      return isInsensitive
        ? adapter.operators.ilike(column, endsPattern)
        : adapter.operators.like(column, endsPattern);
    }

    // Array operations (for array/list fields)
    case "has":
      return adapter.arrays.has(column, lit(value));

    case "hasEvery":
      if (!Array.isArray(value)) return undefined;
      return adapter.arrays.hasEvery(
        column,
        adapter.arrays.literal(value.map(lit)),
      );

    case "hasSome":
      if (!Array.isArray(value)) return undefined;
      return adapter.arrays.hasSome(
        column,
        adapter.arrays.literal(value.map(lit)),
      );

    case "isEmpty":
      return value
        ? adapter.arrays.isEmpty(column)
        : adapter.operators.not(adapter.arrays.isEmpty(column));

    default:
      // Unknown operation, skip
      return undefined;
  }
}

/**
 * Build a filter from an object (for nested not operations)
 */
function buildScalarFilterObject(
  ctx: QueryContext,
  column: Sql,
  filter: Record<string, unknown>,
  mode: FilterMode = "default",
): Sql | undefined {
  const conditions: Sql[] = [];

  // Nested filter may also have mode
  const nestedMode: FilterMode =
    filter.mode === "insensitive" ? "insensitive" : mode;

  for (const [op, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (op === "mode") continue; // Skip mode itself
    const condition = buildFilterOperation(ctx, column, op, value, nestedMode);
    if (condition) conditions.push(condition);
  }

  if (conditions.length === 0) return undefined;
  return ctx.adapter.operators.and(...conditions);
}

/**
 * Build WHERE from a unique input (for findUnique, update, delete)
 * Unique input can be a single field or compound key
 *
 * Handles:
 * - Single field: { id: "123" }
 * - Compound ID: { email_orgId: { email: "a@b.com", orgId: "org1" } }
 * - Named compound: { uq_name_org: { name: "Alice", orgId: "org1" } }
 */
export function buildWhereUnique(
  ctx: QueryContext,
  where: Record<string, unknown>,
  alias: string,
): Sql | undefined {
  const conditions: Sql[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;

    // Check if this is a compound key (object value with multiple fields)
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // Compound key: { email_orgId: { email: "a@b.com", orgId: "org1" } }
      const compound = value as Record<string, unknown>;
      for (const [fieldName, fieldValue] of Object.entries(compound)) {
        if (fieldValue === undefined) continue;
        // Resolve field name to actual column name (handles .map() overrides)
        const columnName = getColumnName(ctx.model, fieldName);
        const column = ctx.adapter.identifiers.column(alias, columnName);
        conditions.push(
          ctx.adapter.operators.eq(
            column,
            ctx.adapter.literals.value(fieldValue),
          ),
        );
      }
    } else {
      // Single field: { id: "123" }
      // Resolve field name to actual column name (handles .map() overrides)
      const columnName = getColumnName(ctx.model, key);
      const column = ctx.adapter.identifiers.column(alias, columnName);
      conditions.push(
        ctx.adapter.operators.eq(column, ctx.adapter.literals.value(value)),
      );
    }
  }

  if (conditions.length === 0) return undefined;
  return ctx.adapter.operators.and(...conditions);
}
