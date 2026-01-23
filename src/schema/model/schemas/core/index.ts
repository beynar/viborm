// Core schema factories - re-exports

// Create exports
export {
  type CreateSchema,
  getCreateSchema,
  getRelationCreate,
  getScalarCreate,
  type RelationCreateSchema,
  type ScalarCreateSchema,
} from "./create";
// Filter exports
export {
  type CompoundConstraintFilterSchema,
  type CompoundIdFilterSchema,
  getCompoundConstraintFilter,
  getCompoundIdFilter,
  getRelationFilter,
  getScalarFilter,
  getUniqueFilter,
  type RelationFilterSchema,
  type ScalarFilterSchema,
  type UniqueFilterSchema,
} from "./filter";
// OrderBy exports
export {
  getOrderBySchema,
  type OrderBySchema,
  sortOrderSchema,
} from "./orderby";
// Select/Include exports
export {
  getIncludeSchema,
  getSelectSchema,
  type IncludeSchema,
  type SelectSchema,
} from "./select";
// Update exports
export {
  getRelationUpdate,
  getScalarUpdate,
  getUpdateSchema,
  type RelationUpdateSchema,
  type ScalarUpdateSchema,
  type UpdateSchema,
} from "./update";
// Where exports
export {
  getWhereSchema,
  getWhereUniqueSchema,
  type WhereSchema,
  type WhereUniqueSchema,
} from "./where";

// =============================================================================
// CORE SCHEMAS TYPE
// =============================================================================

import type { ModelState } from "../../model";
import type {
  CreateSchema,
  RelationCreateSchema,
  ScalarCreateSchema,
} from "./create";
import type {
  CompoundConstraintFilterSchema,
  CompoundIdFilterSchema,
  RelationFilterSchema,
  ScalarFilterSchema,
  UniqueFilterSchema,
} from "./filter";
import type { OrderBySchema } from "./orderby";
import type { IncludeSchema, SelectSchema } from "./select";
import type {
  RelationUpdateSchema,
  ScalarUpdateSchema,
  UpdateSchema,
} from "./update";
import type { WhereSchema, WhereUniqueSchema } from "./where";

/**
 * Type representing all core schemas for a model.
 * Used by args factories to reference schema types.
 */
export type CoreSchemas<T extends ModelState> = {
  scalarFilter: ScalarFilterSchema<T>;
  uniqueFilter: UniqueFilterSchema<T>;
  relationFilter: RelationFilterSchema<T>;
  compoundIdFilter: CompoundIdFilterSchema<T>;
  compoundConstraintFilter: CompoundConstraintFilterSchema<T>;
  scalarCreate: ScalarCreateSchema<T>;
  relationCreate: RelationCreateSchema<T>;
  scalarUpdate: ScalarUpdateSchema<T>;
  relationUpdate: RelationUpdateSchema<T>;
  where: WhereSchema<T>;
  whereUnique: WhereUniqueSchema<T>;
  create: CreateSchema<T>;
  update: UpdateSchema<T>;
  select: SelectSchema<T>;
  include: IncludeSchema<T>;
  orderBy: OrderBySchema<T>;
};
