// Schema Builder Entry Point
// Main API for defining models, scalars, and relations

import { model } from "./model";
import {
  manyToMany,
  manyToOne,
  oneToMany,
  oneToOne,
  polymorphic,
} from "./relation";
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
 * Relations use a chainable API:
 * - ToOne (oneToOne, manyToOne): .fields(), .references(), .optional(), .onDelete(), .onUpdate()
 * - ToMany (oneToMany): minimal config - just .name() if needed
 * - ManyToMany: .through(), .A(), .B(), .onDelete(), .onUpdate()
 *
 * @example
 * ```ts
 * import { s } from "viborm";
 *
 * const user = s.model({
 *   id: s.string().id().ulid(),
 *   name: s.string(),
 *   email: s.string().unique(),
 *   posts: s.oneToMany(() => post),
 *   profile: s.oneToOne(() => profile).optional(),
 * }).map("users");
 *
 * const post = s.model({
 *   id: s.string().id().ulid(),
 *   authorId: s.string(),
 *   author: s.manyToOne(() => user).fields("authorId").references("id"),
 * }).map("posts");
 * ```
 */
export const s = {
  // Model factory
  model,

  // Scalar factories
  string,
  boolean,
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

  // Relation builder (config-first, getter-last pattern)
  oneToOne,
  manyToOne,
  oneToMany,
  manyToMany,
  polymorphic,
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
export type { Getter, ReferentialAction, RelationType } from "./relation";
export * from "./relation";
export {
  type AnyRelation,
  type AnyPolymorphicRelation,
  ManyToManyRelation,
  PolymorphicRelation,
  ToManyRelation,
  ToOneRelation,
} from "./relation";
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
  : TState["autoGenerate"] extends import("./scalars/common").AutoGenerateType
    ? InferType<TState> | undefined
    : InferType<TState>;

/**
 * Infers the storage type (same as base type)
 */
export type InferStorageType<
  TState extends import("./scalars/common").ScalarState,
> = InferType<TState>;
