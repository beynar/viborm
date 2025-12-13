// Result Types
// Operation result types for queries and mutations

import type { Field } from "../../fields/base";
import type { AnyRelation, Relation } from "../../relation/relation";
import type { Simplify } from "./base-types";
import type {
  FieldRecord,
  ScalarFieldKeys,
  RelationKeys,
  InferFieldBase,
  GetRelationFields,
  GetRelationType,
  GetRelationOptional,
} from "./helpers";

// =============================================================================
// BASE MODEL RESULT
// =============================================================================

/**
 * Default result for a model - all scalar fields
 * This is what you get when no select/include is provided
 */
export type ModelBaseResult<T extends FieldRecord> = Simplify<{
  [K in ScalarFieldKeys<T>]: InferFieldBase<T[K]>;
}>;

// =============================================================================
// RELATION RESULT TYPES
// =============================================================================

/**
 * Result type for a relation
 * To-many relations return arrays, to-one relations return single objects (nullable if optional)
 */
export type RelationResult<R extends AnyRelation> = [
  GetRelationType<R>
] extends ["oneToMany" | "manyToMany"]
  ? ModelBaseResult<GetRelationFields<R>>[]
  : [GetRelationOptional<R>] extends [true]
  ? ModelBaseResult<GetRelationFields<R>> | null
  : ModelBaseResult<GetRelationFields<R>>;

/**
 * Result type for a relation when explicitly included
 * Same logic as RelationResult but clearer naming
 */
export type IncludedRelationResult<R> = RelationResult<R>;

// =============================================================================
// SELECT RESULT
// =============================================================================

/**
 * Result when select is provided - only selected fields are returned
 * Handles both scalar fields and relations
 * Supports nested select AND nested include inside relation objects
 */
export type SelectResult<T extends FieldRecord, S> = Simplify<{
  [K in keyof S & keyof T as S[K] extends true | object
    ? K
    : never]: T[K] extends Field
    ? InferFieldBase<T[K]>
    : T[K] extends AnyRelation
    ? S[K] extends true
      ? RelationResult<T[K]>
      : S[K] extends { select: infer NS }
      ? // Nested select on relation
        SelectResult<GetRelationFields<T[K]>, NS> extends infer R
        ? [GetRelationType<T[K]>] extends ["oneToMany" | "manyToMany"]
          ? R[]
          : [GetRelationOptional<T[K]>] extends [true]
          ? R | null
          : R
        : never
      : S[K] extends { include: infer NI }
      ? // Nested include on relation - use IncludeResult
        IncludeResult<GetRelationFields<T[K]>, NI> extends infer R
        ? [GetRelationType<T[K]>] extends ["oneToMany" | "manyToMany"]
          ? R[]
          : [GetRelationOptional<T[K]>] extends [true]
          ? R | null
          : R
        : never
      : S[K] extends object
      ? // Other object shapes (where, take, skip) - return base relation result
        RelationResult<T[K]>
      : never
    : never;
}>;

// =============================================================================
// INCLUDE RESULT
// =============================================================================

/**
 * Result when include is provided - base result + included relations
 * Handles nested select and nested include inside the include object
 */
export type IncludeResult<T extends FieldRecord, I> = Simplify<
  ModelBaseResult<T> & {
    [K in keyof I & RelationKeys<T> as I[K] extends true | object
      ? K
      : never]: T[K] extends AnyRelation
      ? I[K] extends true
        ? RelationResult<T[K]>
        : I[K] extends { select: infer NS }
        ? // Nested select on relation - use SelectResult
          SelectResult<GetRelationFields<T[K]>, NS> extends infer R
          ? [GetRelationType<T[K]>] extends ["oneToMany" | "manyToMany"]
            ? R[]
            : R | null
          : never
        : I[K] extends { include: infer NI }
        ? // Nested include on relation - use IncludeResult
          IncludeResult<GetRelationFields<T[K]>, NI> extends infer R
          ? [GetRelationType<T[K]>] extends ["oneToMany" | "manyToMany"]
            ? R[]
            : R | null
          : never
        : // Other object shapes (e.g., where, take, skip) - return base relation result
          RelationResult<T[K]>
      : never;
  }
>;

// =============================================================================
// INFER RESULT (DISPATCH)
// =============================================================================

/**
 * Infer the result type based on the operation args
 * - If select is provided, return SelectResult
 * - If include is provided, return IncludeResult
 * - Otherwise, return ModelBaseResult
 */
export type InferResult<T extends FieldRecord, Args> = Args extends {
  select: infer S;
}
  ? SelectResult<T, S>
  : Args extends { include: infer I }
  ? IncludeResult<T, I>
  : ModelBaseResult<T>;

// =============================================================================
// BATCH RESULT
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
// AGGREGATE RESULT TYPES
// =============================================================================

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
