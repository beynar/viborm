// Type Helpers for TypeScript Performance Optimization
// Consolidates shared types and caches conditional type computations
// IMPORTANT: Does NOT use ArkType's .infer to avoid deep type inference

import type { Field, FieldState } from "../../fields/base";
import type {
  Relation,
  RelationState,
  RelationType,
} from "../../relation/relation";
import type { StandardSchemaV1 } from "../../../standardSchema";
import type { AnyRelation } from "../../relation/relation";

// =============================================================================
// CONSTRAINT HELPER - Replace verbose Record<string, Field | AnyRelation>
// =============================================================================

/**
 * Simplified constraint for model fields.
 * Supports:
 * - Field: scalar field definitions (s.string(), s.int(), etc.)
 * - AnyRelation: relation instances from s.relation builder
 */
export type FieldRecord = Record<string, Field | AnyRelation>;

// =============================================================================
// COMPOUND CONSTRAINT TYPES
// =============================================================================

/**
 * Represents a compound constraint (ID or unique) with fields and optional name.
 * The name is used for WhereUnique input keys; if undefined, auto-generated from fields.
 */
export interface CompoundConstraint<
  TFields extends readonly string[] = readonly string[],
  TName extends string | undefined = undefined
> {
  fields: TFields;
  name: TName;
}

/** Any compound constraint (for loose typing) */
export type AnyCompoundConstraint = CompoundConstraint<any, any>;

// =============================================================================
// MODEL STATE TYPES (for single-generic Model pattern)
// =============================================================================

/**
 * Consolidated state interface for Model.
 * Using a single State generic makes the API future-proof:
 * - Adding new state properties won't break `Model<any>` usages
 * - Consistent pattern with field classes
 */
export interface ModelState<
  TFields extends FieldRecord = FieldRecord,
  TCompoundId extends AnyCompoundConstraint | undefined = undefined,
  TCompoundUniques extends readonly AnyCompoundConstraint[] = []
> {
  fields: TFields;
  compoundId: TCompoundId;
  compoundUniques: TCompoundUniques;
}

/** Default state for new models (no compound ID or uniques) */
export type DefaultModelState<TFields extends FieldRecord> = ModelState<
  TFields,
  undefined,
  []
>;

/** Any valid model state (for loose typing) */
export type AnyModelState = ModelState<any, any, any>;

// =============================================================================
// MODEL STATE EXTRACTION HELPERS
// =============================================================================

// Import Model for type extraction
import type { Model } from "../model";

/**
 * Extract field definitions from any Model
 * Works correctly with Model<any>
 */
export type ExtractFields<M> = M extends Model<infer S>
  ? S extends AnyModelState
    ? S["fields"]
    : never
  : never;

/**
 * Extract compound ID from any Model
 */
export type ExtractCompoundId<M> = M extends Model<infer S>
  ? S extends AnyModelState
    ? S["compoundId"]
    : never
  : never;

/**
 * Extract compound uniques from any Model
 */
export type ExtractCompoundUniques<M> = M extends Model<infer S>
  ? S extends AnyModelState
    ? S["compoundUniques"]
    : never
  : never;

// =============================================================================
// COMPOUND KEY TYPES
// =============================================================================

/**
 * Generates the compound key name from field names
 * e.g., ["email", "username"] -> "email_username"
 */
export type CompoundKeyName<T extends readonly string[]> = T extends readonly [
  infer F extends string,
  ...infer R extends string[]
]
  ? R extends []
    ? F
    : `${F}_${CompoundKeyName<R>}`
  : never;

/**
 * Gets the effective key name for a compound constraint.
 * Uses custom name if provided, otherwise auto-generates from field names.
 */
export type EffectiveKeyName<C extends CompoundConstraint> =
  C["name"] extends string ? C["name"] : CompoundKeyName<C["fields"]>;

// =============================================================================
// SCALAR TYPE MAPPING
// Maps FieldState.type to actual TypeScript types
// This avoids using ArkType's .infer which causes deep type inference
// =============================================================================

/**
 * Maps scalar field type strings to their TypeScript types for RESULTS
 * This is what you get back from the database
 */
type ScalarResultTypeMap = {
  string: string;
  int: number;
  float: number;
  decimal: number;
  boolean: boolean;
  datetime: Date; // Results are always Date objects
  bigint: bigint;
  json: unknown;
  blob: Uint8Array;
  vector: number[];
  enum: string;
};

/**
 * Maps scalar field type strings to their TypeScript types for INPUTS
 * This is what you can pass to queries (filters, creates, updates)
 */
