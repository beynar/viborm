// OrderBy Input Types
// Type-safe ordering interfaces for VibORM queries

import type { Model, Field, Relation } from "@schema";
import type {
  FieldNames,
  ModelFields,
  ModelRelations,
  ActualPluralRelationNames,
  ActualSingleRelationNames,
  ExtractRelationModel,
} from "../foundation/index.js";

import {
  lazy,
  enum as _enum,
  input,
  union,
  object,
  optional,
} from "zod/v4-mini";

export const sortOrder = _enum(["asc", "desc"]);
export type SortOrder = input<typeof sortOrder>;

// ===== SORT ORDER DEFINITIONS =====

/**
 * Extended sort order with null positioning
 */

export const nullSort = _enum(["first", "last"]);
export type NullSort = input<typeof nullSort>;

const scalarSortOrder = lazy(() => {
  return union([
    sortOrder,
    object({
      sort: sortOrder,
      nulls: optional(nullSort),
    }),
  ]);
});

type ScalarSort = input<typeof scalarSortOrder>;

const relationManySort = lazy(() =>
  object({
    _count: sortOrder,
  })
);

export type RelationManySort = input<typeof relationManySort>;

// ===== CORE ORDER BY TYPES =====

/**
 * Basic ordering interface for scalar fields only
 */
export type OrderByScalarInput<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends Field
      ? ScalarSort
      : never
    : never;
};

export type OrderByManyRelationInput<TModel extends Model<any>> = {
  [K in ActualPluralRelationNames<TModel>]?: K extends keyof ModelRelations<TModel>
    ? ModelRelations<TModel>[K] extends Relation<any, any>
      ? {
          _count: SortOrder;
        }
      : never
    : never;
};

export type OrderByOneRelationInput<TModel extends Model<any>> = {
  [K in ActualSingleRelationNames<TModel>]?: K extends keyof ModelRelations<TModel>
    ? ModelRelations<TModel>[K] extends Relation<any, any>
      ? OrderByInput<ExtractRelationModel<ModelRelations<TModel>[K]>>
      : never
    : never;
};

export /**
 * Enhanced ordering interface that includes relation ordering
 */
type OrderByInput<TModel extends Model<any>> = OrderByScalarInput<TModel> &
  OrderByManyRelationInput<TModel> &
  OrderByOneRelationInput<TModel>;

/**
 * Array of order by inputs for multiple sort criteria
 */
export type OrderByArrayInput<TModel extends Model<any>> = Array<
  OrderByInput<TModel>
>;
