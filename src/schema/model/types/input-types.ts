// Input Types
// Model-level input types for queries and mutations

import type { Field } from "../../fields/base";
import type { Relation } from "../../relation/relation";
import type { Simplify, AtLeast, SortOrderInput } from "./base-types";
import type {
  FieldRecord,
  ScalarFieldKeys,
  UniqueFieldKeys,
  NumericFieldKeys,
  RequiredCreateFieldKeys,
  OptionalCreateFieldKeys,
  InferFieldBase,
  InferFieldInput,
  InferFieldCreate,
  InferFieldFilter,
  InferFieldUpdate,
} from "./helpers";
import type {
  RelationCreateInput,
  RelationUpdateInput,
  RelationWhereInput,
} from "./relation-types";

// =============================================================================
// CREATE INPUT TYPES
// =============================================================================

/**
 * Required scalar fields for create input (no default, no auto-generate)
 */
type RequiredScalarCreateFields<T extends FieldRecord> = {
  [K in RequiredCreateFieldKeys<T>]: InferFieldInput<T[K]>;
};

/**
 * Optional scalar fields for create input (has default or auto-generate)
 */
type OptionalScalarCreateFields<T extends FieldRecord> = {
  [K in OptionalCreateFieldKeys<T>]?: InferFieldInput<T[K]>;
};

/**
 * Combined scalar create fields (required + optional)
 */
type ScalarCreateFields<T extends FieldRecord> = RequiredScalarCreateFields<T> &
  OptionalScalarCreateFields<T>;

/**
 * Relation fields for create input (always optional)
 */
type RelationCreateFields<T extends FieldRecord> = {
  [K in keyof T as T[K] extends Relation<any, any, any>
    ? K
    : never]?: RelationCreateInput<T[K]>;
};

/**
 * Computes the create input type for a model (fields + relations)
 * Uses Simplify to flatten intersection into cached single object type
 */
export type ModelCreateInput<T extends FieldRecord> = Simplify<
  ScalarCreateFields<T> & RelationCreateFields<T>
>;

/**
 * Computes the createMany input type for a model (scalars only, no nested relations)
 * Like Prisma's CreateManyInput which excludes nested relation operations
 */
export type ModelCreateManyInput<T extends FieldRecord> = {
  [K in keyof T as T[K] extends Field ? K : never]: InferFieldCreate<T[K]>;
  // No relation fields - createMany doesn't support nested operations
};

/**
 * CreateMany envelope with skipDuplicates option
 * Matches Prisma's createMany({ data: [...], skipDuplicates?: boolean })
 */
export type CreateManyEnvelope<T extends FieldRecord> = {
  data: ModelCreateManyInput<T>[];
  skipDuplicates?: boolean;
};

// =============================================================================
// WHERE INPUT TYPES
// =============================================================================

/**
 * Scalar field filters for where input
 */
type ScalarWhereFields<T extends FieldRecord> = {
  [K in keyof T as T[K] extends Field ? K : never]?: InferFieldFilter<T[K]>;
};

/**
 * Relation filters for where input
 */
type RelationWhereFields<T extends FieldRecord> = {
  [K in keyof T as T[K] extends Relation<any, any, any>
    ? K
    : never]?: RelationWhereInput<T[K]>;
};

/**
 * Logical operators for where input (recursive)
 */
type WhereLogicalOperators<T extends FieldRecord> = {
  AND?: ModelWhereInput<T>[];
  OR?: ModelWhereInput<T>[];
  NOT?: ModelWhereInput<T>;
};

/**
 * Computes the where input type for a model (fields + relations + logical operators)
 * Uses Simplify to flatten intersections into cached single object type
 */
export type ModelWhereInput<T extends FieldRecord> = Simplify<
  ScalarWhereFields<T> & RelationWhereFields<T> & WhereLogicalOperators<T>
>;

// =============================================================================
// WHERE UNIQUE INPUT TYPES
// =============================================================================

