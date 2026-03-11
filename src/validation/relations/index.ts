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
import v from "..";
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
import type { SchemaGetter } from "./helpers";
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

export type GetRelationSchemas<
  S extends RelationState,
  Source extends AnyModel,
> = S["type"] extends "manyToMany" | "oneToMany"
  ? ToManySchemas<S, Source>
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
  const relationsSchemas: Record<string, unknown> = {};
  const relations = source["~"].state.relations;
  for (const relation in relations) {
    const state = relations[relation]!["~"].state;
    const targetSchemas = createSchemasGetter(state) as SchemaGetter<
      typeof state
    >;

    Object.assign(relationsSchemas, {
      [relation]: getRelationSchemas(state, source, targetSchemas),
    });
  }
  return relationsSchemas as GetRelationsSchemas<Source>;
};

export type GetRelationsSchemas<Source extends AnyModel> = {
  [R in keyof Source["~"]["state"]["relations"]]: GetRelationSchemas<
    Source["~"]["state"]["relations"][R]["~"]["state"],
    Source
  >;
};
