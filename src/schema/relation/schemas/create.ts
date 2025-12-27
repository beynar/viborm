// Relation Create Schemas
import type { RelationState } from "../relation";
import {
  getTargetCreateSchema,
  getTargetWhereUniqueSchema,
  singleOrArray,
} from "./helpers";
import { v } from "../../../validation";
// =============================================================================
// CREATE SCHEMA TYPES (exported for consumer use)
// =============================================================================

// =============================================================================
// CREATE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one create: { create?, connect?, connectOrCreate? }
 */
export const toOneCreateFactory = <S extends RelationState>(state: S) => {
  const createSchema = getTargetCreateSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);
  return v.object({
    create: createSchema,
    connect: whereUniqueSchema,
    connectOrCreate: v.object({
      where: whereUniqueSchema,
      create: createSchema,
    }),
  });
};

/**
 * To-many create: { create?, connect?, connectOrCreate? }
 * All accept single or array, normalized to array
 */
export const toManyCreateFactory = <S extends RelationState>(state: S) => {
  const createSchema = getTargetCreateSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);

  return v.object({
    create: () => singleOrArray(createSchema()),
    connect: () => singleOrArray(whereUniqueSchema()),
    connectOrCreate: () =>
      singleOrArray(
        v.object({
          where: whereUniqueSchema(),
          create: createSchema(),
        })
      ),
  });
};
