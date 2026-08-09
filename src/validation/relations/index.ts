// Relation Schema Factories
// Builds filter, create, update schemas for relations using Valibot
import type { RelationState } from "@schema/relation/types";

export { countFilterFactory } from "./count-filter";
export { toManyCreateFactory, toOneCreateFactory } from "./create";
export { toManyFilterFactory, toOneFilterFactory } from "./filter";
export { toManyOrderByFactory, toOneOrderByFactory } from "./order-by";
// Re-export individual schema factories
export {
  toManyIncludeFactory,
  toManySelectFactory,
  toOneIncludeFactory,
  toOneSelectFactory,
} from "./select-include";
export {
  toManyUpdateFactory,
  toOneUpdateFactory,
  toOneUpdateTargetFactory,
} from "./update";

import type { AnyModel } from "@schema/model";
import {
  type GetPolymorphicInverseBinding,
  getPolymorphicInverseBinding,
} from "@schema/relation/polymorphic";
import v, { type V } from "..";
import { lazyRecord } from "../lazy";
import type { ScalarSchemas } from "../model";
import {
  getNestedScalarCreateWithOmittedRequiredKeys,
  type NestedScalarCreateWithOmittedRequiredKeys,
} from "../model/core/create";
import { type CountFilterSchema, countFilterFactory } from "./count-filter";
import {
  type ToManyCreateSchema,
  type ToOneCreateSchema,
  toManyCreateFactory,
  toOneCreateFactory,
} from "./create";
import {
  applyCreateManyAvailability,
  type CreateManyAvailability,
} from "./create-many-availability";
import {
  type ToManyFilterSchema,
  type ToOneFilterSchema,
  toManyFilterFactory,
  toOneFilterFactory,
} from "./filter";
import type { GetTargetSchemas, SchemaGetter, TargetModel } from "./helpers";
import {
  type ToManyOrderBySchema,
  type ToOneOrderBySchema,
  toManyOrderByFactory,
  toOneOrderByFactory,
} from "./order-by";
// Import for internal use
import {
  type ToManyIncludeSchema,
  type ToManySelectSchema,
  type ToOneIncludeSchema,
  type ToOneSelectSchema,
  toManyIncludeFactory,
  toManySelectFactory,
  toOneIncludeFactory,
  toOneSelectFactory,
} from "./select-include";
import {
  type ToManyUpdateSchema,
  type ToOneUpdateSchema,
  type ToOneUpdateTargetWithDataSchema,
  toManyUpdateFactory,
  toOneUpdateFactory,
  toOneUpdateTargetFactory,
} from "./update";

// =============================================================================
// SCHEMA BUNDLES
// =============================================================================

const toOneSchemas = <
  S extends RelationState,
  Source extends AnyModel,
  T extends SchemaGetter<S>,
>(
  state: S,
  source: Source,
  targetSchemas: T
): ToOneSchemas<S, Source> => {
  return {
    filter: v.lazy(() => toOneFilterFactory(state, targetSchemas)),
    create: v.lazy(() => toOneCreateFactory(state, source, targetSchemas)),
    update: v.lazy(() => toOneUpdateFactory(state, source, targetSchemas)),
    select: v.lazy(() => toOneSelectFactory(state, targetSchemas)),
    include: v.lazy(() => toOneIncludeFactory(state, targetSchemas)),
    orderBy: toOneOrderByFactory(state, targetSchemas),
    countFilter: v.lazy(() => countFilterFactory(state, targetSchemas)),
  };
};

const toManySchemas = <
  S extends RelationState,
  Source extends AnyModel,
  T extends SchemaGetter<S>,
>(
  state: S,
  source: Source,
  targetSchemas: T
): ToManySchemas<S, Source> => {
  return {
    filter: v.lazy(() => toManyFilterFactory(state, targetSchemas)),
    create: v.lazy(() => toManyCreateFactory(state, source, targetSchemas)),
    update: v.lazy(() => toManyUpdateFactory(state, source, targetSchemas)),
    select: v.lazy(() => toManySelectFactory(state, targetSchemas)),
    include: v.lazy(() => toManyIncludeFactory(state, targetSchemas)),
    orderBy: v.lazy(() => toManyOrderByFactory(state)),
    countFilter: v.lazy(() => countFilterFactory(state, targetSchemas)),
  };
};

