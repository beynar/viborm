// Relation Types
// Types for handling relation operations (create, update, where)

import type {
  FieldRecord,
  GetRelationFields,
  GetRelationType,
  GetRelationOptional,
} from "./helpers";
import type { ModelCreateInput, ModelUpdateInput, ModelWhereInput, ModelWhereUniqueInput } from "./input-types";

// =============================================================================
// TO-ONE CREATE INPUT
// =============================================================================

/**
 * Create input for a to-one relation (oneToOne, manyToOne)
 * Using interface for recursive type performance
 */
export interface ToOneCreateInput<T extends FieldRecord> {
  create?: ModelCreateInput<T>;
  connect?: ModelWhereUniqueInput<T>;
  connectOrCreate?: {
    where: ModelWhereUniqueInput<T>;
    create: ModelCreateInput<T>;
  };
}

// =============================================================================
// TO-MANY CREATE INPUT
// =============================================================================

/**
 * Create input for a to-many relation (oneToMany, manyToMany)
 * Using interface for recursive type performance
 */
export interface ToManyCreateInput<T extends FieldRecord> {
  create?: ModelCreateInput<T> | ModelCreateInput<T>[];
  connect?: ModelWhereUniqueInput<T> | ModelWhereUniqueInput<T>[];
  connectOrCreate?:
    | { where: ModelWhereUniqueInput<T>; create: ModelCreateInput<T> }
    | { where: ModelWhereUniqueInput<T>; create: ModelCreateInput<T> }[];
}

// =============================================================================
// TO-ONE UPDATE INPUT
// =============================================================================

/**
 * Update input for a REQUIRED to-one relation
 * Does NOT allow disconnect/delete (would violate constraint)
 * Using interface for recursive type performance
 */
export interface ToOneUpdateInputRequired<T extends FieldRecord> {
  create?: ModelCreateInput<T>;
  connect?: ModelWhereUniqueInput<T>;
  update?: ModelUpdateInput<T>;
  upsert?: {
    create: ModelCreateInput<T>;
    update: ModelUpdateInput<T>;
  };
}

/**
 * Update input for an OPTIONAL to-one relation
 * Allows disconnect/delete operations
 * Using interface for recursive type performance
 */
export interface ToOneUpdateInputOptional<T extends FieldRecord>
  extends ToOneUpdateInputRequired<T> {
  disconnect?: boolean;
  delete?: boolean;
}

/**
 * Update input for a to-one relation (selects based on optionality)
 */
export type ToOneUpdateInput<
  T extends FieldRecord,
  TOptional extends boolean = false
> = TOptional extends true
  ? ToOneUpdateInputOptional<T>
  : ToOneUpdateInputRequired<T>;

// =============================================================================
// TO-MANY UPDATE INPUT
// =============================================================================

/**
 * Update input for a to-many relation
 * Using interface for recursive type performance
 */
export interface ToManyUpdateInput<T extends FieldRecord> {
  create?: ModelCreateInput<T> | ModelCreateInput<T>[];
  connect?: ModelWhereUniqueInput<T> | ModelWhereUniqueInput<T>[];
  disconnect?: ModelWhereUniqueInput<T> | ModelWhereUniqueInput<T>[];
  set?: ModelWhereUniqueInput<T>[];
  delete?: ModelWhereUniqueInput<T> | ModelWhereUniqueInput<T>[];
  deleteMany?: ModelWhereInput<T> | ModelWhereInput<T>[];
  update?:
    | { where: ModelWhereUniqueInput<T>; data: ModelUpdateInput<T> }
    | { where: ModelWhereUniqueInput<T>; data: ModelUpdateInput<T> }[];
  updateMany?:
    | { where: ModelWhereInput<T>; data: ModelUpdateInput<T> }
    | { where: ModelWhereInput<T>; data: ModelUpdateInput<T> }[];
  upsert?:
    | {
        where: ModelWhereUniqueInput<T>;
        create: ModelCreateInput<T>;
        update: ModelUpdateInput<T>;
      }
    | {
        where: ModelWhereUniqueInput<T>;
        create: ModelCreateInput<T>;
        update: ModelUpdateInput<T>;
      }[];
}

// =============================================================================
// TO-ONE WHERE INPUT
// =============================================================================

/**
 * Explicit relation filter with is/isNot operators
 */
type ToOneExplicitFilter<
  T extends FieldRecord,
  TOptional extends boolean = false
> = TOptional extends true
  ? { is?: ModelWhereInput<T> | null; isNot?: ModelWhereInput<T> | null }
  : { is?: ModelWhereInput<T>; isNot?: ModelWhereInput<T> };

/**
 * Where filter for a to-one relation
 * Requires explicit is/isNot operators (no shorthand)
 * Optional relations allow null in is/isNot to filter for null values
 *
 * @example
 * // Use explicit is/isNot operators
 * where: { author: { is: { name: "Alice" } } }
 * where: { author: { isNot: { role: "admin" } } }
 */
export type ToOneWhereInput<
  T extends FieldRecord,
  TOptional extends boolean = false
> = ToOneExplicitFilter<T, TOptional>;

// =============================================================================
// TO-MANY WHERE INPUT
// =============================================================================

/**
 * Where filter for a to-many relation
 * Using interface for recursive type performance
 */
export interface ToManyWhereInput<T extends FieldRecord> {
  some?: ModelWhereInput<T>;
  every?: ModelWhereInput<T>;
  none?: ModelWhereInput<T>;
}

// =============================================================================
// RELATION INPUT DISPATCH TYPES
// =============================================================================

/**
 * Computes the create input type for a relation based on its type
 * Uses cached GetRelationFields for better TS performance
 * Non-distributive [X] extends [Y] prevents union member explosion
 */
export type RelationCreateInput<R> = [GetRelationType<R>] extends [
  "oneToOne" | "manyToOne"
]
  ? ToOneCreateInput<GetRelationFields<R>>
  : [GetRelationType<R>] extends ["oneToMany" | "manyToMany"]
  ? ToManyCreateInput<GetRelationFields<R>>
  : never;

/**
 * Computes the update input type for a relation based on its type and optionality
 * Uses cached GetRelationFields and GetRelationOptional for better TS performance
 * Non-distributive [X] extends [Y] prevents union member explosion
 */
export type RelationUpdateInput<R> = [GetRelationType<R>] extends [
  "oneToOne" | "manyToOne"
]
  ? ToOneUpdateInput<GetRelationFields<R>, GetRelationOptional<R>>
  : [GetRelationType<R>] extends ["oneToMany" | "manyToMany"]
  ? ToManyUpdateInput<GetRelationFields<R>>
  : never;

/**
 * Computes the where input type for a relation based on its type
 * Uses cached GetRelationFields and GetRelationOptional for better TS performance
 * Non-distributive [X] extends [Y] prevents union member explosion
 */
export type RelationWhereInput<R> = [GetRelationType<R>] extends [
  "oneToOne" | "manyToOne"
]
  ? ToOneWhereInput<GetRelationFields<R>, GetRelationOptional<R>>
  : [GetRelationType<R>] extends ["oneToMany" | "manyToMany"]
  ? ToManyWhereInput<GetRelationFields<R>>
  : never;

