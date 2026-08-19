// Relation Schema Factories
// Builds filter, create, update schemas for relations using Valibot
import { relationCardinality } from "@schema/relation/cardinality";
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
import { lazyRecord } from "../lazy";
import v from "../primitives/v";
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
) => {
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
) => {
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

/**
 * A relation's schemas are decided by ITS OWN cardinality, and by nothing else.
 *
 * The polymorphic-inverse dispatch that used to live here — a second to-one and a
 * second to-many family, spelled key by key — is gone: what differs about a
 * ROW-HELD polymorphic inverse is which target schema its nested payloads write
 * into and whether its membership can be cleared, and both facts are now the
 * `nested-data-projection` owner's, read by the same four verb factories.
 *
 * BOTH COLLECTION INVERSE ARITIES ARE ORDINARY. A polymorphic-bound `manyToMany`
 * is a fixed-variant ordinary junction VIEW (§9.5): the binder supplies the same
 * `ResolvedJunctionTopology` in reverse orientation, and `RelationJunctionPart` /
 * `JunctionStatements` — written entirely against `membership.source` /
 * `membership.target` — own every verb unchanged. A polymorphic-bound `manyToOne`
 * is the SINGULAR slot (§9.4): its membership is one member-junction row under a
 * UNIQUE over the complete variant side, which is a to-one slot with a to-one
 * slot's vocabulary. `RelationJunctionToOnePart` lowers its four correlated
 * spellings — `disconnect: true` deletes THE junction row, `delete: true` deletes
 * the single connected owner, `update`/`upsert` correlate — so the ordinary to-one
 * families serve it verbatim and there is nothing left here to substitute.
 *
 * The removal verbs still hang on the SLOT fact alone (`slotMayBeEmpty`), which
 * `P021` makes true by construction for this shape rather than hoping a schema
 * author wrote `.optional()`.
 */
export type GetRelationSchemas<
  S extends RelationState,
  Source extends AnyModel,
> = S["type"] extends "manyToMany" | "oneToMany"
  ? ToManySchemas<S, Source>
  : ToOneSchemas<S, Source>;

// =============================================================================
// MAIN EXPORT
// =============================================================================

/** Get all schemas for a relation based on its type. */
export const getRelationSchemas = <
  S extends RelationState,
  Source extends AnyModel,
  T extends SchemaGetter<S>,
>(
  state: S,
  source: Source,
  targetSchemas: T
) => {
  const isToMany = relationCardinality(state) === "many";
  // The bundle builders are left to INFER, so the union each write family really
  // carries is visible inside this function; {@link GetRelationSchemas} is the
  // type-level owner of which arm a given `<S, Source>` lands on, and this is the
  // single seam where the two meet — the same boundary crossing this return has
  // always performed.
  return (isToMany
    ? toManySchemas(state, source, targetSchemas)
    : toOneSchemas(
        state,
        source,
        targetSchemas
      )) as unknown as GetRelationSchemas<S, Source>;
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
