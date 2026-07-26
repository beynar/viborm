import type { ScalarState, ScalarType } from "@schema/scalars";
import { QueryEngineError } from "../types";

const BASE_FILTER_OPERATORS = new Set(["equals", "not"]);
// Scalars that are comparable for EQUALITY but carry no ordering: set
// membership is meaningful, `lt`/`gt` are not. Matches Prisma's EnumFilter and
// BytesFilter, both of which expose in/notIn without the range operators.
const SET_MEMBERSHIP_FILTER_OPERATORS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
]);
const SET_MEMBERSHIP_SCALAR_TYPES: Set<ScalarType> = new Set(["enum", "blob"]);
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
  "mode",
  "lt",
  "lte",
  "gt",
  "gte",
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

export function assertSupportedScalarFilterOperator(
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

  if (SET_MEMBERSHIP_SCALAR_TYPES.has(scalarState.type)) {
    return SET_MEMBERSHIP_FILTER_OPERATORS.has(operation);
  }

  if (scalarState.type === "json") {
    return JSON_FILTER_OPERATORS.has(operation);
  }

  if (COMPARISON_SCALAR_TYPES.has(scalarState.type)) {
    return COMPARISON_FILTER_OPERATORS.has(operation);
  }

  return BASE_FILTER_OPERATORS.has(operation);
}
