// Core schema factories - re-exports

// Filter exports
export {
  getScalarFilter,
  getUniqueFilter,
  getRelationFilter,
  getCompoundConstraintFilter,
  getCompoundIdFilter,
} from "./filter";

// Create exports
export { getScalarCreate, getRelationCreate, getCreateSchema } from "./create";

// Update exports
export { getScalarUpdate, getRelationUpdate, getUpdateSchema } from "./update";

// Where exports
export { getWhereSchema, getWhereUniqueSchema } from "./where";

// Select/Include exports
export { getSelectSchema, getIncludeSchema } from "./select";

// OrderBy exports
export { getOrderBySchema, sortOrderSchema } from "./orderby";

// =============================================================================
// INFERRED TYPE EXPORTS
// =============================================================================
// These types are inferred from the return types of the factory functions
// rather than being explicitly defined

import type { ModelState } from "../../model";

// Core schema types (inferred from factory return types)
export type SelectSchema<T extends ModelState> = ReturnType<
  typeof import("./select").getSelectSchema<T>
>;
export type IncludeSchema<T extends ModelState> = ReturnType<
  typeof import("./select").getIncludeSchema<T>
>;

export type UpdateSchema<T extends ModelState> = ReturnType<
  typeof import("./update").getUpdateSchema<T>
>;
export type ScalarUpdateSchema<T extends ModelState> = ReturnType<
  typeof import("./update").getScalarUpdate<T>
>;
export type RelationUpdateSchema<T extends ModelState> = ReturnType<
  typeof import("./update").getRelationUpdate<T>
>;

export type WhereSchema<T extends ModelState> = ReturnType<
  typeof import("./where").getWhereSchema<T>
>;
export type WhereUniqueSchema<T extends ModelState> = ReturnType<
  typeof import("./where").getWhereUniqueSchema<T>
>;

export type CreateSchema<T extends ModelState> = ReturnType<
  typeof import("./create").getCreateSchema<T>
>;
export type ScalarCreateSchema<T extends ModelState> = ReturnType<
  typeof import("./create").getScalarCreate<T>
>;
export type RelationCreateSchema<T extends ModelState> = ReturnType<
  typeof import("./create").getRelationCreate<T>
>;

export type ScalarFilterSchema<T extends ModelState> = ReturnType<
  typeof import("./filter").getScalarFilter<T>
>;
export type UniqueFilterSchema<T extends ModelState> = ReturnType<
  typeof import("./filter").getUniqueFilter<T>
>;
export type RelationFilterSchema<T extends ModelState> = ReturnType<
  typeof import("./filter").getRelationFilter<T>
>;

export type OrderBySchema<T extends ModelState> = ReturnType<
  typeof import("./orderby").getOrderBySchema<T>
>;