// =============================================================================
// TYPE INFERENCE
// =============================================================================

export type ToOneSchemas<S extends RelationState, Source extends AnyModel> = {
  filter: ToOneFilterSchema<S>;
  create: ToOneCreateSchema<S, Source>;
  update: ToOneUpdateSchema<S, Source>;
  select: ToOneSelectSchema<S>;
  include: ToOneIncludeSchema<S>;
  orderBy: ToOneOrderBySchema<S>;
  countFilter: CountFilterSchema<S>;
};

export type ToManySchemas<S extends RelationState, Source extends AnyModel> = {
  filter: ToManyFilterSchema<S>;
  create: ToManyCreateSchema<S, Source>;
  update: ToManyUpdateSchema<S, Source>;
  select: ToManySelectSchema<S>;
  include: ToManyIncludeSchema<S>;
  orderBy: ToManyOrderBySchema<S>;
  countFilter: CountFilterSchema<S>;
};

type PolymorphicInverseBindingFor<
  S extends RelationState,
  Source extends AnyModel,
> = GetPolymorphicInverseBinding<TargetModel<S>, Source, S["name"]>;

type PolymorphicInverseRelationKey<
  S extends RelationState,
  Source extends AnyModel,
> = [PolymorphicInverseBindingFor<S, Source>] extends [never]
  ? never
  : PolymorphicInverseBindingFor<S, Source> extends {
        readonly relationKey: infer RelationKey;
      }
    ? Extract<
        RelationKey,
        string & keyof GetTargetSchemas<S>["core"]["create"]["entries"]
      >
    : never;

type HasExactPolymorphicInverse<
  S extends RelationState,
  Source extends AnyModel,
> = [PolymorphicInverseRelationKey<S, Source>] extends [never]
  ? false
  : string extends PolymorphicInverseRelationKey<S, Source>
    ? false
    : true;

type HasNamedTargetPolymorphicRelations<S extends RelationState> =
  string extends keyof TargetModel<S>["~"]["state"]["polymorphicRelations"]
    ? false
    : [keyof TargetModel<S>["~"]["state"]["polymorphicRelations"]] extends [
          never,
        ]
      ? false
      : true;

type PolymorphicInverseCreateTarget<
  S extends RelationState,
  Source extends AnyModel,
> = V.Omit<
  GetTargetSchemas<S>["core"]["create"],
  readonly [PolymorphicInverseRelationKey<S, Source>]
>;

type PolymorphicInverseUpdateTarget<
  S extends RelationState,
  Source extends AnyModel,
> = V.Omit<
  GetTargetSchemas<S>["core"]["update"],
  readonly [
    Extract<
      PolymorphicInverseRelationKey<S, Source>,
      keyof GetTargetSchemas<S>["core"]["update"]["entries"]
    >,
  ]
>;

type PolymorphicInverseRelationState<
  S extends RelationState,
  Source extends AnyModel,
> = PolymorphicInverseRelationKey<S, Source> extends infer RelationKey
  ? RelationKey extends keyof TargetModel<S>["~"]["state"]["polymorphicRelations"]
    ? TargetModel<S>["~"]["state"]["polymorphicRelations"][RelationKey]["~"]["state"]
    : never
  : never;

type PolymorphicMembershipCanBeCleared<
  S extends RelationState,
  Source extends AnyModel,
> = [PolymorphicInverseRelationState<S, Source>] extends [never]
  ? false
  : PolymorphicInverseRelationState<S, Source> extends { optional: true }
    ? true
    : false;

type PolymorphicInverseCreateManyData<S extends RelationState> =
  NestedScalarCreateWithOmittedRequiredKeys<
    TargetModel<S>,
    ScalarSchemas<TargetModel<S>>,
    readonly []
  >;

type AvailablePolymorphicInverseCreateMany<S extends RelationState> = V.Object<
  {
    data: () => V.Array<PolymorphicInverseCreateManyData<S>>;
    skipDuplicates: V.Boolean<{ optional: true }>;
  },
  { atLeast: ["data"] }
>;

type PolymorphicInverseCreateMany<
  S extends RelationState,
  Source extends AnyModel,
> = CreateManyAvailability<
  TargetModel<S>,
  AvailablePolymorphicInverseCreateMany<S>,
  PolymorphicInverseRelationKey<S, Source>
