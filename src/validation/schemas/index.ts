// =============================================================================
// VibORM Validation Schemas
// =============================================================================

export type { ArraySchema } from "./array";
// Wrapper schemas
export { array } from "./array";
export type { BaseBigIntSchema, BigIntSchema } from "./bigint";
export { bigint, validateBigInt } from "./bigint";
export type { BaseBlobSchema, BlobSchema } from "./blob";
// Blob schema (Uint8Array/Buffer)
export { blob, validateBlob } from "./blob";
export type { BaseBooleanSchema, BooleanSchema } from "./boolean";
export { boolean, validateBoolean } from "./boolean";
export type { BaseDateSchema, DateSchema } from "./date";
// Date schemas
export { date, validateDate } from "./date";
export type { BaseEnumSchema, EnumSchema } from "./enum";
export { enum_ } from "./enum";
export type { InstanceSchema } from "./instance";
// Instance schema (for Uint8Array, Buffer, etc.)
export { instance } from "./instance";
export type {
  BaseIsoDateSchema,
  BaseIsoTimeSchema,
  BaseIsoTimestampSchema,
  IsoDateSchema,
  IsoTimeSchema,
  IsoTimestampSchema,
} from "./iso";
export {
  isoDate,
  isoTime,
  isoTimestamp,
  validateIsoDate,
  validateIsoTime,
  validateIsoTimestamp,
} from "./iso";
export type { BaseJsonSchema, JsonSchema, JsonValue } from "./json";
export { isJsonValue, json, validateJson } from "./json";
export type { LiteralSchema, LiteralValue } from "./literal";
export { literal } from "./literal";
export type { NonArraySchema } from "./nonArray";
export { element, nonArray } from "./nonArray";
export type { NonNullableSchema } from "./nonNullable";
// Negative schemas (narrowing wrappers)
export { nonNullable } from "./nonNullable";
export type { NonOptionalSchema } from "./nonOptional";
export { nonOptional, required } from "./nonOptional";
export type { NullableSchema } from "./nullable";
export { maybeNullable, nullable } from "./nullable";
export type {
  BaseIntegerSchema,
  BaseNumberSchema,
  IntegerSchema,
  NumberSchema,
} from "./number";
export { integer, number, validateInteger, validateNumber } from "./number";
export type { ObjectEntries, ObjectOptions, ObjectSchema } from "./object";
// Object schemas
export { object } from "./object";
export type { OptionalSchema } from "./optional";
export { optional } from "./optional";
export type { BasePointSchema, Point, PointSchema } from "./point";
// Point schema ({ x, y } coordinates)
export { point, validatePoint } from "./point";
export type { BaseStringSchema, StringSchema } from "./string";
// Scalar schemas
export { string, validateString } from "./string";
export type { UnionSchema } from "./union";
// Composition schemas
export { union } from "./union";
export type { BaseVectorSchema, VectorSchema } from "./vector";
// Vector schema (array of numbers for embeddings)
export { validateVector, vector } from "./vector";

// Note: lazy() removed - use thunks directly in object entries: () => schema
// This is simpler and handles circular references automatically

export type {
  AllPathsToSchemas,
  FromObjectOptions,
  FromObjectSchema,
} from "./from-object";
export { fromObject } from "./from-object";
export type { PipeAction, PipeSchema, TransformAction } from "./pipe";
export { pipe, transform as transformAction } from "./pipe";
export type { FromKeysOptions, RecordSchema } from "./record";
export { fromKeys, record } from "./record";
export type { TransformSchema } from "./transform";
export { coerce, map } from "./transform";
