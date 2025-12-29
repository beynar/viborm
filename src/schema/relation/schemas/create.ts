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
  return v.object(
    {
      create: getTargetCreateSchema(state),
      connect: getTargetWhereUniqueSchema(state),
      connectOrCreate: v.object({
        where: getTargetWhereUniqueSchema(state),
        create: getTargetCreateSchema(state),
      }),
    },
    { optional: true }
  );
};

/**
 * To-many create: { create?, createMany?, connect?, connectOrCreate? }
 * All accept single or array, normalized to array
 * Uses thunks for lazy evaluation to avoid circular reference issues
 */
export const toManyCreateFactory = <S extends RelationState>(state: S) => {
  return v.object(
    {
      create: () => singleOrArray(getTargetCreateSchema(state)()),
      createMany: v.object({
        data: () => v.array(getTargetCreateSchema(state)()),
        skipDuplicates: v.boolean({ optional: true }),
      }),
      connect: () => singleOrArray(getTargetWhereUniqueSchema(state)()),
      connectOrCreate: () =>
        singleOrArray(
          v.object(
            {
              where: getTargetWhereUniqueSchema(state),
              create: getTargetCreateSchema(state),
            },
            { partial: false }
          )
        ),
    },
    { optional: true }
  );
};
