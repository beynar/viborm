// Schema Builder Entry Point
// Main API for defining models, fields, and relations

import { model, Model } from "./model";
import {
  StringField,
  IntField,
  FloatField,
  DecimalField,
  BooleanField,
  BigIntField,
  DateTimeField,
  JsonField,
  BlobField,
  EnumField,
  VectorField,
  type Field,
  string,
  int,
  float,
  decimal,
  boolean,
  bigInt,
  dateTime,
  json,
  blob,
  enumField,
  vector,
} from "./fields";
import {
  Relation,
  oneToOne,
  manyToOne,
  oneToMany,
  manyToMany,
  type Getter,
} from "./relation";

// =============================================================================
// SCHEMA BUILDER API
// =============================================================================

/**
 * Main schema builder object
 * Use this to define models, fields, and relations
 *
 * Relations use a builder pattern with config-first, getter-last:
 * s.relation.fields("authorId").references("id").manyToOne(() => user)
 *
 * This pattern avoids TypeScript circular reference issues because:
 * 1. Config methods (fields, references, etc.) return `this` - no generics
 * 2. Terminal methods (oneToOne, manyToOne, etc.) introduce the generic LAST
 * 3. No more chaining after terminal = no need to resolve generic for method lookup
 *
 * @example
 * ```ts
 * import { s } from "viborm";
 *
 * const user = s.model({
 *   id: s.string().id().ulid(),
 *   name: s.string(),
 *   email: s.string().unique(),
 *   posts: s.relation.oneToMany(() => post),
 *   profile: s.relation.optional().oneToOne(() => profile),
 * }).map("users");
 *
 * const post = s.model({
 *   id: s.string().id().ulid(),
 *   authorId: s.string(),
 *   author: s.relation.fields("authorId").references("id").manyToOne(() => user),
 * }).map("posts");
 * ```
 */
export const s = {
  // Model factory
  model,

  // Scalar field factories
  string,
  boolean,
  int,
  float,
  decimal,
  bigInt,
  dateTime,
  json,
  blob,
  enum: enumField,
  vector,

  // Relation builder (config-first, getter-last pattern)
  oneToOne,
  manyToOne,
  oneToMany,
  manyToMany,
};

// =============================================================================
// RE-EXPORTS
// =============================================================================

// Classes for advanced usage
export {
  Model,
  StringField,
  IntField,
  FloatField,
  DecimalField,
  BooleanField,
  BigIntField,
  DateTimeField,
  JsonField,
  BlobField,
  EnumField,
  VectorField,
  Relation,
};

export type { NumberField } from "./fields";

// Types
export type { Field, Getter };

// Export all from submodules
export * from "./fields";
export * from "./model";
export * from "./relation";
export * from "./validation";
// Hydration exports (excluding Schema type which conflicts with validation)
export {
  hydrateSchemaNames,
  isSchemaHydrated,
  getModelSqlName,
  getFieldSqlName,
} from "./hydration";
export * as TYPES from "./fields/native-types";

// =============================================================================
// TYPE INFERENCE EXPORTS
// =============================================================================

// Re-export core types from common
export type {
  InferBaseType,
  InferCreateType,
  AutoGenerateType,
  FieldState as FieldStateType,
} from "./fields/common";

// =============================================================================
// FIELD TYPE MAPPING
// =============================================================================

/**
 * Maps a ScalarFieldType string to its base TypeScript type
 */
export type ScalarTypeToTS<
  T extends import("./fields/common").ScalarFieldType
> = T extends "string"
  ? string
  : T extends "int" | "float" | "decimal"
  ? number
  : T extends "boolean"
  ? boolean
  : T extends "datetime"
  ? Date
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
 * Infers the TypeScript type from a FieldState
 * Handles nullable and array modifiers
 */
export type InferType<TState extends import("./fields/common").FieldState> =
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
  TState extends import("./fields/common").FieldState
> = TState["hasDefault"] extends true
  ? InferType<TState> | undefined
  : TState["autoGenerate"] extends import("./fields/common").AutoGenerateType
  ? InferType<TState> | undefined
  : InferType<TState>;

/**
 * Infers the storage type (same as base type)
 */
export type InferStorageType<
  TState extends import("./fields/common").FieldState
> = InferType<TState>;
