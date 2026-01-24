// Relation Create Schemas

import { type V, v } from "@validation";
import type { RelationState } from "../types";
import {
  getTargetCreateSchema,
  getTargetNestedScalarCreateSchema,
  getTargetWhereUniqueSchema,
  type InferTargetSchema,
  singleOrArray,
} from "./helpers";
// =============================================================================
// CREATE SCHEMA TYPES (exported for consumer use)
// =============================================================================

// =============================================================================
// CREATE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one create: { create?, connect?, connectOrCreate? }
 */
export type ToOneCreateSchema<S extends RelationState> = V.Object<
  {
    create: () => InferTargetSchema<S, "create">;
    connect: () => InferTargetSchema<S, "whereUnique">;
    connectOrCreate: V.Object<{
      where: () => InferTargetSchema<S, "whereUnique">;
      create: () => InferTargetSchema<S, "create">;
    }>;
  },
  { optional: true }
>;

export const toOneCreateFactory = <S extends RelationState>(
  state: S
): ToOneCreateSchema<S> => {
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
 *
 * Note: createMany uses scalarCreate (no nested relations) because
 * nested creates within createMany are not supported.
 */

export type ToManyCreateSchema<S extends RelationState> = V.Object<
  {
    create: () => V.SingleOrArray<InferTargetSchema<S, "create">>;
    createMany: V.Object<{
      data: () => V.Array<InferTargetSchema<S, "nestedScalarCreate">>;
      skipDuplicates: V.Boolean<{ optional: true }>;
    }>;
    connect: () => V.SingleOrArray<InferTargetSchema<S, "whereUnique">>;
    connectOrCreate: () => V.SingleOrArray<
      V.Object<
        {
          where: () => InferTargetSchema<S, "whereUnique">;
          create: () => InferTargetSchema<S, "create">;
        },
        { partial: false }
      >
    >;
  },
  { optional: true }
>;
export const toManyCreateFactory = <S extends RelationState>(
  state: S
): ToManyCreateSchema<S> => {
  return v.object(
    {
      create: () => singleOrArray(getTargetCreateSchema(state)()),
      // createMany only accepts scalar fields - no nested relation mutations
      // Uses nestedScalarCreate which marks FK fields as optional (derived from parent)
      createMany: v.object({
        data: () => v.array(getTargetNestedScalarCreateSchema(state)()),
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
