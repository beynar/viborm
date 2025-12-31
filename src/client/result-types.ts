/**
 * Result Types for ORM Client
 *
 * Provides type inference for operation results based on select/include args.
 * Works directly with ModelState for full type context (including omit settings).
 */

import { Field, FieldState, ScalarFieldType } from "@schema/fields";
import { Model, ModelState } from "@schema/model";
import { AnyRelation } from "@schema/relation";
import { Simplify, InferOutput } from "../validation";
import { FieldRecord } from "@schema/model/helper";
import { StandardSchemaV1 } from "@standard-schema/spec";

// =============================================================================
// SCALAR OUTPUT TYPE MAPPING
// =============================================================================

/**
 * Maps scalar field types to their DATABASE RESULT types.
 * This is what the ORM returns after querying the database.
 *
 * Key difference from validation schema output:
 * - datetime/date/time: returns Date (not ISO string)
 * - json: inferred from custom schema if present, otherwise unknown
 * - enum: inferred from schema values
 */
type ScalarResultTypeMap = {
  string: string;
  int: number;
  float: number;
  decimal: number;
  boolean: boolean;
  datetime: Date; // Database results are Date objects, not ISO strings
  date: Date;
  time: Date;
  bigint: bigint;
  json: unknown;
  blob: Uint8Array;
  vector: number[];
  point: { x: number; y: number };
  enum: string;
};

/**
 * Extract the FieldState from a Field using infer to preserve literal types.
 */
type ExtractFieldState<F> = F extends { "~": { state: infer S } }
  ? S extends FieldState
    ? S
    : never
  : never;

/**
 * Get the base scalar type for a field, handling custom schemas.
 * For json/enum fields with custom schemas, infer from the schema.
 * For datetime fields, always return Date (regardless of validation schema output).
 */
type GetScalarResultType<F extends Field> = ExtractFieldState<F> extends infer S
  ? S extends FieldState
    ? S["type"] extends "json"
      ? S["schema"] extends StandardSchemaV1<any, infer O>
        ? O
        : unknown
      : S["type"] extends "enum"
      ? S["schema"] extends StandardSchemaV1<any, infer O>
        ? O
        : string
      : S["type"] extends keyof ScalarResultTypeMap
      ? ScalarResultTypeMap[S["type"]]
      : unknown
    : unknown
  : unknown;

/**
 * Apply nullable wrapper based on field state.
 * Uses non-distributive check to handle boolean literals correctly.
 */
type ApplyNullable<T, Nullable> = [Nullable] extends [true] ? T | null : T;

/**
 * Apply array wrapper based on field state.
 * Uses non-distributive check to handle boolean literals correctly.
 */
type ApplyArray<T, IsArray> = [IsArray] extends [true] ? T[] : T;

/**
 * Infer the DATABASE RESULT type for a scalar field.
 *
 * This is the canonical helper for inferring output types from fields.
 * It correctly handles:
 * - All scalar types with proper DB result mapping (datetime → Date)
 * - Custom schemas for json/enum fields
 * - Nullable fields
 * - Array fields
 *
 * @example
 * // For s.dateTime().nullable() → Date | null
 * // For s.string().array() → string[]
 * // For s.json().schema(z.object({...})) → { ... }
 */
export type InferScalarOutput<F extends Field> =
  ExtractFieldState<F> extends infer S
    ? S extends FieldState
      ? ApplyArray<
          ApplyNullable<GetScalarResultType<F>, S["nullable"]>,
          S["array"]
        >
      : never
    : never;

// =============================================================================
// BATCH PAYLOAD
// =============================================================================

/**
 * Result for batch operations (createMany, updateMany, deleteMany)
 */
export interface BatchPayload {
  count: number;
}

// =============================================================================
// COUNT RESULT
// =============================================================================

/**
 * Result type for count operations
 * Supports select for per-field counts like Prisma: count({ select: { _all: true, name: true } })
 */
export type CountResultType<Args> = Args extends { select: infer S }
  ? Simplify<{ [K in keyof S as S[K] extends true ? K : never]: number }>
  : number;

// =============================================================================
// MODEL STATE HELPERS
// =============================================================================

/**
 * Get the target model's state from a relation
 */
export type GetTargetModelState<R extends AnyRelation> =
  R["~"]["state"]["getter"] extends () => infer T
    ? T extends Model<infer S>
      ? S extends ModelState
        ? S
        : never
      : never
    : never;

/**
 * Infer the output type for a model, respecting omit settings.
 * Uses InferScalarOutput for correct DB result types (e.g., Date for datetime).
 */
export type InferModelOutput<S extends ModelState> = S["omit"] extends Record<
  string,
  true
>
  ? Omit<
      {
        [K in keyof S["scalars"]]: S["scalars"][K] extends Field
          ? InferScalarOutput<S["scalars"][K]>
          : never;
      },
      keyof S["omit"]
    >
  : {
      [K in keyof S["scalars"]]: S["scalars"][K] extends Field
        ? InferScalarOutput<S["scalars"][K]>
        : never;
    };

/**
 * Get relation type (oneToMany, manyToMany, oneToOne, manyToOne)
 */
export type GetRelationType<R extends AnyRelation> = R["~"]["state"]["type"];

/**
 * Check if a relation is optional
 */
export type GetRelationOptional<R extends AnyRelation> =
  R["~"]["state"]["optional"];

// =============================================================================
// RELATION RESULT
// =============================================================================

/**
 * Result for a relation when included
 * - To-many relations return arrays
 * - To-one relations return single objects (nullable if optional)
 */