>;

type PolymorphicInverseCreateEntries<
  S extends RelationState,
  Source extends AnyModel,
> = {
  create: () => V.SingleOrArray<PolymorphicInverseCreateTarget<S, Source>>;
  createMany: PolymorphicInverseCreateMany<S, Source>;
  connect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
  connectOrCreate: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["whereUnique"];
        create: () => PolymorphicInverseCreateTarget<S, Source>;
      },
      { partial: false }
    >
  >;
  upsert: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["whereUnique"];
        create: () => PolymorphicInverseCreateTarget<S, Source>;
        update: () => PolymorphicInverseUpdateTarget<S, Source>;
      },
      { partial: false }
    >
  >;
};

type PolymorphicInverseUpdateEntries<
  S extends RelationState,
  Source extends AnyModel,
> = Omit<PolymorphicInverseCreateEntries<S, Source>, "upsert"> & {
  delete: () => V.SingleOrArray<
    GetTargetSchemas<S>["core"]["whereUniqueExtended"]
  >;
  update: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["whereUniqueExtended"];
        data: () => PolymorphicInverseUpdateTarget<S, Source>;
      },
      { atLeast: ["where", "data"] }
    >
  >;
  updateMany: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["where"];
        data: () => PolymorphicInverseUpdateTarget<S, Source>;
      },
      { atLeast: ["data"] }
    >
  >;
  upsert: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["whereUniqueExtended"];
        create: () => PolymorphicInverseCreateTarget<S, Source>;
        update: () => PolymorphicInverseUpdateTarget<S, Source>;
      },
      { partial: false }
    >
  >;
  deleteMany: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["where"]>;
};

type OptionalPolymorphicInverseUpdateEntries<S extends RelationState> = {
  disconnect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
  set: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
};

type PolymorphicInverseToManySchemas<
  S extends RelationState,
  Source extends AnyModel,
> = Omit<ToManySchemas<S, Source>, "create" | "update"> & {
  create: V.Object<
    PolymorphicInverseCreateEntries<S, Source>,
    { optional: true }
  >;
  update: V.Object<
    PolymorphicInverseUpdateEntries<S, Source> &
      (PolymorphicMembershipCanBeCleared<S, Source> extends true
        ? OptionalPolymorphicInverseUpdateEntries<S>
        : Record<never, never>)
  >;
};

type PolymorphicInverseToOneCreateEntries<
  S extends RelationState,
  Source extends AnyModel,
> = {
  create: () => PolymorphicInverseCreateTarget<S, Source>;
  connect: () => GetTargetSchemas<S>["core"]["whereUnique"];
  connectOrCreate: V.Object<
    {
      where: () => GetTargetSchemas<S>["core"]["whereUnique"];
      create: () => PolymorphicInverseCreateTarget<S, Source>;
    },
    { partial: false }
  >;
};

type PolymorphicInverseToOneUpdateEntries<
  S extends RelationState,
  Source extends AnyModel,
> = PolymorphicInverseToOneCreateEntries<S, Source> & {
  update: () => ToOneUpdateTargetWithDataSchema<
    S,
    PolymorphicInverseUpdateTarget<S, Source>
  >;
  upsert: V.Object<
    {
      create: () => PolymorphicInverseCreateTarget<S, Source>;
      update: () => PolymorphicInverseUpdateTarget<S, Source>;
    },
    { partial: false }
  >;
};

type ClearablePolymorphicInverseToOneUpdateEntries = {
  disconnect: V.Boolean;
};

type EmptyPolymorphicInverseToOneUpdateEntries = {
  delete: V.Boolean;
};

type PolymorphicInverseToOneSchemas<
  S extends RelationState,
  Source extends AnyModel,
> = Omit<ToOneSchemas<S, Source>, "create" | "update"> & {
  create: V.Object<
    PolymorphicInverseToOneCreateEntries<S, Source>,
    { optional: true }
  >;
  update: V.Object<
    PolymorphicInverseToOneUpdateEntries<S, Source> &
      (S["optional"] extends true
        ? EmptyPolymorphicInverseToOneUpdateEntries &
            (PolymorphicMembershipCanBeCleared<S, Source> extends true
              ? ClearablePolymorphicInverseToOneUpdateEntries
              : Record<never, never>)
        : Record<never, never>)
  >;
};