/**
 * Base shape for unique input (all fields optional)
 */
type WhereUniqueBase<T extends FieldRecord> = {
  [K in keyof T as T[K] extends Field ? K : never]?: InferFieldBase<T[K]>;
};

/**
 * Computes the where unique input type for a model
 * Requires at least one unique/id field to be provided
 */
export type ModelWhereUniqueInput<T extends FieldRecord> =
  UniqueFieldKeys<T> extends never
    ? WhereUniqueBase<T> // No unique fields, allow any combination
    : AtLeast<
        WhereUniqueBase<T>,
        UniqueFieldKeys<T> & keyof WhereUniqueBase<T>
      >;

// =============================================================================
// UPDATE INPUT TYPES
// =============================================================================

/**
 * Scalar fields for update input (all optional)
 */
type ScalarUpdateFields<T extends FieldRecord> = {
  [K in keyof T as T[K] extends Field ? K : never]?: InferFieldUpdate<T[K]>;
};

/**
 * Relation fields for update input (all optional)
 */
type RelationUpdateFields<T extends FieldRecord> = {
  [K in keyof T as T[K] extends Relation<any, any, any>
    ? K
    : never]?: RelationUpdateInput<T[K]>;
};

/**
 * Computes the update input type for a model (fields + relations)
 * Uses Simplify to flatten intersection into cached single object type
 */
export type ModelUpdateInput<T extends FieldRecord> = Simplify<
  ScalarUpdateFields<T> & RelationUpdateFields<T>
>;

// =============================================================================
// SELECT / INCLUDE TYPES
// =============================================================================

/**
 * Computes the select type for a model
 */
export type ModelSelect<T extends FieldRecord> = {
  [K in keyof T]?: boolean;
};

/**
 * Computes the include type for a model
 */
export type ModelInclude<T extends FieldRecord> = {
  [K in keyof T as T[K] extends Relation<any, any, any> ? K : never]?: boolean;
};

// =============================================================================
// ORDER BY TYPES
// =============================================================================

/**
 * Computes the orderBy type for a model with nulls handling
 */
export type ModelOrderBy<TFields extends FieldRecord> = {
  [K in keyof TFields as TFields[K] extends Field ? K : never]?: SortOrderInput;
};

// =============================================================================
// AGGREGATION TYPES
// =============================================================================

/**
 * Count aggregate input - can select specific fields or _all
 * Uses Simplify to flatten intersection into cached single object type
 */
export type ModelCountAggregateInput<TFields extends FieldRecord> = Simplify<
  { [K in keyof TFields as TFields[K] extends Field ? K : never]?: true } & {
    _all?: true;
  }
>;

/**
 * Avg/Sum aggregate input - only numeric fields
 */
export type ModelAvgAggregateInput<TFields extends FieldRecord> = {
  [K in NumericFieldKeys<TFields>]?: true;
};

/**
 * Min/Max aggregate input - all comparable fields
 */
export type ModelMinMaxAggregateInput<TFields extends FieldRecord> = {
  [K in keyof TFields as TFields[K] extends Field ? K : never]?: true;
};

// =============================================================================
// GROUPBY TYPES
// =============================================================================

/**
 * Aggregate selector fields for having clause
 */
type AggregateSelectors<TFields extends FieldRecord> = {
  _count?: ModelCountAggregateInput<TFields>;
  _avg?: ModelAvgAggregateInput<TFields>;
  _sum?: ModelAvgAggregateInput<TFields>;
  _min?: ModelMinMaxAggregateInput<TFields>;
  _max?: ModelMinMaxAggregateInput<TFields>;
};

/**
 * Scalar where with aggregates - for having clause
 * Uses Simplify to flatten intersection into cached single object type
 */
export type ModelScalarWhereWithAggregates<TFields extends FieldRecord> =
  Simplify<ModelWhereInput<TFields> & AggregateSelectors<TFields>>;

