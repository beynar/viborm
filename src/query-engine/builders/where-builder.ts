/**
 * Where Builder
 *
 * Builds WHERE clauses from filter objects.
 * Handles scalar filters, logical operators (AND/OR/NOT),
 * and delegates relation filters to relation-filter-builder.
 */

import type { ScalarState, ScalarType } from "@schema/scalars";
import { type Sql, sql } from "@sql";
import {
  getColumnName,
  getRelationInfo,
  isRelation,
  isScalarField,
} from "../context";
import { type QueryContext, QueryEngineError } from "../types";
import { buildRelationFilter } from "./relation-filter-builder";
import { scalarValueLiteral } from "./values-builder";

const LIKE_SPECIAL_CHARS = /[\\%_]/g;

/**
 * Escape LIKE wildcards in user input so contains/startsWith/endsWith
 * match literal substrings. Pairs with the ESCAPE '\' clause emitted by
 * the adapters' like/ilike operators.
 */
function escapeLikeValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return value.replace(LIKE_SPECIAL_CHARS, "\\$&");
}

const BASE_FILTER_OPERATORS = new Set(["equals", "not"]);
const COMPARISON_FILTER_OPERATORS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
]);
const STRING_FILTER_OPERATORS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "endsWith",
  "mode",
]);
const LIST_FILTER_OPERATORS = new Set([
  "equals",
  "not",
  "has",
  "hasEvery",
  "hasSome",
  "isEmpty",
]);
const JSON_FILTER_OPERATORS = new Set([
  "equals",
  "not",
  "path",
  "string_contains",
  "string_starts_with",
  "string_ends_with",
  "array_contains",
  "array_starts_with",
  "array_ends_with",
]);

const COMPARISON_SCALAR_TYPES: Set<ScalarType> = new Set([
  "int",
  "float",
  "decimal",
  "bigint",
  "date",
  "datetime",
  "time",
]);

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

/**
 * Build AND logical operator
 */
