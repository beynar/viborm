// Schema Builder Entry Point
// Main API for defining models, scalars, and relations

import { model } from "./model";
import { toMany, toOne } from "./relation";
import {
  bigInt,
  blob,
  boolean,
  date,
  dateTime,
  decimal,
  enumScalar,
  float,
  int,
  json,
  point,
  string,
  time,
  vector,
} from "./scalars";

// =============================================================================
// SCHEMA BUILDER API
// =============================================================================

/**
 * Main schema builder object
 * Use this to define models, scalars, and relations
 *
 * A relation states two independent facts: `s.toOne` / `s.toMany` states the
 * SLOT CARDINALITY, and the argument states the TARGET DOMAIN — one model
 * (`() => model`) or named variants (`{ post: () => post, video: () => video }`).
 * Everything else about an edge is derived from the full schema graph.
 *
 * @example
 * ```ts
 * import { s } from "viborm";
 *
 * const user = s.model({
 *   id: s.string().id().ulid(),
 *   name: s.string(),
 *   email: s.string().unique(),
 *   posts: s.toMany(() => post),
 *   profile: s.toOne(() => profile),
 * }).map("users");
 *
 * const post = s.model({
 *   id: s.string().id().ulid(),
 *   authorId: s.string(),
 *   author: s.toOne(() => user).fields("authorId").references("id"),
 * }).map("posts");
 * ```
 */
export const s = {
  // Model factory
  model,

  // Scalar factories
  string,
  boolean,
  /**
   * @description Creates a new int scalar.
   * @param nativeType - The native type to use for the scalar.
   * @returns A new int scalar.
   */
  int,
  float,
  decimal,
  bigInt,
  dateTime,
  date,
  time,
  json,
  blob,
  enum: enumScalar,
  point,
  vector,

  // Relation factories: slot cardinality here, target domain in the argument
  toOne,
  toMany,
};

// =============================================================================
// RE-EXPORTS
// =============================================================================

// Hydration exports (excluding Schema type which conflicts with validation)
export {
  getFieldSqlName,
  getModelSqlName,
  hydrateSchemaNames,
  isSchemaHydrated,
} from "./hydration";
// JSON null sentinels — the two nulls of a nullable JSON column, told apart
export {
  type AnyJsonNullSentinel,
  AnyNull,
  DbNull,
  isJsonNullSentinel,
  JsonNull,
  type JsonNullKind,
  JsonNullSentinel,
} from "./json-null";
export * from "./model";
export { Model } from "./model";
export * from "./relation";
// Types
export type { NumberScalar, Scalar } from "./scalars";
// Export all from submodules
export * from "./scalars";
// Classes for advanced usage
export {
  BigIntScalar,
  BlobScalar,
  BooleanScalar,
  DateScalar,
  DateTimeScalar,
  DecimalScalar,
  EnumScalar,
  FloatScalar,
  IntScalar,
  JsonScalar,
  PointScalar,
  StringScalar,
  TimeScalar,
  VectorScalar,
} from "./scalars";
export * as TYPES from "./scalars/native-types";
export * from "./validation";

// =============================================================================
// TYPE INFERENCE EXPORTS
// =============================================================================

// Re-export core types from common
export type {
  AutoGenerate,
  AutoGenerateType,
  InferBaseType,
  InferCreateType,
  ScalarState as ScalarStateType,
} from "./scalars/common";

// =============================================================================
// FIELD TYPE MAPPING
// =============================================================================

/**
 * Maps a ScalarType string to its base TypeScript type
 */
export type ScalarTypeToTS<T extends import("./scalars/common").ScalarType> =
  T extends "string"
    ? string
    : T extends "int" | "float" | "decimal"
      ? number
      : T extends "boolean"
        ? boolean
        : T extends "datetime" | "date"
          ? Date
          : T extends "time"
            ? string
            : T extends "bigint"
              ? bigint
              : T extends "json"
                ? unknown
                : T extends "blob"
                  ? Uint8Array
                  : T extends "vector"
                    ? number[]
                    : T extends "enum"
                      ? string
                      : never;

/**
 * Infers the TypeScript type from a ScalarState
 * Handles nullable and array modifiers
 */
export type InferType<TState extends import("./scalars/common").ScalarState> =
  TState["array"] extends true
    ? TState["nullable"] extends true
      ? ScalarTypeToTS<TState["type"]>[] | null
      : ScalarTypeToTS<TState["type"]>[]
    : TState["nullable"] extends true
      ? ScalarTypeToTS<TState["type"]> | null
      : ScalarTypeToTS<TState["type"]>;

/**
 * Infers the input type for create operations (handles defaults)
 */
export type InferInputType<
  TState extends import("./scalars/common").ScalarState,
> = TState["hasDefault"] extends true
  ? InferType<TState> | undefined
  : TState["autoGenerate"] extends import("./scalars/common").AutoGenerate
    ? InferType<TState> | undefined
    : InferType<TState>;

/**
 * Infers the storage type (same as base type)
 */
export type InferStorageType<
  TState extends import("./scalars/common").ScalarState,
> = InferType<TState>;
