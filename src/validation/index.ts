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
export type { inferred as inferredType } from "./inferred";

// Branded type symbol
export { inferred } from "./inferred";
// V Namespace - Type-level schema mirrors for explicit type annotations
// Convenience namespace (v.string(), v.number(), etc.)
export { type V, v, v as default } from "./primitives/v";
export { createSchemaRegistry, SchemaRegistry } from "./builder";
export type {
  ArgsSchemas,
  CoreSchemas,
  FieldSchemas,
  ModelArgsSchemas,
  ModelCoreInput,
  ModelCoreSchemas,
  ModelOperationInput,
  ModelRelationNestedInput,
  ModelSchemas,
  ModelStateSchemas,
} from "./model";
export type {
  InferInput,
  InferOutput,
  Prettify,
  ParseResult,
  SchemaRegistryLookup,
  SchemaRegistryOperation,
  VibSchema,
} from "./types";
export type { BaseBigIntSchema } from "./primitives/bigint";
export type { BaseBlobSchema } from "./primitives/blob";
export type { BaseBooleanSchema } from "./primitives/boolean";
export type { BaseEnumSchema } from "./primitives/enum";
export type {
  BaseIsoDateSchema,
  BaseIsoTimeSchema,
  BaseIsoTimestampSchema,
} from "./primitives/iso";
export type { BaseJsonSchema, JsonValue } from "./primitives/json";
export type { BaseIntegerSchema, BaseNumberSchema } from "./primitives/number";
export type { ObjectSchema } from "./primitives/object";
export type { BasePointSchema } from "./primitives/point";
export type { BaseVectorSchema } from "./primitives/vector";
// JSON Schema conversion (StandardJSONSchemaV1)
export type { JsonSchema } from "./json-schema";
export { createJsonSchemaConverter, toJsonSchema } from "./json-schema";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ParseResult, ValidationFailure } from "./types";

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
  const candidate = value as { then?: unknown };
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof candidate.then === "function"
  );
};

const asyncValidationFailure: ValidationFailure = {
  issues: [{ message: "Async validation is not supported" }],
};

export function parse<const S extends StandardSchemaV1>(
  schema: S,
  value: unknown
): ParseResult<S>;
export function parse(
  schema: StandardSchemaV1,
  value: unknown
): StandardSchemaV1.Result<unknown> {
  const result = schema["~standard"].validate(value);
  if (isPromiseLike(result)) {
    return asyncValidationFailure;
  }
  return result;
}