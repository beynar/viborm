/**
 * Where Builder
 *
 * Builds WHERE clauses from filter objects.
 * Handles scalar filters, logical operators (AND/OR/NOT),
 * and delegates relation filters to relation-filter-builder.
 */

import type { ScalarState } from "@schema/scalars";
import type { Sql } from "@sql";
import {
  createChildScope,
  getColumnName,
  getRelationInfo,
  isRelation,
  isScalarField,
} from "../context";
import { QueryEngineError, type QueryScope, type RelationInfo } from "../types";
import { buildJsonFilter } from "./json-filter-builder";
import {
  type BuildNestedWhere,
  buildRelationFilterSql,
} from "./relation-filter-builder";
import { assertSupportedScalarFilterOperator } from "./scalar-filter-operators";
import { scalarValueLiteral } from "./values-builder";

/**
 * Build a WHERE clause from a where input object
 *
 * @param ctx - Query context
 * @param where - Where input object
 * @param alias - Current table alias
 * @returns SQL for WHERE clause or undefined if no conditions
 */
export function buildWhere(
  ctx: QueryScope,
  where: Record<string, unknown> | undefined,
  alias: string
): Sql | undefined {
  if (!where) {
    return undefined;
  }

  // Use Object.keys + direct access instead of Object.entries to avoid tuple allocation
  const keys = Object.keys(where);
  if (keys.length === 0) {
    return undefined;
  }

  const conditions: Sql[] = [];

  for (const key of keys) {
    const value = where[key];
    if (value === undefined) {
      continue;
    }

    // Handle logical operators
    if (key === "AND") {
      const andCondition = buildLogicalAnd(ctx, value, alias);
      if (andCondition) {
        conditions.push(andCondition);
      }
      continue;
    }

    if (key === "OR") {
      const orCondition = buildLogicalOr(ctx, value, alias);
      if (orCondition) {
        conditions.push(orCondition);
      }
      continue;
    }

    if (key === "NOT") {
      const notCondition = buildLogicalNot(ctx, value, alias);
      if (notCondition) {
        conditions.push(notCondition);
      }
      continue;
    }

    // Handle scalar filters
    if (isScalarField(ctx.model, key)) {
      const scalarCondition = buildScalarFilter(ctx, key, value, alias);
      if (scalarCondition) {
        conditions.push(scalarCondition);
      }
      continue;
    }

    // Handle relation filters
    if (isRelation(ctx.model, key)) {
      const relationInfo = getRelationInfo(ctx, key);
      if (!relationInfo) {
        throw new QueryEngineError(`Unknown relation '${key}'.`);
      }
      const relationCondition = buildRelationFilter(
        ctx,
        relationInfo,
        value as Record<string, unknown>,
        alias
      );
      if (relationCondition) {
        conditions.push(relationCondition);
      }
      continue;
    }

    throw new QueryEngineError(`Unknown where field '${key}'.`);
  }

  if (conditions.length === 0) {
    return undefined;
  }

  return ctx.adapter.operators.and(...conditions);
}

const buildNestedWhere: BuildNestedWhere = (ctx, where) =>
  buildWhere(ctx, where, ctx.rootAlias);

/** Build a relation predicate while preserving the public advanced API. */
export function buildRelationFilter(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  filter: Record<string, unknown>,
  parentAlias: string
): Sql | undefined {
  const parentScope =
    parentAlias === ctx.rootAlias
      ? ctx
      : createChildScope(ctx, ctx.model, parentAlias);
  return buildRelationFilterSql(
    buildNestedWhere,
    parentScope,
    relationInfo,
    filter
  );
}

/** Add an ordinary filter to an already-built identity/correlation predicate. */
export function buildWhereWith(
  ctx: QueryScope,
  base: Sql,
  where: Record<string, unknown>,
  alias: string
): Sql {
  const filter = buildWhere(ctx, where, alias);
  return filter ? ctx.adapter.operators.and(base, filter) : base;
}

/**
 * Build AND logical operator
 */
function buildLogicalAnd(
  ctx: QueryScope,
  value: unknown,
  alias: string
): Sql | undefined {
  const items = Array.isArray(value) ? value : [value];
  const conditions: Sql[] = [];

  for (const item of items) {
    const condition = buildWhere(ctx, item as Record<string, unknown>, alias);
    if (condition) {
      conditions.push(condition);
    }
  }

  if (conditions.length === 0) {
    return undefined;
  }
  return ctx.adapter.operators.and(...conditions);
}

/**
 * Build OR logical operator
 */
function buildLogicalOr(
  ctx: QueryScope,
  value: unknown,
  alias: string
): Sql | undefined {
  if (!Array.isArray(value)) {
    throw new QueryEngineError("Logical OR requires an array value.");
  }

  const conditions: Sql[] = [];

  for (const item of value) {
    const condition = buildWhere(ctx, item as Record<string, unknown>, alias);
    if (condition) {
      conditions.push(condition);
    }
  }

  if (conditions.length === 0) {
    return ctx.adapter.literals.false();
  }
  return ctx.adapter.operators.or(...conditions);
}

/**
 * Build NOT logical operator
 */
