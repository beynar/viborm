// Model Schema Factories
// Main entry point - builds all model schemas by composing field-level schemas

import type { ModelState } from "../model";
// Args schema factories
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
} from "./args";
// Core schema factories
import { getCoreSchemas } from "./core";

export type { CoreSchemas } from "./core";

import type { ModelSchemas } from "./types";

// Re-export args schemas
export * from "./args";
// Re-export core schemas
export * from "./core";
// Re-export types
export type { SchemaEntries } from "./types";
// Re-export utilities (if needed externally)
export { forEachRelation, forEachScalarField, isToOne } from "./utils";

/**
 * Build all schemas for a model.
 * Returns a complete set of schemas for validation and type inference.
 */
export const getModelSchemas = <T extends ModelState>(
  state: T
): ModelSchemas<T> => {
  // Core schemas bundle for args factories
  const core = getCoreSchemas(state);
  return {
    ...core,
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