function buildLogicalAnd(
  ctx: QueryContext,
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
  ctx: QueryContext,
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
  ctx: QueryContext,
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

  const combined = ctx.adapter.operators.and(...conditions);
  return ctx.adapter.operators.not(combined);
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
  ctx: QueryContext,
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
  ctx: QueryContext,
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

  // Case-insensitive equality via ilike with a fully-escaped pattern:
  // no wildcards survive escaping, so it is pure equality and stays
  // trigram-indexable on Postgres.
  const insensitiveEq = (v: unknown) =>
    adapter.operators.ilike(column, lit(escapeLikeValue(v)));
  const insensitiveNeq = (v: unknown) =>
    adapter.operators.notIlike(column, lit(escapeLikeValue(v)));

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
      return adapter.operators.eq(column, lit(value));

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
      return adapter.operators.in(column, adapter.literals.list(inValues));
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
        column,
        adapter.literals.list(notInValues)
      );
    }

    // String operations (respect case sensitivity mode)
    // Use adapter.expressions.concat to build LIKE pattern at SQL execution time
    // Keeps wildcards in SQL and user value as separate parameter.
    // User input is a literal substring: escape LIKE wildcards (\, %, _) so
    // they only match their literal occurrences. Adapters declare ESCAPE '\'.
    case "contains": {
      const containsPattern = adapter.expressions.concat(
        sql`'%'`,
        lit(escapeLikeValue(value)),
        sql`'%'`
      );
      return isInsensitive
        ? adapter.operators.ilike(column, containsPattern)
        : adapter.operators.like(column, containsPattern);
    }

    case "startsWith": {
      const startsPattern = adapter.expressions.concat(
        lit(escapeLikeValue(value)),
        sql`'%'`
      );
      return isInsensitive
        ? adapter.operators.ilike(column, startsPattern)
        : adapter.operators.like(column, startsPattern);
    }

    case "endsWith": {
      const endsPattern = adapter.expressions.concat(
        sql`'%'`,
        lit(escapeLikeValue(value))
      );
      return isInsensitive
        ? adapter.operators.ilike(column, endsPattern)
        : adapter.operators.like(column, endsPattern);
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
  ctx: QueryContext,
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

/**
 * Build a JSON scalar filter. `path` scopes every other operator in the
 * filter object to the value at that path (Prisma semantics); without a
 * path, operators apply to the document root. A nested `not` filter
 * inherits the outer path unless it sets its own.
 */
function buildJsonFilter(
  ctx: QueryContext,
  fieldName: string,
  scalarState: ScalarState,
  column: Sql,
  filter: Record<string, unknown>,
  inheritedPath: string[] = []
): Sql {
  const path = Array.isArray(filter.path)
    ? filter.path.map(String)
    : inheritedPath;
  // Root comparisons keep the bare column (same SQL as before path filters
  // existed); extraction only happens once a path scopes the target
  const target = path.length ? ctx.adapter.json.extract(column, path) : column;
  const conditions: Sql[] = [];

  for (const [op, value] of Object.entries(filter)) {
    if (value === undefined || op === "path") {
      continue;
    }
    assertSupportedScalarFilterOperator(fieldName, scalarState, op);
    conditions.push(
      buildJsonFilterOperation(
        ctx,
        fieldName,
        scalarState,
        column,
        target,
        path,
        op,
        value
      )
    );
  }

  if (conditions.length === 0) {
    throw new QueryEngineError(
      `Filter for field '${fieldName}' must contain at least one operation.`
    );
  }
  return ctx.adapter.operators.and(...conditions);
}

function buildJsonFilterOperation(
  ctx: QueryContext,
  fieldName: string,
  scalarState: ScalarState,
  column: Sql,
  target: Sql,
  path: string[],
  operation: string,
  value: unknown
): Sql {
  const { adapter } = ctx;
  // Extracted values compare in the dialect's JSON format on every side
  // (jsonb param on PG, CAST(? AS JSON) on MySQL, canonical text on SQLite)
  const jsonValue = (v: unknown) => adapter.json.value(v);
  // string_* params are plain text compared against extractText output
  const textPattern = (v: unknown) =>
    adapter.literals.value(escapeLikeValue(v));

  switch (operation) {
    case "equals":
      if (value === null && path.length === 0) {
        return adapter.operators.isNull(column);
      }
      // With a path, null compares against JSON null at that path; missing
      // keys extract to SQL NULL and never match
      return adapter.operators.eq(target, jsonValue(value));

    case "not":
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        return adapter.operators.not(
          buildJsonFilter(
            ctx,
            fieldName,
            scalarState,
            column,
            value as Record<string, unknown>,
            path
          )
        );
      }
      if (value === null && path.length === 0) {
        return adapter.operators.isNotNull(column);
      }
      return adapter.operators.neq(target, jsonValue(value));

    case "string_contains":
      return adapter.operators.like(
        adapter.json.extractText(column, path),
        adapter.expressions.concat(sql`'%'`, textPattern(value), sql`'%'`)
      );

    case "string_starts_with":
      return adapter.operators.like(
        adapter.json.extractText(column, path),
        adapter.expressions.concat(textPattern(value), sql`'%'`)
      );

    case "string_ends_with":
      return adapter.operators.like(
        adapter.json.extractText(column, path),
        adapter.expressions.concat(sql`'%'`, textPattern(value))
      );

    case "array_contains": {
      // Scalar candidates normalize to one-element arrays so every dialect
      // shares PG's array-containment semantics
      const candidate = Array.isArray(value) ? value : [value];
      return adapter.json.contains(target, jsonValue(candidate));
    }

    case "array_starts_with":
      return adapter.operators.eq(
        adapter.json.extract(column, [...path, "0"]),
        jsonValue(value)
      );

    case "array_ends_with":
      return adapter.operators.eq(
        adapter.json.lastElement(target),
        jsonValue(value)
      );

    default:
      throw new QueryEngineError(
        `Unknown filter operation '${operation}' for field '${fieldName}'.`
      );
  }
}

function getScalarState(ctx: QueryContext, fieldName: string): ScalarState {
  const scalar = ctx.model["~"].state.scalars[fieldName];
  if (!scalar) {
    throw new QueryEngineError(`Unknown scalar field '${fieldName}'.`);
  }
  return scalar["~"].state;
}

function assertSupportedScalarFilterOperator(
  fieldName: string,
  scalarState: ScalarState,
  operation: string
): void {
  if (isSupportedScalarFilterOperator(scalarState, operation)) return;

  throw new QueryEngineError(
    `Unsupported filter operation '${operation}' for ${scalarState.type} scalar '${fieldName}'.`
  );
}

function isSupportedScalarFilterOperator(
  scalarState: ScalarState,
  operation: string
): boolean {
  if (scalarState.array) {
    return LIST_FILTER_OPERATORS.has(operation);
  }

  if (scalarState.type === "string") {
    return STRING_FILTER_OPERATORS.has(operation);
  }

  if (scalarState.type === "enum") {
    return (
      BASE_FILTER_OPERATORS.has(operation) ||
      operation === "in" ||
      operation === "notIn"
    );
  }

  if (scalarState.type === "json") {
    return JSON_FILTER_OPERATORS.has(operation);
  }

  if (COMPARISON_SCALAR_TYPES.has(scalarState.type)) {
    return COMPARISON_FILTER_OPERATORS.has(operation);
  }

  return BASE_FILTER_OPERATORS.has(operation);
}
