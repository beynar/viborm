// Schema Builder Entry Point
// Main API for defining models, fields, and relations

import {
  bigInt,
  blob,
  boolean,
  date,
  dateTime,
  decimal,
  enumField,
  float,
  int,
  json,
  string,
  time,
  vector,
} from "./fields";
import { model } from "./model";
import { manyToMany, manyToOne, oneToMany, oneToOne } from "./relation";

// =============================================================================
// SCHEMA BUILDER API
// =============================================================================

/**
 * Main schema builder object
 * Use this to define models, fields, and relations
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

  // Scalar field factories
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

// Types
export type { Field, NumberField } from "./fields";
// Export all from submodules
export * from "./fields";
// Classes for advanced usage
export {
  BigIntField,
  BlobField,
  BooleanField,
  DateField,
  DateTimeField,
  DecimalField,
  EnumField,
  FloatField,
  IntField,
  JsonField,
  StringField,
  TimeField,
  VectorField,
} from "./fields";
export * as TYPES from "./fields/native-types";
// Hydration exports (excluding Schema type which conflicts with validation)
export {
  getFieldSqlName,
  getModelSqlName,
  hydrateSchemaNames,
  isSchemaHydrated,
} from "./hydration";
export * from "./model";
export { Model } from "./model";
export type { Getter, ReferentialAction, RelationType } from "./relation";
export * from "./relation";
export {
  type AnyRelation,
  ManyToManyRelation,
  ToManyRelation,
  ToOneRelation,
} from "./relation";
export * from "./validation";

// =============================================================================
// TYPE INFERENCE EXPORTS
// =============================================================================

// Re-export core types from common
export type {
  AutoGenerateType,
  FieldState as FieldStateType,
  InferBaseType,
  InferCreateType,
} from "./fields/common";

// =============================================================================
// FIELD TYPE MAPPING
// =============================================================================

/**
 * Maps a ScalarFieldType string to its base TypeScript type
 */
export type ScalarTypeToTS<
  T extends import("./fields/common").ScalarFieldType,
> = T extends "string"
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
  TState extends import("./fields/common").FieldState,
> = TState["hasDefault"] extends true
  ? InferType<TState> | undefined
  : TState["autoGenerate"] extends import("./fields/common").AutoGenerateType
    ? InferType<TState> | undefined
    : InferType<TState>;

/**
 * Infers the storage type (same as base type)
 */
export type InferStorageType<
  TState extends import("./fields/common").FieldState,
> = InferType<TState>;
