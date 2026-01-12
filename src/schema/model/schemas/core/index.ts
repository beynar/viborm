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

import type { ModelState } from "../../model";
import {
  type CreateSchema,
  getCreateSchema,
  getRelationCreate,
  getScalarCreate,
  type RelationCreateSchema,
  type ScalarCreateSchema,
} from "./create";
import {
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
import { getOrderBySchema, type OrderBySchema } from "./orderby";
import {
  getIncludeSchema,
  getSelectSchema,
  type IncludeSchema,
  type SelectSchema,
} from "./select";
import {
  getRelationUpdate,
  getScalarUpdate,
  getUpdateSchema,
  type RelationUpdateSchema,
  type ScalarUpdateSchema,
  type UpdateSchema,
} from "./update";
import {
  getWhereSchema,
  getWhereUniqueSchema,
  type WhereSchema,
  type WhereUniqueSchema,
} from "./where";

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

export const getCoreSchemas = <T extends ModelState>(
  state: T
): CoreSchemas<T> => {
  return {
    scalarFilter: getScalarFilter(state),
    uniqueFilter: getUniqueFilter(state),
    relationFilter: getRelationFilter(state),
    compoundIdFilter: getCompoundIdFilter(state),
    compoundConstraintFilter: getCompoundConstraintFilter(state),
    scalarCreate: getScalarCreate(state),
    relationCreate: getRelationCreate(state),
    scalarUpdate: getScalarUpdate(state),
    relationUpdate: getRelationUpdate(state),
    where: getWhereSchema(state),
    whereUnique: getWhereUniqueSchema(state),
    create: getCreateSchema(state),
    update: getUpdateSchema(state),
    select: getSelectSchema(state),
    include: getIncludeSchema(state),
    orderBy: getOrderBySchema(state),
  };
};
