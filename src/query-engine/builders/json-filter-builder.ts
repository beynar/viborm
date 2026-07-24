import type { ScalarState } from "@schema/scalars";
import type { Sql } from "@sql";
import { QueryEngineError, type QueryScope } from "../types";
import { assertSupportedScalarFilterOperator } from "./scalar-filter-operators";

/**
 * Build a JSON scalar filter. `path` scopes every other operator in the
 * filter object to the value at that path (Prisma semantics); without a
 * path, operators apply to the document root. A nested `not` filter
 * inherits the outer path unless it sets its own.
 */
export function buildJsonFilter(
  ctx: QueryScope,
  fieldName: string,
  scalarState: ScalarState,
  column: Sql,
  filter: Record<string, unknown>,
  inheritedPath: string[] = []
): Sql {
  const path = Array.isArray(filter.path)
    ? filter.path.map(String)
    : inheritedPath;
  assertPortableJsonPath(fieldName, path);
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

function assertPortableJsonPath(fieldName: string, path: string[]): void {
  const invalidSegment = path.find(
    (segment) => segment.includes('"') || segment.includes("\\")
  );
  if (invalidSegment === undefined) return;
  throw new QueryEngineError(
    `JSON filter for field '${fieldName}' requires a portable JSON path; segments containing '"' or '\\' are not supported.`
  );
}

function buildJsonFilterOperation(
  ctx: QueryScope,
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
  // string_* params are plain text compared against extractText output.
  const textValue = (v: unknown) => adapter.literals.value(v);

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
      return adapter.operators.containsText(
        adapter.json.extractText(column, path),
        textValue(value)
      );

    case "string_starts_with":
      return adapter.operators.startsWithText(
        adapter.json.extractText(column, path),
        textValue(value)
      );

    case "string_ends_with":
      return adapter.operators.endsWithText(
        adapter.json.extractText(column, path),
        textValue(value)
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
