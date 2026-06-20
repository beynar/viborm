// Core schema factories - re-exports

// Create exports
export {
  type CreateSchema,
  getCreateSchema,
  getNestedScalarCreate,
  getNestedScalarCreateWithOmittedRequiredKeys,
  getRelationCreate,
  getScalarCreate,
  type NestedScalarCreateSchema,
  type NestedScalarCreateWithOmittedRequiredKeys,
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

import type { AnyModel } from "@schema/model";
import type { FieldSchemas } from "../index";
import {
  getCreateSchema,
  getNestedScalarCreate,
  getNestedScalarCreateWithOmittedRequiredKeys,
  getRelationCreate,
  getScalarCreate,
  type CreateSchema,
  type NestedScalarCreateSchema,
  type NestedScalarCreateWithOmittedRequiredKeys,
  type RelationCreateSchema,
  type ScalarCreateSchema,
} from "./create";
import {
  getCompoundConstraintFilter,
  getCompoundIdFilter,
  getRelationFilter,
  getScalarFilter,
  getUniqueFilter,
  type CompoundConstraintFilterSchema,
  type CompoundIdFilterSchema,
  type RelationFilterSchema,
  type ScalarFilterSchema,
  type UniqueFilterSchema,
} from "./filter";
import { getOrderBySchema, type OrderBySchema } from "./orderby";
import { getIncludeSchema, getSelectSchema, type IncludeSchema, type SelectSchema } from "./select";
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

/**
 * Type representing all core schemas for a model.
 * Used by args factories to reference schema types.
 */
export type CoreSchemas<M extends AnyModel, F extends FieldSchemas<M>> = {
  scalarFilter: ScalarFilterSchema<M, F>;
  uniqueFilter: UniqueFilterSchema<M, F>;
  relationFilter: RelationFilterSchema<M, F>;
  compoundIdFilter: CompoundIdFilterSchema<M>;
  compoundConstraintFilter: CompoundConstraintFilterSchema<M>;
  scalarCreate: ScalarCreateSchema<M, F>;
  nestedScalarCreate: NestedScalarCreateSchema<M, F>;
  relationCreate: RelationCreateSchema<M, F>;
  scalarUpdate: ScalarUpdateSchema<M, F>;
  relationUpdate: RelationUpdateSchema<M, F>;
  where: WhereSchema<M, F>;
  whereUnique: WhereUniqueSchema<M, F>;
  create: CreateSchema<M, F>;
  update: UpdateSchema<M, F>;
  select: SelectSchema<M, F>;
  include: IncludeSchema<F>;
  orderBy: OrderBySchema<M, F>;
};

export const getCoreSchemas = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
>(
  model: M,
  fieldSchemas: F,
): CoreSchemas<M, F> => {
  const scalarFilter = getScalarFilter<M, F>(fieldSchemas);
  const uniqueFilter = getUniqueFilter(model, fieldSchemas);
  const relationFilter = getRelationFilter<M, F>(fieldSchemas);
  const compoundIdFilter = getCompoundIdFilter(model);
  const compoundConstraintFilter = getCompoundConstraintFilter(model);
  const scalarCreate = getScalarCreate(model, fieldSchemas);
  const nestedScalarCreate = getNestedScalarCreate(model, fieldSchemas);
  const relationCreate = getRelationCreate<M, F>(fieldSchemas);
  const scalarUpdate = getScalarUpdate<M, F>(fieldSchemas);
  const relationUpdate = getRelationUpdate<M, F>(fieldSchemas);
  const where = getWhereSchema<M, F>(fieldSchemas);
  const whereUnique = getWhereUniqueSchema(model, fieldSchemas);
  const create = getCreateSchema(model, fieldSchemas);
  const update = getUpdateSchema<M, F>(fieldSchemas);
  const select = getSelectSchema<M, F>(fieldSchemas);
  const include = getIncludeSchema(fieldSchemas);
  const orderBy = getOrderBySchema<M, F>(fieldSchemas);

  return {
    scalarFilter,
    uniqueFilter,
    relationFilter,
    compoundIdFilter,
    compoundConstraintFilter,
    scalarCreate,
    nestedScalarCreate,
    relationCreate,
    scalarUpdate,
    relationUpdate,
    where,
    whereUnique,
    create,
    update,
    select,
    include,
    orderBy,
  };
};