export type InferRelationResult<R extends AnyRelation> = [
  GetRelationType<R>
] extends ["oneToMany" | "manyToMany"]
  ? InferModelOutput<GetTargetModelState<R>>[]
  : [GetRelationOptional<R>] extends [true]
  ? InferModelOutput<GetTargetModelState<R>> | null
  : InferModelOutput<GetTargetModelState<R>>;

// =============================================================================
// SELECT/INCLUDE RESULT INFERENCE
// =============================================================================

/**
 * Infer result from select/include args
 * - select: ONLY returns selected fields
 * - include: returns base model + included relations
 * - neither: returns base model output
 */
export type InferSelectInclude<S extends ModelState, Args> = Args extends {
  select: infer Selection;
}
  ? InferSelectResult<S, Selection>
  : Args extends { include: infer Include }
  ? InferIncludeResult<S, Include>
  : InferModelOutput<S>;

/**
 * Result when select is provided - ONLY selected fields are returned
 */
export type InferSelectResult<S extends ModelState, Selection> = Simplify<{
  [K in keyof Selection & keyof S["fields"] as Selection[K] extends
    | true
    | object
    ? K
    : never]: S["fields"][K] extends Field
    ? InferScalarOutput<S["fields"][K]>
    : S["fields"][K] extends AnyRelation
    ? Selection[K] extends true
      ? InferRelationResult<S["fields"][K]>
      : Selection[K] extends { select: infer NS }
      ? InferNestedSelectResult<S["fields"][K], NS>
      : Selection[K] extends { include: infer NI }
      ? InferNestedIncludeResult<S["fields"][K], NI>
      : Selection[K] extends object
      ? // Other object shapes (where, take, skip) - return base relation result
        InferRelationResult<S["fields"][K]>
      : never
    : never;
}>;

/**
 * Result when include is provided - base result + included relations
 */
export type InferIncludeResult<S extends ModelState, Include> = Simplify<
  InferModelOutput<S> & {
    [K in keyof Include & keyof S["relations"] as Include[K] extends
      | true
      | object
      ? K
      : never]: S["relations"][K] extends AnyRelation
      ? Include[K] extends true
        ? InferRelationResult<S["relations"][K]>
        : Include[K] extends { select: infer NS }
        ? InferNestedSelectResult<S["relations"][K], NS>
        : Include[K] extends { include: infer NI }
        ? InferNestedIncludeResult<S["relations"][K], NI>
        : Include[K] extends object
        ? // Other object shapes (where, take, skip) - return base relation result
          InferRelationResult<S["relations"][K]>
        : never
      : never;
  }
>;

/**
 * Nested select result for a relation
 */
export type InferNestedSelectResult<R extends AnyRelation, NS> = [
  GetRelationType<R>
] extends ["oneToMany" | "manyToMany"]
  ? InferSelectResult<GetTargetModelState<R>, NS>[]
  : [GetRelationOptional<R>] extends [true]
  ? InferSelectResult<GetTargetModelState<R>, NS> | null
  : InferSelectResult<GetTargetModelState<R>, NS>;

/**
 * Nested include result for a relation
 */
export type InferNestedIncludeResult<R extends AnyRelation, NI> = [
  GetRelationType<R>
] extends ["oneToMany" | "manyToMany"]
  ? InferIncludeResult<GetTargetModelState<R>, NI>[]
  : [GetRelationOptional<R>] extends [true]
  ? InferIncludeResult<GetTargetModelState<R>, NI> | null
  : InferIncludeResult<GetTargetModelState<R>, NI>;

// =============================================================================
// AGGREGATE RESULT TYPES
// =============================================================================

/**
 * Extract scalar field keys from a FieldRecord
 */
type ScalarFieldKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends Field ? K : never;
}[keyof T];

/**
 * Infer base type from a field for aggregates.
 * Uses InferScalarOutput for correct DB result types.
 */
type InferFieldBase<F> = F extends Field ? InferScalarOutput<F> : never;

/**
 * Result type for aggregate operations
 * Dynamically typed based on which aggregates are requested
 */
export type AggregateResultType<T extends FieldRecord, Args> = Simplify<{
  [K in keyof Args as K extends `_${string}` ? K : never]: K extends "_count"
    ? Args[K] extends true
      ? number
      : Args[K] extends object
      ? { [F in keyof Args[K]]: number }
      : never
    : K extends "_avg" | "_sum"
    ? Args[K] extends object
      ? { [F in keyof Args[K]]: number | null }
      : never
    : K extends "_min" | "_max"
    ? Args[K] extends object
      ? {
          [F in keyof Args[K]]: F extends ScalarFieldKeys<T>
            ? InferFieldBase<T[F]> | null
            : never;
        }
      : never
    : never;
}>;

// =============================================================================
// GROUPBY RESULT TYPES
// =============================================================================

/**
 * Result type for groupBy operations
 * Includes the grouped-by fields plus any requested aggregates
 */
export type GroupByResultType<T extends FieldRecord, Args> = Args extends {
  by: infer B;
}
  ? Simplify<
      // Grouped-by fields
      (B extends readonly (infer K)[]
        ? K extends ScalarFieldKeys<T> & keyof T
          ? { [F in K]: InferFieldBase<T[F]> }
          : never
        : B extends ScalarFieldKeys<T> & keyof T
        ? { [F in B]: InferFieldBase<T[F]> }
        : never) &
        // Aggregate fields
        AggregateResultType<T, Args>
    >
  : never;
