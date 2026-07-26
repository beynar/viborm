import type { ScalarState } from "@schema/scalars";
import type { Sql } from "@sql";
import { QueryEngineError, type QueryScope } from "../types";
import { assertSupportedScalarFilterOperator } from "./scalar-filter-operators";

/**
 * What `path` and `mode` scope for one JSON filter object. Both are
 * modifiers, not operations: they are inherited by a nested `not` filter
 * unless that filter sets its own.
 */
type JsonFilterScope = {
  path: string[];
  mode: "default" | "insensitive";
};

const ROOT_SCOPE: JsonFilterScope = { path: [], mode: "default" };

/**
 * The operators `mode: "insensitive"` governs. `equals`/`not`/`array_*`
 * compare whole JSON values, not text, so folding them would be meaningless
 * — which is why an inert `mode` is refused rather than ignored.
 */
const MODE_GOVERNED_OPERATORS = [
  "string_contains",
  "string_starts_with",
  "string_ends_with",
] as const;

/**
 * A filter object's own `mode` wins over the inherited one in BOTH
 * directions, so `not: { string_contains: "x", mode: "default" }` really does
 * restore exact matching on that arm. (The scalar where-builder only lets a
 * nested mode upgrade to insensitive; JSON honors the key as written rather
 * than accepting it and doing nothing.)
 */
function resolveJsonFilterMode(
  declared: unknown,
  inherited: JsonFilterScope["mode"]
): JsonFilterScope["mode"] {
  if (declared === "insensitive") return "insensitive";
  if (declared === "default") return "default";
  return inherited;
}

/**
 * Build a JSON scalar filter. `path` scopes every other operator in the
 * filter object to the value at that path (Prisma semantics); without a
 * path, operators apply to the document root. A nested `not` filter
 * inherits the outer path and mode unless it sets its own.
 */
export function buildJsonFilter(
  ctx: QueryScope,
  fieldName: string,
  scalarState: ScalarState,
  column: Sql,
  filter: Record<string, unknown>,
  inherited: JsonFilterScope = ROOT_SCOPE
): Sql {
  const scope: JsonFilterScope = {
    path: Array.isArray(filter.path) ? filter.path.map(String) : inherited.path,
    mode: resolveJsonFilterMode(filter.mode, inherited.mode),
  };
  assertPortableJsonPath(fieldName, scope.path);
  assertModeGovernsSomething(fieldName, filter);
  // Root comparisons keep the bare column (same SQL as before path filters
  // existed); extraction only happens once a path scopes the target
  const target = scope.path.length
    ? ctx.adapter.json.extract(column, scope.path)
    : column;
  const conditions: Sql[] = [];

  for (const [op, value] of Object.entries(filter)) {
    if (value === undefined || op === "path" || op === "mode") {
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
        scope,
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

/**
 * Fail closed on an inert `mode: "insensitive"`. A mode declared on THIS
 * object must govern a string operator here, or a nested `not` that inherits
 * it; otherwise the engine would accept the key and silently do nothing.
 * Inherited modes are exempt — `{ mode, string_contains, not: { equals } }`
 * is legitimate, and only the arm that spelled `mode` has to justify it.
 */
function assertModeGovernsSomething(
  fieldName: string,
  filter: Record<string, unknown>
): void {
  if (filter.mode !== "insensitive") return;
  if (filter.not !== undefined) return;
  const governed = MODE_GOVERNED_OPERATORS.some(
    (operator) => filter[operator] !== undefined
  );
  if (governed) return;
  throw new QueryEngineError(
    `JSON filter for field '${fieldName}' sets mode: 'insensitive' but has no string_contains/string_starts_with/string_ends_with operation for it to apply to.`
  );
}

function assertPortableJsonPath(fieldName: string, path: string[]): void {
  const invalidSegment = path.find(
    (segment) => segment.includes('"') || segment.includes("\\")
  );
  if (invalidSegment === undefined) return;
  throw new QueryEngineError(
    `JSON filter for field '${fieldName}' requires a portable JSON path; segments containing '"' or '\\' are not supported.`
  );
}

/**
 * JSON lt/lte/gt/gte. THE PINNED SEMANTICS (identical on every dialect):
 *
 * - The operand's JS type picks the comparison class. A number compares
 *   numerically and ONLY against JSON numbers; a string compares
 *   lexicographically by code point and ONLY against JSON strings. A JSON
 *   string "42" never satisfies `gt: 40`, and the number 42 never satisfies
 *   `gt: "40"` — Prisma's JsonFilter has one operand slot per class, and
 *   cross-class coercion is where the dialects diverge (MySQL coerces,
 *   PG raises, SQLite type-orders).
 * - A row whose path is absent, whose column is NULL, or whose value at the
 *   path is of the other class (or bool/null/object/array) NEVER matches and
 *   NEVER errors: `numberAtPath`/`stringAtPath` yield SQL NULL there, and
 *   NULL fails every comparison.
 * - Ordering is byte/code-point ordering, not the database's locale
 *   collation — see the adapters' `stringAtPath`.
 */
function buildJsonComparison(
  ctx: QueryScope,
  fieldName: string,
  column: Sql,
  path: string[],
  operation: "lt" | "lte" | "gt" | "gte",
  value: unknown
): Sql {
  const { adapter } = ctx;
  const compare = adapter.operators[operation];

  if (typeof value === "number") {
    return compare(
      adapter.json.numberAtPath(column, path),
      adapter.literals.value(value)
    );
  }
  if (typeof value === "string") {
    return compare(
      adapter.json.stringAtPath(column, path),
      adapter.literals.value(value)
    );
  }
  throw new QueryEngineError(
    `JSON filter '${operation}' for field '${fieldName}' requires a number or string operand.`
  );
}

function buildJsonFilterOperation(
  ctx: QueryScope,
  fieldName: string,
  scalarState: ScalarState,
  column: Sql,
  target: Sql,
  scope: JsonFilterScope,
  operation: string,
  value: unknown
): Sql {
  const { adapter } = ctx;
  const { path } = scope;
  // Extracted values compare in the dialect's JSON format on every side
  // (jsonb param on PG, CAST(? AS JSON) on MySQL, canonical text on SQLite)
  const jsonValue = (v: unknown) => adapter.json.value(v);
  // Portable insensitive mode folds ASCII A-Z on BOTH sides, then uses the
  // same exact-text predicates as default mode — the identical trick the
  // where-builder plays on string scalars, so JSON and scalar insensitive
  // filters agree with each other and across dialects.
  const fold = (expr: Sql) =>
    scope.mode === "insensitive"
      ? adapter.expressions.asciiCaseFold(expr)
      : expr;
  // string_* params are plain text compared against extractText output.
  const textValue = (v: unknown) => fold(adapter.literals.value(v));
  const textTarget = () => fold(adapter.json.extractText(column, path));

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
            scope
          )
        );
      }
      if (value === null && path.length === 0) {
        return adapter.operators.isNotNull(column);
      }
      return adapter.operators.neq(target, jsonValue(value));

    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return buildJsonComparison(
        ctx,
        fieldName,
        column,
        path,
        operation,
        value
      );

    case "string_contains":
      return adapter.operators.containsText(textTarget(), textValue(value));

    case "string_starts_with":
      return adapter.operators.startsWithText(textTarget(), textValue(value));

    case "string_ends_with":
      return adapter.operators.endsWithText(textTarget(), textValue(value));

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
