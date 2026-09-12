import type { ScalarState, ScalarType } from "@schema/scalars";
import {
  type IdDomain,
  isCompactIdFormat,
} from "@validation/primitives/id-codec";
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
/** {@link STRING_FILTER_OPERATORS} without the four that read a value as text. */
const COMPACT_ID_FILTER_OPERATORS = new Set([
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
const POINT_FILTER_OPERATORS = new Set(["equals", "not", "distance", "within"]);

const COMPARISON_SCALAR_TYPES: Set<ScalarType> = new Set([
  "int",
  "number",
  "decimal",
  "bigint",
  "date",
  "datetime",
  "time",
]);

export function assertSupportedScalarFilterOperator(
  fieldName: string,
  scalarState: ScalarState,
  operation: string,
  idDomain?: IdDomain
): void {
  if (isSupportedScalarFilterOperator(scalarState, operation, idDomain)) return;

  if (
    idDomain !== undefined &&
    STRING_FILTER_OPERATORS.has(operation) &&
    !COMPACT_ID_FILTER_OPERATORS.has(operation)
  ) {
    throw new QueryEngineError(
      `Filter operation '${operation}' reads '${fieldName}' as text, but a ${idDomain.format} column stores the identifier itself, not the text it is written as. ` +
        "Equality, set membership, ordering and cursors are exact on it; substring predicates are not."
    );
  }

  throw new QueryEngineError(
    `Unsupported filter operation '${operation}' for ${scalarState.type} scalar '${fieldName}'.`
  );
}

function isSupportedScalarFilterOperator(
  scalarState: ScalarState,
  operation: string,
  idDomain: IdDomain | undefined
): boolean {
  if (scalarState.array) {
    return LIST_FILTER_OPERATORS.has(operation);
  }

  if (scalarState.type === "string") {
    // A COMPACTLY STORED identifier keeps every operator the column can answer
    // exactly and loses the four that read it as text. The validation schema
    // already removed them from the type and from what it admits; this is the
    // engine boundary's own statement of the same fact, for a program that
    // reaches the builder without one.
    return idDomain !== undefined && isCompactIdFormat(idDomain.format)
      ? COMPACT_ID_FILTER_OPERATORS.has(operation)
      : STRING_FILTER_OPERATORS.has(operation);
  }

  if (SET_MEMBERSHIP_SCALAR_TYPES.has(scalarState.type)) {
    return SET_MEMBERSHIP_FILTER_OPERATORS.has(operation);
  }

  if (scalarState.type === "json") {
    return JSON_FILTER_OPERATORS.has(operation);
  }

  if (scalarState.type === "point") {
    return POINT_FILTER_OPERATORS.has(operation);
  }

  if (COMPARISON_SCALAR_TYPES.has(scalarState.type)) {
    return COMPARISON_FILTER_OPERATORS.has(operation);
  }

  return BASE_FILTER_OPERATORS.has(operation);
}
