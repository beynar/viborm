// Nested Select/Include Types
// Allows nested relation queries like: include: { posts: { where: { published: true } } }

import type {
  FieldRecord,
  ScalarFieldKeys,
  RelationKeys,
  GetRelationFields,
  GetRelationType,
} from "./helpers";
import type { SortOrderInput } from "./base-types";
import type { ModelWhereInput, ModelOrderBy } from "./input-types";

// =============================================================================
// NESTED SELECT TYPES
// =============================================================================

/**
 * Base select type for scalar fields
 */
export type ScalarSelect<T extends FieldRecord> = {
  [K in ScalarFieldKeys<T>]?: boolean;
};

/**
 * Nested select value for a relation
 * Can be true (include all) or an object with nested select
 */
export type RelationSelectValue<TRelationFields extends FieldRecord> =
  | boolean
  | { select?: ModelSelectNested<TRelationFields> };

/**
 * Full nested select type
 * Allows selecting specific fields including nested relations
 */
export type ModelSelectNested<T extends FieldRecord> = ScalarSelect<T> & {
  [K in RelationKeys<T>]?: RelationSelectValue<GetRelationFields<T[K]>>;
};

// =============================================================================
// NESTED INCLUDE TYPES
// =============================================================================

/**
 * Nested include args for to-one relations
 */
export interface ToOneIncludeArgs<TRelationFields extends FieldRecord> {
  select?: ModelSelectNested<TRelationFields>;
  include?: ModelIncludeNested<TRelationFields>;
}

/**
 * Nested include args for to-many relations
 * Includes pagination and filtering options
 */
export interface ToManyIncludeArgs<TRelationFields extends FieldRecord> {
  select?: ModelSelectNested<TRelationFields>;
  include?: ModelIncludeNested<TRelationFields>;
  where?: ModelWhereInput<TRelationFields>;
  orderBy?: ModelOrderBy<TRelationFields> | ModelOrderBy<TRelationFields>[];
  cursor?: { [K in keyof TRelationFields]?: unknown }; // Simplified cursor
  take?: number;
  skip?: number;
  distinct?: ScalarFieldKeys<TRelationFields>[];
}

/**
 * Include value based on relation type
 */
export type RelationIncludeValue<
  TRelationFields extends FieldRecord,
  TRelationType extends string
> =
  | boolean
  | (TRelationType extends "oneToMany" | "manyToMany"
      ? ToManyIncludeArgs<TRelationFields>
      : ToOneIncludeArgs<TRelationFields>);

/**
 * Full nested include type
 * Maps each relation to its include value based on relation type
 */
export type ModelIncludeNested<T extends FieldRecord> = {
  [K in RelationKeys<T>]?: RelationIncludeValue<
    GetRelationFields<T[K]>,
    GetRelationType<T[K]>
  >;
};

// =============================================================================
// COMBINED FIND ARGS WITH NESTED SUPPORT
// =============================================================================

/**
 * FindMany args with nested select/include support
 */
export type FindManyArgsNested<T extends FieldRecord> = {
  where?: ModelWhereInput<T>;
  orderBy?: ModelOrderBy<T> | ModelOrderBy<T>[];
  cursor?: { [K in keyof T]?: unknown };
  take?: number;
  skip?: number;
  select?: ModelSelectNested<T>;
  include?: ModelIncludeNested<T>;
  distinct?: ScalarFieldKeys<T>[];
};

/**
 * FindUnique args with nested select/include support
 */
export type FindUniqueArgsNested<T extends FieldRecord> = {
  where: { [K in keyof T]?: unknown }; // Simplified unique where
  select?: ModelSelectNested<T>;
  include?: ModelIncludeNested<T>;
};

/**
 * FindFirst args with nested select/include support
 */
export type FindFirstArgsNested<T extends FieldRecord> = FindManyArgsNested<T>;
