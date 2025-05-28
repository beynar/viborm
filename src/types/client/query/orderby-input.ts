// OrderBy Input Types
// Type-safe ordering interfaces for BaseORM queries

import type { Model } from "../../../schema/model.js";
import type { BaseField } from "../../../schema/fields/base.js";
import type { Relation } from "../../../schema/relation.js";
import type {
  FieldNames,
  RelationNames,
  ModelFields,
  ModelRelations,
  MapFieldType,
} from "../foundation/index.js";
import type { SortOrder } from "../filters.js";

// ===== SORT ORDER DEFINITIONS =====

/**
 * Extended sort order with null positioning
 */
export type SortOrderWithNulls =
  | "asc"
  | "desc"
  | "asc_nulls_first"
  | "asc_nulls_last"
  | "desc_nulls_first"
  | "desc_nulls_last";

/**
 * Sort order for relation counts
 */
export type RelationCountSortOrder = SortOrder;

// ===== CORE ORDER BY TYPES =====

/**
 * Basic ordering interface for scalar fields only
 */
export type OrderByInput<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? SortOrderWithNulls
      : never
    : never;
};

/**
 * Enhanced ordering interface that includes relation ordering
 */
export type OrderByWithRelationInput<TModel extends Model<any>> = {
  // Scalar field ordering
  [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? SortOrderWithNulls
      : never
    : never;
} & {
  // Relation ordering (for nested sorting)
  [K in RelationNames<TModel> as `${K &
    string}`]?: K extends keyof ModelRelations<TModel>
    ? ModelRelations<TModel>[K] extends Relation<any, any>
      ? RelationOrderByInput<ModelRelations<TModel>[K]>
      : never
    : never;
} & {
  // Relation count ordering
  [K in RelationNames<TModel> as `_count_${K &
    string}`]?: RelationCountSortOrder;
};

/**
 * Array of order by inputs for multiple sort criteria
 */
export type OrderByArrayInput<TModel extends Model<any>> = Array<
  OrderByWithRelationInput<TModel>
>;

// ===== RELATION ORDERING =====

/**
 * Extract the target model from a relation using its getter
 */
export type ExtractRelationModelForOrder<TRelation> =
  TRelation extends Relation<infer TGetter, any>
    ? TGetter extends () => infer TModel
      ? TModel extends Model<any>
        ? TModel
        : never
      : never
    : never;

/**
 * Relation ordering based on relation type
 */
export type RelationOrderByInput<TRelation extends Relation<any, any>> =
  TRelation extends Relation<any, infer TRelationType>
    ? TRelationType extends "oneToOne" | "manyToOne"
      ? OrderByWithRelationInput<ExtractRelationModelForOrder<TRelation>>
      : TRelationType extends "oneToMany" | "manyToMany"
      ? RelationAggregateOrderByInput<ExtractRelationModelForOrder<TRelation>>
      : never
    : never;

/**
 * Aggregate ordering for to-many relations
 */
export type RelationAggregateOrderByInput<TRelatedModel extends Model<any>> = {
  _count?: SortOrder;
} & {
  // Aggregate functions on scalar fields of related model
  [K in FieldNames<TRelatedModel> as K extends keyof ModelFields<TRelatedModel>
    ? ModelFields<TRelatedModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TRelatedModel>[K]> extends number
        ?
            | `_avg_${K & string}`
            | `_sum_${K & string}`
            | `_min_${K & string}`
            | `_max_${K & string}`
        : MapFieldType<ModelFields<TRelatedModel>[K]> extends string | Date
        ? `_min_${K & string}` | `_max_${K & string}`
        : never
      : never
    : never]?: SortOrder;
};

// ===== FIELD-SPECIFIC ORDERING =====

/**
 * Ordering for specific field types
 */
export type FieldOrderByInput<T> = T extends
  | string
  | number
  | Date
  | bigint
  | boolean
  ? SortOrderWithNulls
  : never;

// ===== COMPOSITE ORDERING TYPES =====

/**
 * Combined ordering type that handles both simple and complex cases
 */
export type ModelOrderByInput<TModel extends Model<any>> =
  | OrderByWithRelationInput<TModel>
  | OrderByArrayInput<TModel>;

/**
 * Ordering for search results (with relevance scoring)
 */
export type SearchOrderByInput<TModel extends Model<any>> =
  | ModelOrderByInput<TModel>
  | { _relevance?: SortOrder };

// ===== UTILITY TYPES =====

/**
 * Extract valid sort fields from a model
 */
export type ValidSortFields<TModel extends Model<any>> = FieldNames<TModel>;

/**
 * Extract valid relation sort fields from a model
 */
export type ValidRelationSortFields<TModel extends Model<any>> =
  RelationNames<TModel>;

/**
 * Check if a field supports ordering
 */
export type IsOrderableField<TField extends BaseField<any>> =
  MapFieldType<TField> extends string | number | Date | bigint | boolean
    ? true
    : false;

/**
 * Get orderable fields from a model
 */
export type GetOrderableFields<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? IsOrderableField<ModelFields<TModel>[K]> extends true
        ? K
        : never
      : never
    : never;
}[FieldNames<TModel>];

// ===== AGGREGATION ORDERING =====

/**
 * Aggregation functions available for ordering
 */
export type AggregationFunction = "count" | "avg" | "sum" | "min" | "max";

/**
 * Aggregation ordering input
 */
export type AggregationOrderByInput = {
  [K in AggregationFunction]?: SortOrder;
};

/**
 * Field aggregation ordering for numeric fields
 */
export type FieldAggregationOrderByInput<TField extends BaseField<any>> =
  MapFieldType<TField> extends number
    ? {
        _count?: SortOrder;
        _avg?: SortOrder;
        _sum?: SortOrder;
        _min?: SortOrder;
        _max?: SortOrder;
      }
    : MapFieldType<TField> extends string | Date
    ? {
        _count?: SortOrder;
        _min?: SortOrder;
        _max?: SortOrder;
      }
    : {
        _count?: SortOrder;
      };
