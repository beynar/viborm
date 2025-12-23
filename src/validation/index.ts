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
  applyOptions,
  createSchema,
  validateSchema,
} from "./helpers";

// All schemas
export {
  // Scalars
  string,
  number,
  integer,
  boolean,
  bigint,
  literal,
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
  // Objects
  object,
  // Composition
  union,
  pipe,
  transform,
  record,
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
} from "./schemas";

export type {
  // Scalar types
  StringSchema,
  NumberSchema,
  IntegerSchema,
  BooleanSchema,
  BigIntSchema,
  LiteralSchema,
  LiteralValue,
  // Date types
  DateSchema,
  IsoTimestampSchema,
  IsoDateSchema,
  IsoTimeSchema,
  // Instance type
  InstanceSchema,
  // Blob, Vector, Point types
  BlobSchema,
  VectorSchema,
  PointSchema,
  Point,
  // Wrapper types
  ArraySchema,
  NullableSchema,
  OptionalSchema,
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
  object as objectFn,
  union as unionFn,
  pipe as pipeFn,
  transform as transformFn,
  record as recordFn,
} from "./schemas";
import { Prettify } from "./types";

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
  // Objects
  object: objectFn,
  // Composition
  union: unionFn,
  pipe: pipeFn,
  transform: transformFn,
  record: recordFn,
} as const;

// Default export for convenience
export default v;

const user = v.object({
  name: v.string(),
  age: v.number(),
  friends: () => user,
});
type User = StandardSchemaV1.InferOutput<typeof user>;
