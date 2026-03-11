// Relation Create Schemas

import type { AnyModel } from "@schema/model";
import type {
  GetInverseRelationFields,
  RelationState,
} from "@schema/relation/types";
import { type V, v } from "@validation";
import type { GetTargetSchemas, SchemaGetter } from "./helpers";

// =============================================================================
// CREATE SCHEMA TYPES (exported for consumer use)
// =============================================================================

export type CreateWithOmittedFk<
  S extends RelationState,
  Source extends AnyModel,
> = V.Omit<
  GetTargetSchemas<S>["core"]["create"],
  GetInverseRelationFields<S, Source>
>;

// =============================================================================
// CREATE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one create: { create?, connect?, connectOrCreate? }
 */
export type ToOneCreateSchema<
  S extends RelationState,
  Source extends AnyModel,
> = V.Object<
  {
    create: () => CreateWithOmittedFk<S, Source>;
    connect: () => GetTargetSchemas<S>["core"]["whereUnique"];
    connectOrCreate: V.Object<{
      where: () => GetTargetSchemas<S>["core"]["whereUnique"];
      create: () => CreateWithOmittedFk<S, Source>;
    }>;
  },
  { optional: true }
>;

export const toOneCreateFactory = <
  S extends RelationState,
  Source extends AnyModel,
  T extends SchemaGetter<S>,
>(
  state: S,
  source: Source,
  targetSchemas: T
): ToOneCreateSchema<S, Source> => {
  const getCreateSchema = () => {
    const fkFields = getInverseRelationFieldsRuntime(state, source);
    return v.omit(targetSchemas().core.create, fkFields);
  };

  return v.object(
    {
      create: getCreateSchema,
      connect: () => targetSchemas().core.whereUnique,
      connectOrCreate: v.object({
        where: () => targetSchemas().core.whereUnique,
        create: getCreateSchema,
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

export type ToManyCreateSchema<
  S extends RelationState,
  Source extends AnyModel,
> = V.Object<
  {
    create: () => V.SingleOrArray<CreateWithOmittedFk<S, Source>>;
    createMany: V.Object<{
      data: () => V.Array<GetTargetSchemas<S>["core"]["nestedScalarCreate"]>;
      skipDuplicates: V.Boolean<{ optional: true }>;
    }>;
    connect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
    connectOrCreate: () => V.SingleOrArray<
      V.Object<
        {
          where: () => GetTargetSchemas<S>["core"]["whereUnique"];
          create: () => CreateWithOmittedFk<S, Source>;
        },
        { partial: false }
      >
    >;
  },
  { optional: true }
>;

export const toManyCreateFactory = <
  S extends RelationState,
  Source extends AnyModel,
  T extends SchemaGetter<S>,
>(
  state: S,
  source: Source,
  targetSchemas: T
): ToManyCreateSchema<S, Source> => {
  const getCreateSchema = () => {
    const fkFields = getInverseRelationFieldsRuntime(state, source);
    return v.omit(targetSchemas().core.create, fkFields);
  };

  return v.object(
    {
      create: () => v.singleOrArray(getCreateSchema()),
      // createMany only accepts scalar fields - no nested relation mutations
      // Uses nestedScalarCreate which marks FK fields as optional (derived from parent)
      createMany: v.object({
        data: () => v.array(targetSchemas().core.nestedScalarCreate),
        skipDuplicates: v.boolean({ optional: true }),
      }),
      connect: () => v.singleOrArray(targetSchemas().core.whereUnique),
      connectOrCreate: () =>
        v.singleOrArray(
          v.object(
            {
              where: () => targetSchemas().core.whereUnique,
              create: getCreateSchema,
            },
            { partial: false }
          )
        ),
    },
    { optional: true }
  );
};

// Helper to get FK fields at runtime (moved from helpers.ts inline usage)
import { getInverseRelationFields as getInverseRelationFieldsRuntime } from "@schema/relation/types";