export type GetRelationSchemas<
  S extends RelationState,
  Source extends AnyModel,
> = S["type"] extends "manyToMany" | "oneToMany"
  ? S["type"] extends "oneToMany"
    ? HasNamedTargetPolymorphicRelations<S> extends true
      ? HasExactPolymorphicInverse<S, Source> extends true
        ? PolymorphicInverseToManySchemas<S, Source>
        : ToManySchemas<S, Source>
      : ToManySchemas<S, Source>
    : ToManySchemas<S, Source>
  : S["type"] extends "oneToOne"
    ? S extends { fields: readonly string[] }
      ? ToOneSchemas<S, Source>
      : HasNamedTargetPolymorphicRelations<S> extends true
        ? HasExactPolymorphicInverse<S, Source> extends true
          ? PolymorphicInverseToOneSchemas<S, Source>
          : ToOneSchemas<S, Source>
        : ToOneSchemas<S, Source>
    : ToOneSchemas<S, Source>;

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * Get all schemas for a relation based on its type
 */

export const getRelationSchemas = <
  S extends RelationState,
  Source extends AnyModel,
  T extends SchemaGetter<S>,
>(
  state: S,
  source: Source,
  targetSchemas: T
) => {
  const isToMany = state.type === "manyToMany" || state.type === "oneToMany";
  let inverseBinding:
    | ReturnType<typeof getPolymorphicInverseBinding>
    | undefined;
  let inverseBindingResolved = false;
  const getInverseMutationSchemas = () => {
    if (!inverseBindingResolved) {
      inverseBinding = getPolymorphicInverseBinding(
        state.getter(),
        source,
        state.name
      );
      inverseBindingResolved = true;
    }
    if (!inverseBinding) return undefined;
    const targetModel: TargetModel<S> = state.getter();
    const runtimeTargetModel: AnyModel = state.getter();
    const membershipCanBeCleared =
      runtimeTargetModel["~"].state.polymorphicRelations[
        inverseBinding.relationKey
      ]?.["~"].state.optional === true;
    const relationKey = inverseBinding.relationKey;
    const getCreateSchema = () =>
      v.omit(targetSchemas().core.create, [relationKey]);
    const getUpdateSchema = () =>
      v.omit(targetSchemas().core.update, [relationKey]);
    const getCreateManyDataSchema = () => {
      const target = targetSchemas();
      const noOmittedRequiredKeys: readonly [] = [];
      return getNestedScalarCreateWithOmittedRequiredKeys(
        targetModel,
        {
          scalars: target.scalars,
          relations: target.relations,
          polymorphic: target.polymorphic,
        },
        noOmittedRequiredKeys
      );
    };
    return {
      membershipCanBeCleared,
      getCreateSchema,
      getUpdateSchema,
      createMany: applyCreateManyAvailability(
        targetModel,
        v.object(
          {
            data: () => v.array(getCreateManyDataSchema()),
            skipDuplicates: v.boolean({ optional: true }),
          },
          { atLeast: ["data"] }
        ),
        relationKey
      ),
      connectOrCreate: v.object(
        {
          where: () => targetSchemas().core.whereUnique,
          create: getCreateSchema,
        },
        { partial: false }
      ),
      createUpsert: v.object(
        {
          where: () => targetSchemas().core.whereUnique,
          create: getCreateSchema,
          update: getUpdateSchema,
        },
        { partial: false }
      ),
    };
  };
  if (state.type === "oneToMany") {
    const schemas = toManySchemas(state, source, targetSchemas);
    return {
      ...schemas,
      create: v.lazy(() => {
        const inverse = getInverseMutationSchemas();
        if (!inverse) return schemas.create;
        return v.object(
          {
            create: () => v.singleOrArray(inverse.getCreateSchema()),
            createMany: inverse.createMany,
            connect: () => v.singleOrArray(targetSchemas().core.whereUnique),
            connectOrCreate: v.singleOrArray(inverse.connectOrCreate),
            upsert: v.singleOrArray(inverse.createUpsert),
          },
          { optional: true }
        );
      }),
      update: v.lazy(() => {
        const inverse = getInverseMutationSchemas();
        if (!inverse) return schemas.update;
        const update = v.singleOrArray(
          v.object(
            {
              where: () => targetSchemas().core.whereUniqueExtended,
              data: inverse.getUpdateSchema,
            },
            { atLeast: ["where", "data"] }
          )
        );
        const updateMany = v.singleOrArray(
          v.object(
            {
              where: () => targetSchemas().core.where,
              data: inverse.getUpdateSchema,
            },
            { atLeast: ["data"] }
          )
        );
        const upsert = v.singleOrArray(
          v.object(
            {
              where: () => targetSchemas().core.whereUniqueExtended,
              create: inverse.getCreateSchema,
              update: inverse.getUpdateSchema,
            },
            { partial: false }
          )
        );
        const entries = v.object({
          create: () => v.singleOrArray(inverse.getCreateSchema()),
          createMany: inverse.createMany,
          connect: () => v.singleOrArray(targetSchemas().core.whereUnique),
          delete: () =>
            v.singleOrArray(targetSchemas().core.whereUniqueExtended),
          connectOrCreate: v.singleOrArray(inverse.connectOrCreate),
          update,
          updateMany,
          upsert,
          deleteMany: () => v.singleOrArray(targetSchemas().core.where),
        });
        return inverse.membershipCanBeCleared
          ? entries.extend({
              disconnect: () =>
                v.singleOrArray(targetSchemas().core.whereUnique),
              set: () => v.singleOrArray(targetSchemas().core.whereUnique),
            })
          : entries;
      }),
    } as unknown as GetRelationSchemas<S, Source>;
  }
  if (
    state.type === "oneToOne" &&
    (state.fields === undefined || state.fields.length === 0)
  ) {
    const schemas = toOneSchemas(state, source, targetSchemas);
    return {
      ...schemas,
      create: v.lazy(() => {
        const inverse = getInverseMutationSchemas();
        if (!inverse) return schemas.create;
        return v.object(
          {
            create: inverse.getCreateSchema,
            connect: () => targetSchemas().core.whereUnique,
            connectOrCreate: inverse.connectOrCreate,
          },
          { optional: true }
        );
      }),
      update: v.lazy(() => {
        const inverse = getInverseMutationSchemas();
        if (!inverse) return schemas.update;
        const entries = v.object({
          create: inverse.getCreateSchema,
          connect: () => targetSchemas().core.whereUnique,
          connectOrCreate: inverse.connectOrCreate,
          update: () =>
            toOneUpdateTargetFactory<
              S,
              T,
              ReturnType<typeof inverse.getUpdateSchema>
            >(targetSchemas, inverse.getUpdateSchema),
          upsert: v.object(
            {
              create: inverse.getCreateSchema,
              update: inverse.getUpdateSchema,
            },
            { partial: false }
          ),
        });
        return inverse.membershipCanBeCleared
          ? entries.extend({ disconnect: v.boolean(), delete: v.boolean() })
          : entries.extend({ delete: v.boolean() });
      }),
    } as unknown as GetRelationSchemas<S, Source>;
  }
  return (
    isToMany
      ? toManySchemas(state, source, targetSchemas)
      : toOneSchemas(state, source, targetSchemas)
  ) as GetRelationSchemas<S, Source>;
};

/**
 * Get all relations schemas for a given model
 */
export const getRelationsSchemas = <Source extends AnyModel>(
  source: Source,
  createSchemasGetter: <S extends RelationState>(state: S) => SchemaGetter<S>
) => {
  // Build each relation's schemas lazily: a relation's filter/create/update/
  // select/include schemas are only constructed when that relation is first
  // referenced (via `v.fromObject(relations, "<subkey>")`). A query that
  // touches no relations (e.g. findUnique by id) builds none of them.
  const builders: Record<string, () => unknown> = {};
  const relations = source["~"].state.relations;
  for (const relation in relations) {
    const state = relations[relation]!["~"].state;
    builders[relation] = () => {
      const targetSchemas = createSchemasGetter(state) as SchemaGetter<
        typeof state
      >;
      return getRelationSchemas(state, source, targetSchemas);
    };
  }
  return lazyRecord(builders) as GetRelationsSchemas<Source>;
};

export type GetRelationsSchemas<Source extends AnyModel> = {
  [R in keyof Source["~"]["state"]["relations"]]: GetRelationSchemas<
    Source["~"]["state"]["relations"][R]["~"]["state"],
    Source
  >;
};