type ScalarInputTypeMap = {
  string: string;
  int: number;
  float: number;
  decimal: number;
  boolean: boolean;
  datetime: Date | string; // Inputs accept both Date objects and ISO strings
  bigint: bigint;
  json: unknown;
  blob: Uint8Array;
  vector: number[];
  enum: string;
};

/**
 * Applies nullable wrapper based on field state
 * Uses non-distributive guard to handle boolean literals correctly
 */
type ApplyNullable<T, Nullable> = [Nullable] extends [true] ? T | null : T;

/**
 * Applies array wrapper based on field state
 * Uses non-distributive guard to handle boolean literals correctly
 */
type ApplyArray<T, IsArray> = [IsArray] extends [true] ? T[] : T;

// =============================================================================
// CACHED FIELD EXTRACTORS (compute once, reuse)
// =============================================================================

/** Extracts scalar field keys */
export type ScalarFieldKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends Field ? K : never;
}[keyof T];

/** Extracts relation keys */
export type RelationKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends AnyRelation ? K : never;
}[keyof T];

/** Extracts numeric field keys */
export type NumericFieldKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends Field
    ? T[K]["~"]["state"]["type"] extends "int" | "float" | "decimal" | "bigint"
      ? K
      : never
    : never;
}[keyof T];

/** Extracts unique/id field keys */
export type UniqueFieldKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends Field
    ? T[K]["~"]["state"]["isId"] extends true
      ? K
      : T[K]["~"]["state"]["isUnique"] extends true
      ? K
      : never
    : never;
}[keyof T];

/** Extracts field keys that are optional in create (hasDefault, autoGenerate, or nullable) */
export type OptionalCreateFieldKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends Field
    ? T[K]["~"]["state"]["hasDefault"] extends true
      ? K
      : T[K]["~"]["state"]["autoGenerate"] extends undefined
      ? T[K]["~"]["state"]["nullable"] extends true
        ? K // nullable fields are optional (default to null)
        : never
      : K
    : never;
}[keyof T];

/** Extracts field keys that are required in create (not optional) */
export type RequiredCreateFieldKeys<T extends FieldRecord> = Exclude<
  ScalarFieldKeys<T>,
  OptionalCreateFieldKeys<T>
>;

/** Extracts array field keys */
export type ArrayFieldKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends Field
    ? T[K]["~"]["state"]["array"] extends true
      ? K
      : never
    : never;
}[keyof T];

// =============================================================================
// CACHED RELATION EXTRACTORS (avoid deep nesting)
// Uses non-distributive [R] extends [X] to prevent union member explosion
// =============================================================================

/** Step 1: Extract getter from relation (non-distributive) */
export type RelationGetter<R> = [R] extends [Relation<infer G, any, any>]
  ? G
  : never;

/** Step 2: Extract model state from getter (non-distributive) */
export type GetterModelState<G> = [G] extends [() => Model<infer S>]
  ? S
  : never;

/** Step 3: Extract fields from model state - ensures FieldRecord constraint */
export type GetterModelFields<G> = GetterModelState<G> extends {
  fields: infer F;
}
  ? F extends FieldRecord
    ? F
    : FieldRecord
  : FieldRecord;

/** Combined: Get target fields (uses cached intermediates) */
export type GetRelationFields<R extends AnyRelation> = GetterModelFields<
  RelationGetter<R>
>;

/** Extract relation type (non-distributive) */
export type GetRelationType<R> = [R] extends [
  Relation<any, any, infer T extends RelationType>
]
  ? T
  : never;

/** Extract relation optionality (non-distributive) */
export type GetRelationOptional<R> = [R] extends [
  Relation<any, infer State extends RelationState, any>
]
  ? State["optional"] extends true
    ? true
    : false
  : false;

// =============================================================================
// FIELD INFERENCE (without ArkType - uses state directly)
// =============================================================================

/**
 * Extracts the state type from a field using infer to preserve literal types.
 * This is the key to avoiding type widening - we infer the actual state type
 * rather than relying on the Field constraint which widens to FieldState.
 */
type ExtractFieldState<F> = F extends { "~": { state: infer S } }
  ? S extends FieldState
    ? S
    : never
  : never;

/**
 * Extracts the scalar TypeScript type from a field state for RESULTS
 * For non-JSON fields, uses the type map
 */
type StateToResultType<S extends FieldState> =
  S["type"] extends keyof ScalarResultTypeMap
    ? ScalarResultTypeMap[S["type"]]
    : unknown;

/**
 * Extracts the scalar TypeScript type from a field state for INPUTS
 * For non-JSON fields, uses the type map
 */
type StateToInputType<S extends FieldState> =
  S["type"] extends keyof ScalarInputTypeMap
    ? ScalarInputTypeMap[S["type"]]
    : unknown;

