// JSON Field Schemas
// Explicit ArkType schemas for all json field variants
// Supports both untyped (unknown) and typed (StandardSchema) JSON fields

import { type, Type } from "arktype";
import type { StandardSchemaV1 } from "../../../standardSchema";
import {
  typeFromStandardSchema,
  type StandardSchemaToArkType,
} from "../standard-schema";

// =============================================================================
// UNTYPED BASE SCHEMAS (fallback when no StandardSchema is provided)
// =============================================================================

// JSON accepts any valid JSON value
export const jsonBase = type("unknown");
export const jsonNullable = jsonBase.or("null");

// =============================================================================
// UNTYPED FILTER SCHEMAS - JSON accepts shorthand values directly
// Note: Due to ArkType union limitations with morphs on unknown type,
// JSON shorthand normalization cannot be done here
// =============================================================================

// JSON filtering is typically path-based or equality
export const jsonFilter = type({
  equals: jsonBase,
  not: jsonNullable,
  path: "string[]",
  string_contains: "string",
  string_starts_with: "string",
  string_ends_with: "string",
  array_contains: jsonBase,
  array_starts_with: jsonBase,
  array_ends_with: jsonBase,
}).partial();

export const jsonNullableFilter = type({
  equals: jsonNullable,
  not: jsonNullable,
  path: "string[]",
  string_contains: "string",
  string_starts_with: "string",
  string_ends_with: "string",
  array_contains: jsonBase,
  array_starts_with: jsonBase,
  array_ends_with: jsonBase,
}).partial();

// =============================================================================
// UNTYPED CREATE SCHEMAS
// =============================================================================

export const jsonCreate = jsonBase;
export const jsonNullableCreate = jsonNullable;
export const jsonOptionalCreate = jsonBase.or("undefined");
export const jsonOptionalNullableCreate = jsonNullable.or("undefined");

// =============================================================================
// UNTYPED UPDATE SCHEMAS - JSON just accepts the value directly (no set wrapper)
// Unlike numbers, JSON has no operations like increment/multiply
// =============================================================================

export const jsonUpdate = jsonBase;
export const jsonNullableUpdate = jsonNullable;

// =============================================================================
// TYPE EXPORTS (untyped)
// =============================================================================

export type JsonBase = typeof jsonBase.infer;
export type JsonNullable = typeof jsonNullable.infer;
export type JsonFilter = typeof jsonFilter.infer;
export type JsonNullableFilter = typeof jsonNullableFilter.infer;
export type JsonUpdate = typeof jsonUpdate.infer;
export type JsonNullableUpdate = typeof jsonNullableUpdate.infer;

// =============================================================================
// TYPED JSON TYPE HELPERS (when StandardSchema is provided)
// =============================================================================

/** Base typed JSON type derived from StandardSchema */
export type JsonType<TSchema extends StandardSchemaV1> =
  StandardSchemaToArkType<TSchema>;

/** Nullable typed JSON type */
export type JsonNullableType<TSchema extends StandardSchemaV1> = Type<
  StandardSchemaV1.InferOutput<TSchema> | null,
  {}
>;

/** Typed JSON filter type */
export type JsonFilterType<TSchema extends StandardSchemaV1> = Type<
  | {
      equals?: StandardSchemaV1.InferOutput<TSchema>;
      not?: StandardSchemaV1.InferOutput<TSchema> | null;
      path?: string[];
      string_contains?: string;
      string_starts_with?: string;
      string_ends_with?: string;
      array_contains?: StandardSchemaV1.InferOutput<TSchema>;
      array_starts_with?: StandardSchemaV1.InferOutput<TSchema>;
      array_ends_with?: StandardSchemaV1.InferOutput<TSchema>;
    }
  | StandardSchemaV1.InferOutput<TSchema>,
  {}
>;

/** Nullable typed JSON filter type */
export type JsonNullableFilterType<TSchema extends StandardSchemaV1> = Type<
  | {
      equals?: StandardSchemaV1.InferOutput<TSchema> | null;
      not?: StandardSchemaV1.InferOutput<TSchema> | null;
      path?: string[];
      string_contains?: string;
      string_starts_with?: string;
      string_ends_with?: string;
      array_contains?: StandardSchemaV1.InferOutput<TSchema>;
      array_starts_with?: StandardSchemaV1.InferOutput<TSchema>;
      array_ends_with?: StandardSchemaV1.InferOutput<TSchema>;
    }
  | StandardSchemaV1.InferOutput<TSchema>
  | null,
  {}
