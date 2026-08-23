// Relation Create Schemas

import type { AnyModel } from "@schema/model";
import type { RelationState } from "@schema/relation/types";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
import { type V, v } from "../primitives/v";
import type { GetTargetSchemas, SchemaGetter } from "./helpers";
import {
  nestedRelationDataProjection,
  type ProjectedCreateUpsertUpdate,
  type ProjectedNestedCreate,
} from "./nested-data-projection";
import {
  type ToOneMutationSchema,
  toOneMutationSchema,
} from "./to-one-mutation-schema";

// =============================================================================
// CREATE SCHEMA TYPES (exported for consumer use)
// =============================================================================

type AvailableNestedCreateManySchema<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = V.Object<
  {
    data: () => V.Array<ProjectedNestedCreate<Source, Key, S>>;
    skipDuplicates: V.Boolean<{ optional: true }>;
  },
  { atLeast: ["data"] }
>;

export type NestedCreateManySchema<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = AvailableNestedCreateManySchema<Source, Key, S>;

// =============================================================================
// CREATE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one create: { create?, connect?, connectOrCreate? }
 */
type ToOneCreateEntries<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = {
  create: () => ProjectedNestedCreate<Source, Key, S>;
  connect: () => GetTargetSchemas<S>["core"]["whereUnique"];
  connectOrCreate: V.Object<
    {
      where: () => GetTargetSchemas<S>["core"]["whereUnique"];
      create: () => ProjectedNestedCreate<Source, Key, S>;
    },
    { partial: false }
  >;
};

export type ToOneCreateSchema<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = ToOneMutationSchema<ToOneCreateEntries<Source, Key, S>, { optional: true }>;

export const toOneCreateFactory = <
  Source extends AnyModel,
  Key,
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  resolved: ResolvedSlot,
  targetSchemas: T
): ToOneCreateSchema<Source, Key, S> => {
  const projection = nestedRelationDataProjection<S, T>(
    resolved,
    targetSchemas
  );
  const getCreateSchema = projection.getCreateSchema;

  return toOneMutationSchema(
    {
      create: getCreateSchema,
      connect: () => targetSchemas().core.whereUnique,
      connectOrCreate: v.object(
        {
          where: () => targetSchemas().core.whereUnique,
          create: getCreateSchema,
        },
        { partial: false }
      ),
    },
    { optional: true }
  ) as unknown as ToOneCreateSchema<Source, Key, S>;
};

/**
 * To-many create: { create?, createMany?, connect?, connectOrCreate? }
 * All accept single or array, normalized to array
 * Uses thunks for lazy evaluation to avoid circular reference issues
 *
 * Each createMany row uses the same projected create schema as `create`. The
 * query engine keeps scalar-only rows on its grouped fast path and composes
 * relation-bearing rows as an ordered record series.
 */

export type ToManyCreateSchema<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = V.Object<
  {
    create: () => V.SingleOrArray<ProjectedNestedCreate<Source, Key, S>>;
    createMany: NestedCreateManySchema<Source, Key, S>;
    connect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
    connectOrCreate: () => V.SingleOrArray<
      V.Object<
        {
          where: () => GetTargetSchemas<S>["core"]["whereUnique"];
          create: () => ProjectedNestedCreate<Source, Key, S>;
        },
        { partial: false }
      >
    >;
    // COMPATIBILITY NOTE (deliberate Prisma superset — query-engine-v2 PLAN
    // P−1.2 / ATOM §4): nested `upsert` under a top-level `create` is NOT a
    // Prisma create input. VibORM supports it with GLOBAL-LOOKUP,
    // ADOPT-AND-UPDATE semantics: the target is located by its own unique
    // `where` (no parent correlation is possible under a fresh parent), the
    // found branch adopts it (reparents) and applies `update`, and the missing
    // branch creates it under the new parent. This is the natural completion of
    // the adopt family that `connect`/`connectOrCreate` already provide here.
    // The difference is pinned in docs/content/docs/client/compatibility.mdx;
    // it is never silently divergent.
    upsert: () => V.SingleOrArray<
      V.Object<
        {
          where: () => GetTargetSchemas<S>["core"]["whereUnique"];
          create: () => ProjectedNestedCreate<Source, Key, S>;
          update: () => ProjectedCreateUpsertUpdate<Source, Key, S>;
        },
        { partial: false }
      >
    >;
  },
  { optional: true }
>;

export const toManyCreateFactory = <
  Source extends AnyModel,
  Key,
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  resolved: ResolvedSlot,
  targetSchemas: T
): ToManyCreateSchema<Source, Key, S> => {
  const projection = nestedRelationDataProjection<S, T>(
    resolved,
    targetSchemas
  );
  const getCreateSchema = projection.getCreateSchema;

  const createManySchema = v.object(
    {
      data: () => v.array(getCreateSchema()),
      skipDuplicates: v.boolean({ optional: true }),
    },
    { atLeast: ["data"] }
  );

  return v.object(
    {
      create: () => v.singleOrArray(getCreateSchema()),
      createMany: createManySchema,
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
      // Deliberate Prisma superset (see the type above): global-lookup,
      // adopt-and-update. The engine (query-engine-v2 CreateOperation) owns the
      // adopt semantics; this schema only pins the accepted input surface.
      upsert: () =>
        v.singleOrArray(
          v.object(
            {
              where: () => targetSchemas().core.whereUnique,
              create: getCreateSchema,
              // The agreeing-owned-FK asymmetry, carried as projection data rather than
              // decided here: see {@link ProjectedCreateUpsertUpdate}.
              update: projection.getCreateUpsertUpdateSchema,
            },
            { partial: false }
          )
        ),
    },
    { optional: true }
  ) as unknown as ToManyCreateSchema<Source, Key, S>;
};
