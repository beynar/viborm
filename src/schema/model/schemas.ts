// Model Schema Factories
// Composes all model schemas from modular schema factories

import type { ModelState } from "./model";
// Import args schema factories
import {
  getAggregateArgs,
  getCountArgs,
  getCreateArgs,
  getCreateManyArgs,
  getDeleteArgs,
  getDeleteManyArgs,
  getFindFirstArgs,
  getFindManyArgs,
  getFindUniqueArgs,
  getGroupByArgs,
  getUpdateArgs,
  getUpdateManyArgs,
  getUpsertArgs,
} from "./schemas/args";

// Import core schema factories
import {
  getCompoundConstraintFilter,
  getCreateSchema,
  getIncludeSchema,
  getOrderBySchema,
  getRelationCreate,
  getRelationFilter,
  getRelationUpdate,
  getScalarCreate,
  getScalarFilter,
  getScalarUpdate,
  getSelectSchema,
  getUniqueFilter,
  getUpdateSchema,
  getWhereSchema,
  getWhereUniqueSchema,
} from "./schemas/core";
import { getCompoundIdFilter } from "./schemas/core/filter";

// =============================================================================
// MAIN EXPORT - getModelSchemas
// =============================================================================

/**
 * Build all schemas for a model.
 * Returns a complete set of schemas for validation and type inference.
 */
export const getModelSchemas = <T extends ModelState>(state: T) => {
  // Core building blocks
  const scalarFilter = getScalarFilter(state);
  const uniqueFilter = getUniqueFilter(state);
  const relationFilter = getRelationFilter(state);
  const compoundConstraintFilter = getCompoundConstraintFilter(state);
  const compoundIdFilter = getCompoundIdFilter(state);

  const scalarCreate = getScalarCreate(state);
  const relationCreate = getRelationCreate(state);

  const scalarUpdate = getScalarUpdate(state);
  const relationUpdate = getRelationUpdate(state);

  // Select, include, orderBy
  const select = getSelectSchema(state);
  const include = getIncludeSchema(state);
  const orderBy = getOrderBySchema(state);

  // Combined schemas
  const where = getWhereSchema(state);
  const whereUnique = getWhereUniqueSchema(state);
  const create = getCreateSchema(state);
  const update = getUpdateSchema(state);

  // Core schemas bundle for args factories
  const core = {
    where,
    whereUnique,
    create,
    update,
    select,
    include,
    orderBy,
    scalarCreate,
  };

  return {
    // Core building blocks (exposed for advanced use)
    _filter: {
      scalar: scalarFilter,
      unique: uniqueFilter,
      relation: relationFilter,
      compoundConstraint: compoundConstraintFilter,
      compoundId: compoundIdFilter,
    },
    _create: {
      scalar: scalarCreate,
      relation: relationCreate,
    },
    _update: {
      scalar: scalarUpdate,
      relation: relationUpdate,
    },

    // Combined schemas
    where,
    whereUnique,
    create,
    update,
    select,
    include,
    orderBy,

    // Args schemas for each operation
    args: {
      findUnique: getFindUniqueArgs(core),
      findFirst: getFindFirstArgs(core),
      findMany: getFindManyArgs(state, core),
      create: getCreateArgs(core),
      createMany: getCreateManyArgs(core),
      update: getUpdateArgs(core),
      updateMany: getUpdateManyArgs(core),
      delete: getDeleteArgs(core),
      deleteMany: getDeleteManyArgs(core),
      upsert: getUpsertArgs(core),
      count: getCountArgs(core),
      aggregate: getAggregateArgs(state, core),
      groupBy: getGroupByArgs(state, core),
    },
  };
};
