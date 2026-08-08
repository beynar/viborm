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
export { toManyUpdateFactory, toOneUpdateFactory } from "./update";

import type { AnyModel } from "@schema/model";
import {
  type GetPolymorphicInverseBinding,
  getPolymorphicInverseBinding,
} from "@schema/relation/polymorphic";
import v, { type V } from "..";
import { lazyRecord } from "../lazy";
import { type CountFilterSchema, countFilterFactory } from "./count-filter";
import {
  type ToManyCreateSchema,
  type ToOneCreateSchema,
  toManyCreateFactory,
  toOneCreateFactory,
} from "./create";
import {
  type ToManyFilterSchema,
  type ToOneFilterSchema,
  toManyFilterFactory,
  toOneFilterFactory,
} from "./filter";
import type {
  GetTargetSchemas,
  SchemaGetter,
  TargetModel,
} from "./helpers";
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
  toManyUpdateFactory,
  toOneUpdateFactory,
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
        keyof GetTargetSchemas<S>["core"]["create"]["entries"]
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

type PolymorphicInverseCreateEntries<
  S extends RelationState,
  Source extends AnyModel,
> = {
  create: () => V.SingleOrArray<
    PolymorphicInverseCreateTarget<S, Source>
  >;
};

type PolymorphicInverseToManySchemas<
  S extends RelationState,
  Source extends AnyModel,
> = Omit<ToManySchemas<S, Source>, "create" | "update"> & {
  create: V.Object<
    PolymorphicInverseCreateEntries<S, Source>,
    { optional: true }
  >;
  update: V.Object<PolymorphicInverseCreateEntries<S, Source>>;
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
  if (state.type === "oneToMany") {
    const schemas = toManySchemas(state, source, targetSchemas);
    let inverseBinding:
      | ReturnType<typeof getPolymorphicInverseBinding>
      | undefined;
    let inverseBindingResolved = false;
    const getInverseBinding = () => {
      if (!inverseBindingResolved) {
        inverseBinding = getPolymorphicInverseBinding(
          state.getter(),
          source,
          state.name
        );
        inverseBindingResolved = true;
      }
      return inverseBinding;
    };
    const getInverseCreateSchema = () => {
      const binding = getInverseBinding();
      if (!binding) return undefined;
      const getCreateSchema = () =>
        v.omit(targetSchemas().core.create, [binding.relationKey]);
      return { getCreateSchema };
    };
    return {
      ...schemas,
      create: v.lazy(() => {
        const inverse = getInverseCreateSchema();
        if (!inverse) return schemas.create;
        return v.object(
          { create: () => v.singleOrArray(inverse.getCreateSchema()) },
          { optional: true }
        );
      }),
      update: v.lazy(() => {
        const inverse = getInverseCreateSchema();
        if (!inverse) return schemas.update;
        return v.object({
          create: () => v.singleOrArray(inverse.getCreateSchema()),
        });
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
