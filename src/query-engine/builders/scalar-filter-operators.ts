import type { ScalarState, ScalarType } from "@schema/scalars";
import { QueryEngineError } from "../types";

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
