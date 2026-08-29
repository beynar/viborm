// =============================================================================
// VibORM Validation Library
// =============================================================================
//
// A minimal, StandardSchema-compliant validation library with:
// - Recursive type support (thunks for circular references)
// - Fail-fast validation (throws on first error)
// - Options-based API (optional, nullable, array, transform, default)
// - Strict objects by default
//
// =============================================================================

export { createSchemaRegistry } from "./builder";
export type { inferred as inferredType } from "./inferred";
// Branded type symbol
export { inferred } from "./inferred";
// JSON Schema conversion (StandardJSONSchemaV1)
export type { JsonSchema } from "./json-schema";
export { createJsonSchemaConverter, toJsonSchema } from "./json-schema";
export type {
  ArgsSchemas,
  CoreSchemas,
  ModelArgsSchemas,
  ModelCoreInput,
  ModelCoreSchemas,
  ModelOperationInput,
  ModelRelationNestedInput,
  ModelSchemas,
  ModelStateSchemas,
  ScalarSchemas,
} from "./model";
export type { BaseBigIntSchema } from "./primitives/bigint";
export type { BaseBlobSchema } from "./primitives/blob";
export type { BaseBooleanSchema } from "./primitives/boolean";
export type { BaseEnumSchema } from "./primitives/enum";
export type {
  GeoArea,
  GeoBounds,
  GeoPolygon,
} from "./primitives/geo-area-codec";
export type { GeoPoint } from "./primitives/geo-point-codec";
export type {
  BaseIsoDateSchema,
  BaseIsoTimeSchema,
  BaseIsoTimestampSchema,
} from "./primitives/iso";
export type {
  BaseJsonSchema,
  InputJsonValue,
  JsonValue,
} from "./primitives/json";
export type { BaseIntegerSchema, BaseNumberSchema } from "./primitives/number";
export type { ObjectSchema } from "./primitives/object";
export type { BasePointSchema } from "./primitives/point";
// V Namespace - Type-level schema mirrors for explicit type annotations
// Convenience namespace (v.string(), v.number(), etc.)
export { type V, v, v as default } from "./primitives/v";
export type { BaseVectorSchema } from "./primitives/vector";
export type {
  InferInput,
  InferOutput,
  ParseResult,
  Prettify,
  SchemaRegistryLookup,
  SchemaRegistryOperation,
  VibSchema,
} from "./types";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { validationFailureFromThrown } from "./parse-failure";
import type { ParseResult, ValidationFailure } from "./types";
import { isFunction, isRecord } from "./value-guards";

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
  return isRecord(value) && "then" in value && isFunction(value.then);
};

const asyncValidationFailure: ValidationFailure = {
  issues: [{ message: "Async validation is not supported" }],
};

const malformedValidationFailure: ValidationFailure = {
  issues: [{ message: "Schema returned a malformed validation result" }],
};

export function parse<const S extends StandardSchemaV1>(
  schema: S,
  value: unknown
): ParseResult<S>;
export function parse(
  schema: StandardSchemaV1,
  value: unknown
): StandardSchemaV1.Result<unknown> {
  try {
    const result = schema["~standard"].validate(value);
    if (isPromiseLike(result)) {
      return asyncValidationFailure;
    }
    if (!isRecord(result)) return malformedValidationFailure;

    const issues = Reflect.get(result, "issues");
    if (issues !== undefined) {
      return Array.isArray(issues) ? { issues } : malformedValidationFailure;
    }
    if (!("value" in result)) return malformedValidationFailure;
    return { value: Reflect.get(result, "value") };
  } catch (cause) {
    return validationFailureFromThrown(cause);
  }
}