/**
 * Extracts the JSON schema type from a field if it has one
 * Returns the inferred output type from StandardSchemaV1
 */
type ExtractJsonSchemaType<F> = F extends { "~": { customSchema: infer CS } }
  ? CS extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<CS>
    : unknown
  : unknown;

/**
 * Gets the base type for a field, handling JSON fields with custom schemas
 */
type GetFieldResultType<F, S extends FieldState> = [S["type"]] extends ["json"]
  ? ExtractJsonSchemaType<F>
  : StateToResultType<S>;

/**
 * Gets the input type for a field, handling JSON fields with custom schemas
 */
type GetFieldInputType<F, S extends FieldState> = [S["type"]] extends ["json"]
  ? ExtractJsonSchemaType<F>
  : StateToInputType<S>;

/**
 * Infers the RESULT TypeScript type for a field (what you get back from DB)
 * Uses state-based type mapping instead of ArkType inference
 * Key: Uses infer to extract the actual state type, preserving literal types
 * For JSON fields with custom schemas, infers from StandardSchemaV1
 */
export type InferFieldBase<F> = F extends Field
  ? ExtractFieldState<F> extends infer S
    ? S extends FieldState
      ? ApplyArray<
          ApplyNullable<GetFieldResultType<F, S>, S["nullable"]>,
          S["array"]
        >
      : unknown
    : unknown
  : unknown;

/**
 * Infers the INPUT TypeScript type for a field (what you can pass to queries)
 * Allows Date | string for datetime fields
 * For JSON fields with custom schemas, infers from StandardSchemaV1
 */
export type InferFieldInput<F> = F extends Field
  ? ExtractFieldState<F> extends infer S
    ? S extends FieldState
      ? ApplyArray<
          ApplyNullable<GetFieldInputType<F, S>, S["nullable"]>,
          S["array"]
        >
      : unknown
    : unknown
  : unknown;

/**
 * Infers the create input type for a field
 * Fields with defaults or auto-generate are optional
 */
export type InferFieldCreate<F> = F extends Field
  ? ExtractFieldState<F> extends infer S
    ? S extends FieldState
      ? [S["hasDefault"]] extends [true]
        ? InferFieldInput<F> | undefined
        : [S["autoGenerate"]] extends [undefined]
        ? InferFieldInput<F>
        : InferFieldInput<F> | undefined
      : unknown
    : unknown
  : unknown;

/**
 * Infers the filter type for a field
 * Returns the input type or filter object
 * Note: This is simplified - full filter types are complex
 */
export type InferFieldFilter<F> = F extends Field
  ? InferFieldInput<F> | FieldFilterObject<InferFieldInput<F>>
  : unknown;

/**
 * Infers the update input type for a field
 * Updates are always optional and can include operations
 */
export type InferFieldUpdate<F> = F extends Field
  ? ExtractFieldState<F> extends infer S
    ? S extends FieldState
      ? InferFieldInput<F> | FieldUpdateObjectFromState<S, InferFieldInput<F>>
      : unknown
    : unknown
  : unknown;

// =============================================================================
// FILTER & UPDATE OBJECT TYPES
// =============================================================================

/**
 * Generic filter object for comparable types
 */
interface FieldFilterObject<T> {
  equals?: T;
  not?: T | null | FieldFilterObject<T>;
  in?: T[];
  notIn?: T[];
  lt?: T;
  lte?: T;
  gt?: T;
  gte?: T;
  contains?: T extends string ? string : never;
  startsWith?: T extends string ? string : never;
  endsWith?: T extends string ? string : never;
  mode?: T extends string ? "default" | "insensitive" : never;
  // Array filters
  has?: T extends (infer U)[] ? U : never;
  hasEvery?: T extends (infer U)[] ? U[] : never;
  hasSome?: T extends (infer U)[] ? U[] : never;
  isEmpty?: T extends unknown[] ? boolean : never;
}

/**
 * Generic update object for fields
 * Uses state type to determine available operations
 */
type FieldUpdateObjectFromState<S extends FieldState, BaseType> = [
  S["array"]
] extends [true]
  ? // Array field updates
    {
      set?: BaseType;
      push?: BaseType extends (infer U)[] ? U | U[] : never;
      unshift?: BaseType extends (infer U)[] ? U | U[] : never;
    }
  : [S["type"]] extends ["int" | "float" | "decimal"]
  ? // Numeric field updates
    {
      set?: BaseType;
      increment?: number;
      decrement?: number;
      multiply?: number;
      divide?: number;
    }
  : // Default field updates
    { set?: BaseType };
