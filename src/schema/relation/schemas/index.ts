// Relation Schema Factories
// Builds filter, create, update schemas for relations using Valibot
import type { RelationState } from "../relation";

export { countFilterFactory } from "./count-filter";
export { toManyCreateFactory, toOneCreateFactory } from "./create";
export { toManyFilterFactory, toOneFilterFactory } from "./filter";
// Re-export helpers and types
export {
  getTargetCreateSchema,
  getTargetUpdateSchema,
  getTargetWhereSchema,
  getTargetWhereUniqueSchema,
  singleOrArray,
} from "./helpers";
export { toManyOrderByFactory, toOneOrderByFactory } from "./order-by";
// Re-export individual schema factories
export {
  toManyIncludeFactory,
  toManySelectFactory,
  toOneIncludeFactory,
  toOneSelectFactory,
} from "./select-include";
export { toManyUpdateFactory, toOneUpdateFactory } from "./update";

import { countFilterFactory } from "./count-filter";
import { toManyCreateFactory, toOneCreateFactory } from "./create";
import { toManyFilterFactory, toOneFilterFactory } from "./filter";
import { toManyOrderByFactory, toOneOrderByFactory } from "./order-by";
// Import for internal use
import {
  toManyIncludeFactory,
  toManySelectFactory,
  toOneIncludeFactory,
  toOneSelectFactory,
} from "./select-include";
import { toManyUpdateFactory, toOneUpdateFactory } from "./update";

// =============================================================================
// SCHEMA BUNDLES
// =============================================================================

const toOneSchemas = <S extends RelationState>(state: S): ToOneSchemas<S> => {
  return {
    filter: toOneFilterFactory(state),
    create: toOneCreateFactory(state),
    update: toOneUpdateFactory(state),
    select: toOneSelectFactory(state),
    include: toOneIncludeFactory(state),
    orderBy: toOneOrderByFactory(state),
    countFilter: countFilterFactory(state),
  };
};

const toManySchemas = <S extends RelationState>(state: S): ToManySchemas<S> => {
  return {
    filter: toManyFilterFactory(state),
    create: toManyCreateFactory(state),
    update: toManyUpdateFactory(state),
    select: toManySelectFactory(state),
    include: toManyIncludeFactory(state),
    orderBy: toManyOrderByFactory(state),
    countFilter: countFilterFactory(state),
  };
};

// =============================================================================
// TYPE INFERENCE
// =============================================================================

export type ToOneSchemas<S extends RelationState> = {
  filter: ReturnType<typeof toOneFilterFactory<S>>;
  create: ReturnType<typeof toOneCreateFactory<S>>;
  update: ReturnType<typeof toOneUpdateFactory<S>>;
  select: ReturnType<typeof toOneSelectFactory<S>>;
  include: ReturnType<typeof toOneIncludeFactory<S>>;
  orderBy: ReturnType<typeof toOneOrderByFactory<S>>;
  countFilter: ReturnType<typeof countFilterFactory<S>>;
};

export type ToManySchemas<S extends RelationState> = {
  filter: ReturnType<typeof toManyFilterFactory<S>>;
  create: ReturnType<typeof toManyCreateFactory<S>>;
  update: ReturnType<typeof toManyUpdateFactory<S>>;
  select: ReturnType<typeof toManySelectFactory<S>>;
  include: ReturnType<typeof toManyIncludeFactory<S>>;
  orderBy: ReturnType<typeof toManyOrderByFactory<S>>;
  countFilter: ReturnType<typeof countFilterFactory<S>>;
};

export type InferRelationSchemas<S extends RelationState> = S["type"] extends
  | "manyToMany"
  | "oneToMany"
  ? ToManySchemas<S>
  : ToOneSchemas<S>;

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * Get all schemas for a relation based on its type
 */

export const getRelationSchemas = <S extends RelationState>(state: S) => {
  const isToMany = state.type === "manyToMany" || state.type === "oneToMany";
  return (
    isToMany ? toManySchemas(state) : toOneSchemas(state)
  ) as InferRelationSchemas<S>;
};

/**
 * Infer input type for a specific relation schema
 */
export type InferRelationInput<
  S extends RelationState,
  Type extends
    | "filter"
    | "create"
    | "update"
    | "select"
    | "include"
    | "orderBy"
    | "countFilter",
> = InferRelationSchemas<S>[Type];
