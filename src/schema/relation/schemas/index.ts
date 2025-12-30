// Relation Schema Factories
// Builds filter, create, update schemas for relations using Valibot
import type { RelationState } from "../relation";

// Re-export helpers and types
export {
  type AnyRelationSchema,
  getTargetWhereSchema,
  getTargetWhereUniqueSchema,
  getTargetCreateSchema,
  getTargetUpdateSchema,
  singleOrArray,
} from "./helpers";

// Re-export individual schema factories
export {
  toOneSelectFactory,
  toManySelectFactory,
  toOneIncludeFactory,
  toManyIncludeFactory,
} from "./select-include";

export { toOneOrderByFactory, toManyOrderByFactory } from "./order-by";

export { toOneFilterFactory, toManyFilterFactory } from "./filter";

export { toOneCreateFactory, toManyCreateFactory } from "./create";

export { toOneUpdateFactory, toManyUpdateFactory } from "./update";

export { countFilterFactory } from "./count-filter";

// Import for internal use
import {
  toOneSelectFactory,
  toManySelectFactory,
  toOneIncludeFactory,
  toManyIncludeFactory,
} from "./select-include";
import { toOneOrderByFactory, toManyOrderByFactory } from "./order-by";
import { toOneFilterFactory, toManyFilterFactory } from "./filter";
import { toOneCreateFactory, toManyCreateFactory } from "./create";
import { toOneUpdateFactory, toManyUpdateFactory } from "./update";
import { countFilterFactory } from "./count-filter";

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
    | "countFilter"
> = InferRelationSchemas<S>[Type];
