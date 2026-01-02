// Model Schema Factories
// Main entry point - builds all model schemas by composing field-level schemas

import type { ModelState } from "../model";

// Core schema factories
import {
  getScalarFilter,
  getUniqueFilter,
  getRelationFilter,
  getScalarCreate,
  getRelationCreate,
  getCreateSchema,
  getScalarUpdate,
  getRelationUpdate,
  getUpdateSchema,
  getWhereSchema,
  getWhereUniqueSchema,
  getSelectSchema,
  getIncludeSchema,
  getOrderBySchema,
} from "./core";

// Args schema factories
import {
  getFindUniqueArgs,
  getFindFirstArgs,
  getFindManyArgs,
  getCreateArgs,
  getCreateManyArgs,
  getUpdateArgs,
  getUpdateManyArgs,
  getDeleteArgs,
  getDeleteManyArgs,
  getUpsertArgs,
  getCountArgs,
  getAggregateArgs,
  getGroupByArgs,
} from "./args";

// Types
import type { CoreSchemas } from "./types";

// Re-export types
export type { CoreSchemas, SchemaEntries } from "./types";

// Re-export utilities (if needed externally)
export { forEachScalarField, forEachRelation, isToOne } from "./utils";

// Re-export core schemas
export * from "./core";

// Re-export args schemas
export * from "./args";

/**
 * Build all schemas for a model.
 * Returns a complete set of schemas for validation and type inference.
 */
export const getModelSchemas = <T extends ModelState>(state: T) => {
  // Core building blocks
  const scalarFilter = getScalarFilter(state);
  const uniqueFilter = getUniqueFilter(state);
  const relationFilter = getRelationFilter(state);

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
