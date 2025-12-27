// =============================================================================
// VibORM Validation Schemas
// =============================================================================

// Scalar schemas
export { string, validateString } from "./string";
export type { StringSchema, BaseStringSchema } from "./string";

export { number, integer, validateNumber, validateInteger } from "./number";
export type { NumberSchema, IntegerSchema } from "./number";

export { boolean, validateBoolean } from "./boolean";
export type { BooleanSchema } from "./boolean";

export { bigint, validateBigInt } from "./bigint";
export type { BigIntSchema } from "./bigint";

export { literal } from "./literal";
export type { LiteralSchema, LiteralValue } from "./literal";

export { enum_ } from "./enum";
export type { EnumSchema } from "./enum";

export { json, validateJson, isJsonValue } from "./json";
export type { JsonSchema, JsonValue } from "./json";

// Date schemas
export { date, validateDate } from "./date";
export type { DateSchema } from "./date";

export {
  isoTimestamp,
  isoDate,
  isoTime,
  validateIsoTimestamp,
  validateIsoDate,
  validateIsoTime,
} from "./iso";
export type { IsoTimestampSchema, IsoDateSchema, IsoTimeSchema } from "./iso";

// Instance schema (for Uint8Array, Buffer, etc.)
export { instance } from "./instance";
export type { InstanceSchema } from "./instance";

// Blob schema (Uint8Array/Buffer)
export { blob, validateBlob } from "./blob";
export type { BlobSchema } from "./blob";

// Vector schema (array of numbers for embeddings)
export { vector, validateVector } from "./vector";
export type { VectorSchema } from "./vector";

// Point schema ({ x, y } coordinates)
export { point, validatePoint } from "./point";
export type { PointSchema, Point } from "./point";

// Wrapper schemas
export { array } from "./array";
export type { ArraySchema } from "./array";

export { nullable } from "./nullable";
export type { NullableSchema } from "./nullable";

export { optional } from "./optional";
export type { OptionalSchema } from "./optional";

// Negative schemas (narrowing wrappers)
export { nonNullable } from "./nonNullable";
export type { NonNullableSchema } from "./nonNullable";

export { nonOptional, required } from "./nonOptional";
export type { NonOptionalSchema } from "./nonOptional";

export { nonArray, element } from "./nonArray";
export type { NonArraySchema } from "./nonArray";

// Object schemas
export { object } from "./object";
export type { ObjectSchema, ObjectEntries, ObjectOptions } from "./object";

// Composition schemas
export { union } from "./union";
export type { UnionSchema } from "./union";

// Note: lazy() removed - use thunks directly in object entries: () => schema
// This is simpler and handles circular references automatically

export { pipe, transform as transformAction } from "./pipe";
export type { PipeSchema, TransformAction, PipeAction } from "./pipe";

export { coerce, map } from "./transform";
export type { TransformSchema } from "./transform";

export { record } from "./record";
export type { RecordSchema } from "./record";
