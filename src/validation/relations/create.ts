// Relation Create Schemas

import type { AnyModel } from "@schema/model";
import type {
  GetInverseRelationMap,
  RelationState,
} from "@schema/relation/types";
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

/**
 * The keys of a target schema the ENCLOSING relation owns: the inverse relation's
 * foreign-key fields, narrowed to the keys that schema actually has.
 *
 * This module owns the omitted-FK lineage for BOTH nested contexts. `core.create` and
 * `core.update` carry the same relation-owned columns, and a nested payload may not name
 * them in either one, for one reason: the enclosing step DERIVES that column from the
 * record it acted on, so a spelled value is a second provenance for it. The polymorphic
 * edge states the same rule over its relation key, and both readings are SELECTED by
 * one owner ({@link file://./nested-data-projection.ts}) — this alias is that owner's
 * ordinary arm, not a second answer.
 */
type OmittedInverseFkKeys<
  S extends RelationState,
  Source extends AnyModel,
  Entries,
> = Extract<GetInverseRelationMap<S, Source>, readonly (keyof Entries)[]>;

export type CreateWithOmittedFk<
  S extends RelationState,
  Source extends AnyModel,
> = V.Omit<
  GetTargetSchemas<S>["core"]["create"],
  OmittedInverseFkKeys<
    S,
    Source,
    GetTargetSchemas<S>["core"]["create"]["entries"]
  >
>;

/**
 * Does the TARGET row hold this relation's foreign key? Only then is a spelled column a
 * SECOND provenance for the value the enclosing step's fold derives.
 *
 * `getInverseRelationMap` answers two different questions under one name: for a to-one
 * with `.fields()` it returns THIS side's own fields, and for every other shape it scans
 * the TARGET for a to-one back-reference. Only the second answer names a column on the
 * row a nested payload writes.
 *
 * MEASURED, and deliberately NOT changed here: `CreateWithOmittedFk` applies the map
 * without this narrowing, so a nested CREATE over-omits in two shapes the engine has no
 * fold for — a `manyToMany` arm (the junction holds membership; the scan finds an
 * unrelated to-one back-reference, e.g. `post.tags.create` cannot spell `featuredPostId`)
 * and a SELF-REFERENTIAL parent-held to-one (`node.parent.create` cannot spell its own
 * `parentId`). Both refuse at HEAD, predate this package, and widening them is a
 * capability lift with its own measurement — recorded for the guard-ownership ledger,
 * not folded into N1, which may only make the parse agree with the engine.
 *
 * The runtime twin is the projection owner's module-private
 * `targetHoldsInverseFk` ({@link file://./nested-data-projection.ts}).
 */
type TargetHoldsInverseFk<S extends RelationState> =
  S["type"] extends "manyToMany"
    ? false
    : S extends { fields: readonly [string, ...string[]] }
      ? false
      : true;

/**
 * The UPDATE-side application of the owner above (Package N1). Nested update data —
 * the to-one `update` and `upsert` arms, the to-many `update`, `updateMany` and `upsert`
 * arms — is built from this, so the relation-owned foreign key is not a key the caller
 * can spell there, exactly as it has never been spellable in a nested create.
 *
 * NOT applied to the to-many `upsert` arm of a CREATE context
 * ({@link ToManyCreateSchema}): the engine ABSORBS an agreeing spelling there
 * (`RelationUpsertPart.withoutAgreeingOwnedFk`), which is a capability, and only
 * a create root whose own key is spelled has a value to agree with.
 */
export type UpdateWithOmittedFk<
  S extends RelationState,
  Source extends AnyModel,
> =
  TargetHoldsInverseFk<S> extends true
    ? V.Omit<
        GetTargetSchemas<S>["core"]["update"],
        OmittedInverseFkKeys<
          S,
          Source,
          GetTargetSchemas<S>["core"]["update"]["entries"]
        >
      >
    : GetTargetSchemas<S>["core"]["update"];

type AvailableNestedCreateManySchema<
  S extends RelationState,
  Source extends AnyModel,
> = V.Object<
  {
    data: () => V.Array<ProjectedNestedCreate<S, Source>>;
    skipDuplicates: V.Boolean<{ optional: true }>;
  },
  { atLeast: ["data"] }
>;

export type NestedCreateManySchema<
  S extends RelationState,
  Source extends AnyModel,
> = AvailableNestedCreateManySchema<S, Source>;

// =============================================================================
// CREATE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one create: { create?, connect?, connectOrCreate? }
 */
type ToOneCreateEntries<S extends RelationState, Source extends AnyModel> = {
  create: () => ProjectedNestedCreate<S, Source>;
  connect: () => GetTargetSchemas<S>["core"]["whereUnique"];
  connectOrCreate: V.Object<
    {
      where: () => GetTargetSchemas<S>["core"]["whereUnique"];
      create: () => ProjectedNestedCreate<S, Source>;
    },
    { partial: false }
  >;
};

export type ToOneCreateSchema<
  S extends RelationState,
  Source extends AnyModel,
> = ToOneMutationSchema<ToOneCreateEntries<S, Source>, { optional: true }>;

export const toOneCreateFactory = <
  S extends RelationState,
  Source extends AnyModel,
  T extends SchemaGetter<S>,
>(
  state: S,
  source: Source,
  targetSchemas: T
): ToOneCreateSchema<S, Source> => {
  const projection = nestedRelationDataProjection(state, source, targetSchemas);
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
  ) as unknown as ToOneCreateSchema<S, Source>;
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
  S extends RelationState,
  Source extends AnyModel,
> = V.Object<
  {
    create: () => V.SingleOrArray<ProjectedNestedCreate<S, Source>>;
    createMany: NestedCreateManySchema<S, Source>;
    connect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
    connectOrCreate: () => V.SingleOrArray<
      V.Object<
        {
          where: () => GetTargetSchemas<S>["core"]["whereUnique"];
          create: () => ProjectedNestedCreate<S, Source>;
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
          create: () => ProjectedNestedCreate<S, Source>;
          update: () => ProjectedCreateUpsertUpdate<S, Source>;
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
  const projection = nestedRelationDataProjection(state, source, targetSchemas);
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
  ) as unknown as ToManyCreateSchema<S, Source>;
};
