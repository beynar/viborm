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

// Core types
export type {
  VibSchema,
  Cast,
  ThunkCast,
  ScalarOptions,
  InferInput,
  InferOutput,
  InferInputShape,
  InferOutputShape,
  ComputeInput,
  ComputeOutput,
  ValidationResult,
  ValidationSuccess,
  ValidationFailure,
  ValidationIssue,
  Prettify,
} from "./types";

export { isVibSchema } from "./types";

// Branded type symbol
export { inferred } from "./inferred";
export type { inferred as inferredType } from "./inferred";

// Helpers
export {
  fail,
  ok,
  getDefault,
  buildValidator,
  createSchema,
  validateSchema,
} from "./helpers";

// JSON Schema conversion (StandardJSONSchemaV1)
export type {
  JsonSchema as JSONSchemaOutput,
  JsonSchemaTarget,
  JsonSchemaOptions,
  JsonSchemaConverter,
} from "./json-schema";

export { toJsonSchema, createJsonSchemaConverter } from "./json-schema";

// All schemas
export {
  // Scalars
  string,
  number,
  integer,
  boolean,
  bigint,
  literal,
  enum_,
  json,
  // Date & Time
  date,
  isoTimestamp,
  isoDate,
  isoTime,
  // Instance (Uint8Array, Buffer, etc.)
  instance,
  // Blob, Vector, Point
  blob,
  vector,
  point,
  // Wrappers
  array,
  nullable,
  optional,
  // Negative wrappers (narrowing)
  nonNullable,
  nonOptional,
  required,
  nonArray,
  element,
  // Objects
  object,
  // Composition
  union,
  pipe,
  transformAction,
  record,
  // Transform wrapper
  coerce,
  map,
  // Validators (for reuse)
  validateString,
  validateNumber,
  validateInteger,
  validateBoolean,
  validateBigInt,
  validateDate,
  validateIsoTimestamp,
  validateIsoDate,
  validateIsoTime,
  validateBlob,
  validateVector,
  validatePoint,
  validateJson,
  isJsonValue,
} from "./schemas";

export type {
  // Scalar types
  StringSchema,
  BaseStringSchema,
  NumberSchema,
  BaseNumberSchema,
  IntegerSchema,
  BaseIntegerSchema,
  BooleanSchema,
  BaseBooleanSchema,
  BigIntSchema,
  BaseBigIntSchema,
  LiteralSchema,
  LiteralValue,
  EnumSchema,
  BaseEnumSchema,
  JsonSchema,
  BaseJsonSchema,
  JsonValue,
  // Date types
  DateSchema,
  BaseDateSchema,
  IsoTimestampSchema,
  BaseIsoTimestampSchema,
  IsoDateSchema,
  BaseIsoDateSchema,
  IsoTimeSchema,
  BaseIsoTimeSchema,
  // Instance type
  InstanceSchema,
  // Blob, Vector, Point types
  BlobSchema,
  BaseBlobSchema,
  VectorSchema,
  BaseVectorSchema,
  PointSchema,
  BasePointSchema,
  Point,
  // Wrapper types
  ArraySchema,
  NullableSchema,
  OptionalSchema,
  // Negative wrapper types
  NonNullableSchema,
  NonOptionalSchema,
  NonArraySchema,
  // Object types
  ObjectSchema,
  ObjectEntries,
  ObjectOptions,

  // Composition types
  UnionSchema,
  PipeSchema,
  TransformAction,
  PipeAction,
  RecordSchema,
  // Transform wrapper type
  TransformSchema,
} from "./schemas";

import { StandardSchemaV1 } from "@standard-schema";
// =============================================================================
// Convenience namespace (v.string(), v.number(), etc.)
// =============================================================================

import {
  string as stringFn,
  number as numberFn,
  integer as integerFn,
  boolean as booleanFn,
  bigint as bigintFn,
  literal as literalFn,
  enum_ as enumFn,
  json as jsonFn,
  date as dateFn,
  isoTimestamp as isoTimestampFn,
  isoDate as isoDateFn,
  isoTime as isoTimeFn,
  instance as instanceFn,
  blob as blobFn,
  vector as vectorFn,
  point as pointFn,
  array as arrayFn,
  nullable as nullableFn,
  optional as optionalFn,
  nonNullable as nonNullableFn,
  nonOptional as nonOptionalFn,
  required as requiredFn,
  nonArray as nonArrayFn,
  element as elementFn,
  object as objectFn,
  union as unionFn,
  pipe as pipeFn,
  transformAction as transformActionFn,
  record as recordFn,
  coerce as coerceFn,
  map as mapFn,
} from "./schemas";
import { Prettify, VibSchema } from "./types";

/**
 * VibORM validation namespace.
 *
 * @example
 * import { v } from "viborm/validation";
 *
 * const user = v.object({
 *   name: v.string(),
 *   age: v.number({ optional: true }),
 *   email: v.string(),
 *   createdAt: v.date(),
 * });
 *
 * // Circular references use thunks
 * const node = v.object({
 *   value: v.string(),
 *   parent: () => node,  // Thunk for self-reference
 * });
 */
export const v = {
  // Scalars
  string: stringFn,
  number: numberFn,
  integer: integerFn,
  boolean: booleanFn,
  bigint: bigintFn,
  literal: literalFn,
  enum: enumFn,
  json: jsonFn,
  // Date & Time
  date: dateFn,
  isoTimestamp: isoTimestampFn,
  isoDate: isoDateFn,
  isoTime: isoTimeFn,
  // Instance
  instance: instanceFn,
  // Blob, Vector, Point
  blob: blobFn,
  vector: vectorFn,
  point: pointFn,
  // Wrappers
  array: arrayFn,
  nullable: nullableFn,
  optional: optionalFn,
  // Negative wrappers (narrowing)
  nonNullable: nonNullableFn,
  nonOptional: nonOptionalFn,
  required: requiredFn,
  nonArray: nonArrayFn,
  element: elementFn,
  // Objects
  object: objectFn,
  // Composition
  union: unionFn,
  pipe: pipeFn,
  transformAction: transformActionFn,
  record: recordFn,
  // Transform wrappers
  coerce: coerceFn,
  map: mapFn,
} as const;

// Default export for convenience
export default v;

export const parse = <const S extends VibSchema>(schema: S, value: unknown) => {
  return schema["~standard"].validate(value) as Awaited<
    ReturnType<(typeof schema)["~standard"]["validate"]>
  >;
};