function buildLogicalNot(
  ctx: QueryScope,
  value: unknown,
  alias: string
): Sql | undefined {
  // Prisma semantics: NOT: [c1, c2] negates each item and ANDs the
  // negations (NOT c1 AND NOT c2 — "all conditions must return false"),
  // not NOT (c1 AND c2). The object form NOT: { ... } is a single item,
  // so it becomes NOT (that object's implicit-AND) exactly as before.
  const items = Array.isArray(value) ? value : [value];
  const negations: Sql[] = [];

  for (const item of items) {
    const condition = buildWhere(ctx, item as Record<string, unknown>, alias);
    if (condition) {
      negations.push(ctx.adapter.operators.not(condition));
    }
  }

  if (negations.length === 0) {
    return undefined;
  }

  return ctx.adapter.operators.and(...negations);
}

/** Filter mode for case sensitivity */
type FilterMode = "default" | "insensitive";

/**
 * Build a scalar filter
 *
 * Schema validation normalizes all values to filter objects:
 * - Simple values become { equals: value }
 * - null becomes { equals: null }
 */
function buildScalarFilter(
  ctx: QueryScope,
  fieldName: string,
  value: unknown,
  alias: string
): Sql | undefined {
  const scalarState = getScalarState(ctx, fieldName);

  // Resolve field name to actual column name (handles .map() overrides)
  const columnName = getColumnName(ctx.model, fieldName);
  const column = ctx.adapter.identifiers.column(alias, columnName);

  // Schema validation guarantees value is always a filter object
  if (typeof value !== "object" || value === null) {
    throw new QueryEngineError(
      `Filter for '${fieldName}' must be a filter object (schema validation should have normalized this)`
    );
  }

  // Filter object with operations like equals, contains, gt, etc.
  const filter = value as Record<string, unknown>;

  // JSON documents get their own filter language (path-scoped operators)
  if (scalarState.type === "json" && !scalarState.array) {
    return buildJsonFilter(ctx, fieldName, scalarState, column, filter);
  }

  const conditions: Sql[] = [];

  // Extract mode for case-insensitive operations
  const mode: FilterMode =
    filter.mode === "insensitive" ? "insensitive" : "default";

  for (const [op, opValue] of Object.entries(filter)) {
    if (opValue === undefined) {
      continue;
    }
    assertSupportedScalarFilterOperator(fieldName, scalarState, op);
    if (op === "mode") continue;

    const condition = buildFilterOperation(
      ctx,
      fieldName,
      scalarState,
      column,
      op,
      opValue,
      mode
    );
    if (condition) {
      conditions.push(condition);
    }
  }

  if (conditions.length === 0) {
    throw new QueryEngineError(
      `Filter for field '${fieldName}' must contain at least one operation.`
    );
  }
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
  ctx: QueryScope,
  fieldName: string,
  scalarState: ScalarState,
  column: Sql,
  operation: string,
  value: unknown,
  mode: FilterMode = "default"
): Sql {
  const { adapter } = ctx;
  const lit = (v: unknown) => scalarValueLiteral(ctx, fieldName, v);
  const isInsensitive = mode === "insensitive";
  const isTextScalar =
    !scalarState.array &&
    (scalarState.type === "string" || scalarState.type === "enum");
  const exactTextColumn = isTextScalar
    ? adapter.expressions.caseSensitiveText(column)
    : column;
  const foldedTextColumn = isTextScalar
    ? adapter.expressions.caseSensitiveText(
        adapter.expressions.asciiCaseFold(column)
      )
    : column;

  // Portable insensitive mode folds ASCII A-Z only, then uses exact text
  // predicates. This avoids provider-native Unicode/collation divergence.
  const foldedLiteral = (v: unknown) =>
    adapter.expressions.asciiCaseFold(lit(v));
  const insensitiveEq = (v: unknown) =>
    adapter.operators.eq(foldedTextColumn, foldedLiteral(v));
  const insensitiveNeq = (v: unknown) =>
    adapter.operators.neq(foldedTextColumn, foldedLiteral(v));

  switch (operation) {
    // Equality
    case "equals":
      if (value === null) {
        return adapter.operators.isNull(column);
      }
      // Whole-list and JSON document operands need the dialect's storage
      // format: a plain param compares as a string scalar on MySQL and is
      // unbindable on SQLite
      if (scalarState.array && Array.isArray(value)) {
        return adapter.operators.eq(column, adapter.arrays.value(value));
      }
      // JSON columns store serialized JSON for every value shape (primitives
      // included — see buildScalarSqlValue), so compare in the same format
      if (scalarState.type === "json") {
        return adapter.operators.eq(column, adapter.json.value(value));
      }
      if (isInsensitive && typeof value === "string") {
        return insensitiveEq(value);
      }
      return adapter.operators.eq(exactTextColumn, lit(value));

    case "not":
      if (value === null) {
        return adapter.operators.isNotNull(column);
      }
      // List shorthand ({ not: [...] }) — before the nested-filter branch,
      // which would misread array indices as filter operations. JSON `not`
      // stays on the nested-filter path (its schema nests { equals: ... }).
      if (scalarState.array && Array.isArray(value)) {
        return adapter.operators.neq(column, adapter.arrays.value(value));
      }
      if (typeof value === "object" && value !== null) {
        // Nested filter: { not: { contains: "foo" } }
        const nested = buildScalarFilterObject(
          ctx,
          fieldName,
          column,
          value as Record<string, unknown>,
          mode
        );
        return adapter.operators.not(nested);
      }
      if (isInsensitive && typeof value === "string") {
        return insensitiveNeq(value);
      }
      return adapter.operators.neq(exactTextColumn, lit(value));

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
    case "in": {
      if (!Array.isArray(value)) {
        throw new QueryEngineError(
          `Filter operation '${operation}' for field '${fieldName}' requires an array value.`
        );
      }
      // Empty array should match nothing (always false)
      if (value.length === 0) {
        return adapter.literals.false();
      }
      if (isInsensitive) {
        return adapter.operators.or(...value.map(insensitiveEq));
      }
      const inValues = value.map((v) => lit(v));
      return adapter.operators.in(
        exactTextColumn,
        adapter.literals.list(inValues)
      );
    }

    case "notIn": {
      if (!Array.isArray(value)) {
        throw new QueryEngineError(
          `Filter operation '${operation}' for field '${fieldName}' requires an array value.`
        );
      }
      // Empty array for notIn should match everything (always true)
      if (value.length === 0) {
        return adapter.literals.true();
      }
      if (isInsensitive) {
        return adapter.operators.and(...value.map(insensitiveNeq));
      }
      const notInValues = value.map((v) => lit(v));
      return adapter.operators.notIn(
        exactTextColumn,
        adapter.literals.list(notInValues)
      );
    }

    // String operations use adapter-owned exact substring predicates, so user
    // values are always literal and database LIKE behavior cannot diverge.
    case "contains": {
      return isInsensitive
        ? adapter.operators.containsText(foldedTextColumn, foldedLiteral(value))
        : adapter.operators.containsText(column, lit(value));
    }

    case "startsWith": {
      return isInsensitive
        ? adapter.operators.startsWithText(
            foldedTextColumn,
            foldedLiteral(value)
          )
        : adapter.operators.startsWithText(column, lit(value));
    }

    case "endsWith": {
      return isInsensitive
        ? adapter.operators.endsWithText(foldedTextColumn, foldedLiteral(value))
        : adapter.operators.endsWithText(column, lit(value));
    }

    // Array operations (for array/list scalars)
    case "has":
      // `has: null` never matches on any dialect (Prisma/PG semantics:
      // NULL = element is never true). MySQL's JSON_CONTAINS would match
      // JSON null elements, so short-circuit before it diverges.
      if (value === null) {
        return adapter.literals.false();
      }
      return adapter.arrays.has(column, lit(value));

    case "hasEvery":
      if (!Array.isArray(value)) {
        throw new QueryEngineError(
          `Filter operation '${operation}' for field '${fieldName}' requires an array value.`
        );
      }
      return adapter.arrays.hasEvery(
        column,
        adapter.arrays.literal(value.map(lit))
      );

    case "hasSome":
      if (!Array.isArray(value)) {
        throw new QueryEngineError(
          `Filter operation '${operation}' for field '${fieldName}' requires an array value.`
        );
      }
      return adapter.arrays.hasSome(
        column,
        adapter.arrays.literal(value.map(lit))
      );

    case "isEmpty":
      return value
        ? adapter.arrays.isEmpty(column)
        : adapter.operators.not(adapter.arrays.isEmpty(column));

    default:
      throw new QueryEngineError(
        `Unknown filter operation '${operation}' for field '${fieldName}'.`
      );
  }
}