>;

/** Typed JSON update type - just the value, no set wrapper */
export type JsonUpdateType<TSchema extends StandardSchemaV1> = Type<
  StandardSchemaV1.InferInput<TSchema>,
  {}
>;

/** Nullable typed JSON update type - just the value or null, no set wrapper */
export type JsonNullableUpdateType<TSchema extends StandardSchemaV1> = Type<
  StandardSchemaV1.InferInput<TSchema> | null,
  {}
>;

/** Optional typed JSON create type */
export type JsonOptionalType<TSchema extends StandardSchemaV1> = Type<
  StandardSchemaV1.InferInput<TSchema> | undefined,
  {}
>;

/** Optional nullable typed JSON create type */
export type JsonOptionalNullableType<TSchema extends StandardSchemaV1> = Type<
  StandardSchemaV1.InferInput<TSchema> | null | undefined,
  {}
>;

// =============================================================================
// TYPED SCHEMA BUILDERS (when StandardSchema is provided)
// =============================================================================

/**
 * Creates base typed JSON schema from StandardSchema
 */
export const createJsonBase = <TSchema extends StandardSchemaV1>(
  schema: TSchema
): JsonType<TSchema> => {
  return typeFromStandardSchema(schema) as JsonType<TSchema>;
};

/**
 * Creates nullable typed JSON schema
 * Note: Returns unknown|null since morphs can't be unioned with null
 */
export const createJsonNullable = <TSchema extends StandardSchemaV1>(
  schema: TSchema
): JsonNullableType<TSchema> => {
  return type("unknown | null") as unknown as JsonNullableType<TSchema>;
};

/**
 * Creates typed JSON filter schema
 * Note: Shorthand normalization is not supported for typed JSON due to ArkType limitations
 */
export const createJsonFilter = <TSchema extends StandardSchemaV1>(
  schema: TSchema
): JsonFilterType<TSchema> => {
  return type({
    "equals?": "unknown",
    "not?": type("unknown").or("null"),
    "path?": "string[]",
    "string_contains?": "string",
    "string_starts_with?": "string",
    "string_ends_with?": "string",
    "array_contains?": "unknown",
    "array_starts_with?": "unknown",
    "array_ends_with?": "unknown",
  }) as unknown as JsonFilterType<TSchema>;
};

/**
 * Creates nullable typed JSON filter schema
 * Note: Shorthand normalization is not supported for typed JSON due to ArkType limitations
 */
export const createJsonNullableFilter = <TSchema extends StandardSchemaV1>(
  schema: TSchema
): JsonNullableFilterType<TSchema> => {
  return type({
    "equals?": type("unknown").or("null"),
    "not?": type("unknown").or("null"),
    "path?": "string[]",
    "string_contains?": "string",
    "string_starts_with?": "string",
    "string_ends_with?": "string",
    "array_contains?": "unknown",
    "array_starts_with?": "unknown",
    "array_ends_with?": "unknown",
  }) as unknown as JsonNullableFilterType<TSchema>;
};

/**
 * Creates typed JSON update schema - just accepts the value directly
 */
export const createJsonUpdate = <TSchema extends StandardSchemaV1>(
  schema: TSchema
): JsonUpdateType<TSchema> => {
  return typeFromStandardSchema(schema) as JsonUpdateType<TSchema>;
};

/**
 * Creates nullable typed JSON update schema - accepts value or null
 */
export const createJsonNullableUpdate = <TSchema extends StandardSchemaV1>(
  schema: TSchema
): JsonNullableUpdateType<TSchema> => {
  return type("unknown | null") as unknown as JsonNullableUpdateType<TSchema>;
};

/**
 * Creates optional typed JSON create schema
 * Note: Returns base type since morphs can't be unioned with undefined
 */
export const createJsonOptionalCreate = <TSchema extends StandardSchemaV1>(
  schema: TSchema
): JsonOptionalType<TSchema> => {
  // Use unknown with undefined since we can't union morph with undefined
  return type("unknown | undefined") as unknown as JsonOptionalType<TSchema>;
};

/**
 * Creates optional nullable typed JSON create schema
 * Note: Returns base type since morphs can't be unioned with undefined/null
 */
export const createJsonOptionalNullableCreate = <TSchema extends StandardSchemaV1>(
  schema: TSchema
): JsonOptionalNullableType<TSchema> => {
  // Use unknown with null/undefined since we can't union morph with them
  return type("unknown | null | undefined") as unknown as JsonOptionalNullableType<TSchema>;
};
