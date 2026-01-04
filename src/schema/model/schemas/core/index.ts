// Core schema factories - re-exports

// Create exports
export { getCreateSchema, getRelationCreate, getScalarCreate } from "./create";
// Filter exports
export {
  getCompoundConstraintFilter,
  getCompoundIdFilter,
  getRelationFilter,
  getScalarFilter,
  getUniqueFilter,
} from "./filter";
// OrderBy exports
export { getOrderBySchema, sortOrderSchema } from "./orderby";
// Select/Include exports
export { getIncludeSchema, getSelectSchema } from "./select";
// Update exports
export { getRelationUpdate, getScalarUpdate, getUpdateSchema } from "./update";
// Where exports
export { getWhereSchema, getWhereUniqueSchema } from "./where";

// =============================================================================
// INFERRED TYPE EXPORTS
// =============================================================================
// These types are inferred from the return types of the factory functions
// rather than being explicitly defined

import type { ModelState } from "../../model";
import type {
  getCreateSchema,
  getRelationCreate,
  getScalarCreate,
} from "./create";
import type {
  getRelationFilter,
  getScalarFilter,
  getUniqueFilter,
} from "./filter";
import type { getOrderBySchema } from "./orderby";
import type { getIncludeSchema, getSelectSchema } from "./select";
import type {
  getRelationUpdate,
  getScalarUpdate,
  getUpdateSchema,
} from "./update";
import type { getWhereSchema, getWhereUniqueSchema } from "./where";
// Core schema types (inferred from factory return types)
export type SelectSchema<T extends ModelState> = ReturnType<
  typeof getSelectSchema<T>
>;
export type IncludeSchema<T extends ModelState> = ReturnType<
  typeof getIncludeSchema<T>
>;

export type UpdateSchema<T extends ModelState> = ReturnType<
  typeof getUpdateSchema<T>
>;
export type ScalarUpdateSchema<T extends ModelState> = ReturnType<
  typeof getScalarUpdate<T>
>;
export type RelationUpdateSchema<T extends ModelState> = ReturnType<
  typeof getRelationUpdate<T>
>;

export type WhereSchema<T extends ModelState> = ReturnType<
  typeof getWhereSchema<T>
>;
export type WhereUniqueSchema<T extends ModelState> = ReturnType<
  typeof getWhereUniqueSchema<T>
>;

export type CreateSchema<T extends ModelState> = ReturnType<
  typeof getCreateSchema<T>
>;
export type ScalarCreateSchema<T extends ModelState> = ReturnType<
  typeof getScalarCreate<T>
>;
export type RelationCreateSchema<T extends ModelState> = ReturnType<
  typeof getRelationCreate<T>
>;

export type ScalarFilterSchema<T extends ModelState> = ReturnType<
  typeof getScalarFilter<T>
>;
export type UniqueFilterSchema<T extends ModelState> = ReturnType<
  typeof getUniqueFilter<T>
>;
export type RelationFilterSchema<T extends ModelState> = ReturnType<
  typeof getRelationFilter<T>
>;

export type OrderBySchema<T extends ModelState> = ReturnType<
  typeof getOrderBySchema<T>
>;