/**
 * Build a filter from an object (for nested not operations)
 */
function buildScalarFilterObject(
  ctx: QueryScope,
  fieldName: string,
  column: Sql,
  filter: Record<string, unknown>,
  mode: FilterMode = "default"
): Sql {
  const scalarState = getScalarState(ctx, fieldName);
  const conditions: Sql[] = [];

  // Nested filter may also have mode
  const nestedMode: FilterMode =
    filter.mode === "insensitive" ? "insensitive" : mode;

  for (const [op, value] of Object.entries(filter)) {
    if (value === undefined) {
      continue;
    }
    assertSupportedScalarFilterOperator(fieldName, scalarState, op);
    if (op === "mode") continue;

    const condition = buildFilterOperation(
      ctx,
      fieldName,
      scalarState,
      column,
      op,
      value,
      nestedMode
    );
    if (condition) {
      conditions.push(condition);
    }
  }

  if (conditions.length === 0) {
    throw new QueryEngineError(
      `Filter operation 'not' for field '${fieldName}' must contain at least one nested condition.`
    );
  }
  return ctx.adapter.operators.and(...conditions);
}

function getScalarState(ctx: QueryScope, fieldName: string): ScalarState {
  const scalar = ctx.model["~"].state.scalars[fieldName];
  if (!scalar) {
    throw new QueryEngineError(`Unknown scalar field '${fieldName}'.`);
  }
  return scalar["~"].state;
}
