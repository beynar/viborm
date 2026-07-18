// Relation Create Schemas

import type { AnyModel } from "@schema/model";
import type {
  GetInverseRelationMap,
  RelationState,
} from "@schema/relation/types";
import { type V, v } from "../primitives/v";
import type { ScalarSchemas } from "../model";
import {
  getNestedScalarCreateWithOmittedRequiredKeys,
  type NestedScalarCreateWithOmittedRequiredKeys,
} from "../model/core/create";
import type { GetTargetSchemas, SchemaGetter, TargetModel } from "./helpers";

// =============================================================================
// CREATE SCHEMA TYPES (exported for consumer use)
// =============================================================================

export type CreateWithOmittedFk<
  S extends RelationState,
  Source extends AnyModel,
> = V.Omit<
  GetTargetSchemas<S>["core"]["create"],
  Extract<
    GetInverseRelationMap<S, Source>,
    readonly (keyof GetTargetSchemas<S>["core"]["create"]["entries"])[]
  >
>;

type InverseRelationMap<
  S extends RelationState,
  Source extends AnyModel,
> = S extends {
  type: "manyToOne" | "oneToOne";
  fields: readonly (infer ScalarKey extends string)[];
}
  ? ScalarKey
  : S extends { name: infer RelationName extends string }
    ? ScalarsForRelationKey<TargetModel<S>, RelationName> extends never
      ? ScannedInverseRelationMap<S, Source>
      : ScalarsForRelationKey<TargetModel<S>, RelationName>
    : ScannedInverseRelationMap<S, Source>;

type ScalarsForRelationKey<
  M extends AnyModel,
  RelationName extends string,
> = RelationName extends keyof M["~"]["state"]["relations"]
  ? M["~"]["state"]["relations"][RelationName]["~"]["state"] extends {
      fields: readonly (infer ScalarKey extends string)[];
    }
    ? ScalarKey
    : never
  : never;

type ScannedInverseRelationMap<
  S extends RelationState,
  Source extends AnyModel,
> = {
  [K in KnownKeys<
    TargetModel<S>["~"]["state"]["relations"]
  >]: TargetModel<S>["~"]["state"]["relations"][K]["~"]["state"] extends infer InverseState
    ? InverseState extends {
        type: "manyToOne" | "oneToOne";
        getter: () => Source;
        fields: readonly (infer ScalarKey extends string)[];
      }
      ? S extends { name: infer RelationName extends string }
        ? InverseState extends { name: RelationName }
          ? ScalarKey
          : never
        : ScalarKey
      : never
    : never;
}[KnownKeys<TargetModel<S>["~"]["state"]["relations"]>];

type KnownKeys<T> = {
  [K in keyof T]: string extends K ? never : number extends K ? never : K;
}[keyof T];

export type InverseRequiredKeys<
  S extends RelationState,
  Source extends AnyModel,
> = readonly InverseRelationMap<S, Source>[];

export type CreateManyDataSchema<
  S extends RelationState,
  Source extends AnyModel,
> = NestedScalarCreateWithOmittedRequiredKeys<
  TargetModel<S>,
  ScalarSchemas<TargetModel<S>>,
  InverseRequiredKeys<S, Source>
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
    connectOrCreate: V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["whereUnique"];
        create: () => CreateWithOmittedFk<S, Source>;
      },
      { partial: false }
    >;
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
    const fkFields = getInverseRelationMapRuntime(state, source);
    return v.omit(targetSchemas().core.create, fkFields);
  };

  return v.object(
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
 * Note: createMany uses scalarCreate (no nested relations) because
 * nested creates within createMany are not supported.
 */

export type ToManyCreateSchema<
  S extends RelationState,
  Source extends AnyModel,
> = V.Object<
  {
    create: () => V.SingleOrArray<CreateWithOmittedFk<S, Source>>;
    createMany: V.Object<
      {
        data: () => V.Array<CreateManyDataSchema<S, Source>>;
        skipDuplicates: V.Boolean<{ optional: true }>;
      },
      { atLeast: ["data"] }
    >;
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
          create: () => CreateWithOmittedFk<S, Source>;
          update: () => GetTargetSchemas<S>["core"]["update"];
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
    const fkFields = getInverseRelationMapRuntime(state, source);
    return v.omit(targetSchemas().core.create, fkFields);
  };

  const getCreateManyDataSchema = (): CreateManyDataSchema<S, Source> => {
    const targetModel = state.getter() as TargetModel<S>;
    const fkFields = (getInverseRelationMapRuntime(state, source) ??
      []) as InverseRequiredKeys<S, Source>;
    const schemas = targetSchemas();
    return getNestedScalarCreateWithOmittedRequiredKeys<
      TargetModel<S>,
      ScalarSchemas<TargetModel<S>>,
      InverseRequiredKeys<S, Source>
    >(
      targetModel,
      {
        scalars: schemas.scalars,
        relations: schemas.relations,
      },
      fkFields
    );
  };

  return v.object(
    {
      create: () => v.singleOrArray(getCreateSchema()),
      // createMany only accepts scalar fields - no nested relation mutations
      createMany: v.object(
        {
          data: () => v.array(getCreateManyDataSchema()),
          skipDuplicates: v.boolean({ optional: true }),
        },
        { atLeast: ["data"] }
      ),
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
              update: () => targetSchemas().core.update,
            },
            { partial: false }
          )
        ),
    },
    { optional: true }
  ) as unknown as ToManyCreateSchema<S, Source>;
};

// Helper to get FK fields at runtime (moved from helpers.ts inline usage)
import { getInverseRelationMap as getInverseRelationMapRuntime } from "@schema/relation/types";
