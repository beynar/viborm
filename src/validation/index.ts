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

// Helpers
export {
  buildValidator,
  createSchema,
  fail,
  getDefault,
  ok,
  validateSchema,
} from "./helpers";
export type { inferred as inferredType } from "./inferred";

// Branded type symbol
export { inferred } from "./inferred";
// JSON Schema conversion (StandardJSONSchemaV1)
export type {
  JsonSchema as JSONSchemaOutput,
  JsonSchemaConverter,
  JsonSchemaOptions,
  JsonSchemaTarget,
} from "./json-schema";
export { createJsonSchemaConverter, toJsonSchema } from "./json-schema";
export type {
  AllPathsToSchemas,
  // Wrapper types
  ArraySchema,
  BaseBigIntSchema,
  BaseBlobSchema,
  BaseBooleanSchema,
  BaseDateSchema,
  BaseEnumSchema,
  BaseIntegerSchema,
  BaseIsoDateSchema,
  BaseIsoTimeSchema,
  BaseIsoTimestampSchema,
  BaseJsonSchema,
  BaseNumberSchema,
  BasePointSchema,
  BaseStringSchema,
  BaseVectorSchema,
  BigIntSchema,
  // Blob, Vector, Point types
  BlobSchema,
  BooleanSchema,
  // Date types
  DateSchema,
  EnumSchema,
  FromKeysOptions,
  FromObjectOptions,
  FromObjectSchema,
  // Instance type
  InstanceSchema,
  IntegerSchema,
  IsoDateSchema,
  IsoTimeSchema,
  IsoTimestampSchema,
  JsonSchema,
  JsonValue,
  LiteralSchema,
  LiteralValue,
  NonArraySchema,
  // Negative wrapper types
  NonNullableSchema,
  NonOptionalSchema,
  NullableSchema,
  NumberSchema,
  ObjectEntries,
  ObjectOptions,
  // Object types
  ObjectSchema,
  OptionalSchema,
  PipeAction,
  PipeSchema,
  Point,
  PointSchema,
  RecordSchema,
  // Scalar types
  StringSchema,
  TransformAction,
  // Transform wrapper type
  TransformSchema,
  // Composition types
  UnionSchema,
  VectorSchema,
} from "./schemas";
// All schemas
export {
  // Wrappers
  array,
  bigint,
  // Blob, Vector, Point
  blob,
  boolean,
  // Transform wrapper
  coerce,
  // Date & Time
  date,
  element,
  enum_,
  fromKeys,
  fromObject,
  // Instance (Uint8Array, Buffer, etc.)
  instance,
  integer,
  isJsonValue,
  isoDate,
  isoTime,
  isoTimestamp,
  json,
  literal,
  map,
  maybeNullable,
  nonArray,
  // Negative wrappers (narrowing)
  nonNullable,
  nonOptional,
  nullable,
  number,
  // Objects
  object,
  optional,
  pipe,
  point,
  record,
  required,
  // Scalars
  string,
  transformAction,
  // Composition
  union,
  validateBigInt,
  validateBlob,
  validateBoolean,
  validateDate,
  validateInteger,
  validateIsoDate,
  validateIsoTime,
  validateIsoTimestamp,
  validateJson,
  validateNumber,
  validatePoint,
  // Validators (for reuse)
  validateString,
  validateVector,
  vector,
} from "./schemas";
// Core types
export type {
  Cast,
  ComputeInput,
  ComputeOutput,
  InferInput,
  InferInputShape,
  InferOutput,
  InferOutputShape,
  Prettify,
  ScalarOptions,
  ThunkCast,
  ValidationFailure,
  ValidationIssue,
  ValidationResult,
  ValidationSuccess,
  VibSchema,
} from "./types";
export { isVibSchema } from "./types";

// V Namespace - Type-level schema mirrors for explicit type annotations
export type { V } from "./V";

// =============================================================================
// Convenience namespace (v.string(), v.number(), etc.)
// =============================================================================

import {
  array as arrayFn,
  bigint as bigintFn,
  blob as blobFn,
  boolean as booleanFn,
  coerce as coerceFn,
  date as dateFn,
  element as elementFn,
  enum_ as enumFn,
  fromKeys as fromKeysFn,
  fromObject as fromObjectFn,
  instance as instanceFn,
  integer as integerFn,
  isoDate as isoDateFn,
  isoTime as isoTimeFn,
  isoTimestamp as isoTimestampFn,
  json as jsonFn,
  literal as literalFn,
  map as mapFn,
  maybeNullable as maybeNullableFn,
  nonArray as nonArrayFn,
  nonNullable as nonNullableFn,
  nonOptional as nonOptionalFn,
  nullable as nullableFn,
  number as numberFn,
  object as objectFn,
  optional as optionalFn,
  pipe as pipeFn,
  point as pointFn,
  record as recordFn,
  required as requiredFn,
  string as stringFn,
  transformAction as transformActionFn,
  union as unionFn,
  vector as vectorFn,
} from "./schemas";
import type { Prettify, VibSchema } from "./types";
export type { Prettify as Simplify };
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
  maybeNullable: maybeNullableFn,
  optional: optionalFn,
  // Negative wrappers (narrowing)
  nonNullable: nonNullableFn,
  nonOptional: nonOptionalFn,
  required: requiredFn,
  nonArray: nonArrayFn,
  element: elementFn,
  // Objects
  object: objectFn,
  fromObject: fromObjectFn,
  // Composition
  union: unionFn,
  pipe: pipeFn,
  transformAction: transformActionFn,
  record: recordFn,
  fromKeys: fromKeysFn,
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
