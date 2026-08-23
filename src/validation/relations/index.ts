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

import { ValidationError } from "@errors";
import type { AnyModel } from "@schema/model";
import { type AnyRelation, isVariantRelationState } from "@schema/relation";
import type { Cardinality } from "@schema/relation/static-membership";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
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
  Source extends AnyModel,
  Key,
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  relation: AnyRelation,
  resolved: ResolvedSlot,
  targetSchemas: T
) => {
  const state = relation["~"].state as S;
  return {
    filter: v.lazy(() =>
      toOneFilterFactory<Source, Key, S, T>(resolved, targetSchemas)
    ),
    create: v.lazy(() =>
      toOneCreateFactory<Source, Key, S, T>(resolved, targetSchemas)
    ),
    update: v.lazy(() =>
      toOneUpdateFactory<Source, Key, S, T>(state, resolved, targetSchemas)
    ),
    select: v.lazy(() => toOneSelectFactory<S, T>(relation, targetSchemas)),
    include: v.lazy(() => toOneIncludeFactory<S, T>(relation, targetSchemas)),
    orderBy: toOneOrderByFactory<S, T>(relation, targetSchemas),
    countFilter: v.lazy(() => countFilterFactory(state, targetSchemas)),
  };
};

const toManySchemas = <
  Source extends AnyModel,
  Key,
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  relation: AnyRelation,
  resolved: ResolvedSlot,
  targetSchemas: T
) => {
  const state = relation["~"].state as S;
  return {
    filter: v.lazy(() => toManyFilterFactory(state, targetSchemas)),
    create: v.lazy(() =>
      toManyCreateFactory<Source, Key, S, T>(resolved, targetSchemas)
    ),
    update: v.lazy(() =>
      toManyUpdateFactory<Source, Key, S, T>(resolved, targetSchemas)
    ),
    select: v.lazy(() => toManySelectFactory<S, T>(relation, targetSchemas)),
    include: v.lazy(() => toManyIncludeFactory<S, T>(relation, targetSchemas)),
    orderBy: v.lazy(() => toManyOrderByFactory(state)),
    countFilter: v.lazy(() => countFilterFactory(state, targetSchemas)),
  };
};

// =============================================================================
// TYPE INFERENCE
// =============================================================================

export type ToOneSchemas<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = {
  filter: ToOneFilterSchema<Source, Key, S>;
  create: ToOneCreateSchema<Source, Key, S>;
  update: ToOneUpdateSchema<Source, Key, S>;
  select: ToOneSelectSchema<S>;
  include: ToOneIncludeSchema<S>;
  orderBy: ToOneOrderBySchema<S>;
  countFilter: CountFilterSchema<S>;
};

export type ToManySchemas<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = {
  filter: ToManyFilterSchema<S>;
  create: ToManyCreateSchema<Source, Key, S>;
  update: ToManyUpdateSchema<Source, Key, S>;
  select: ToManySelectSchema<S>;
  include: ToManyIncludeSchema<S>;
  orderBy: ToManyOrderBySchema<S>;
  countFilter: CountFilterSchema<S>;
};

/**
 * A relation's schemas are decided by ITS OWN cardinality, and by nothing else.
 *
 * This is the FIRST step of §8.2's dispatch — cardinality, then target kind,
 * then resolved membership. The target-kind step lives one level up
 * (`getPolymorphicRelationsSchemas` owns the variant half's eight families);
 * the membership step lives inside the create/update families, where the
 * projection and the clearability owner answer it.
 *
 * The polymorphic-inverse dispatch that used to live here — a second to-one and a
 * second to-many family, spelled key by key — is gone: what differs about a
 * ROW-HELD variant inverse is which target schema its nested payloads write
 * into and whether its membership can be cleared, and both facts are now the
 * `nested-data-projection` and `clearability` owners', read by the same four
 * verb factories.
 *
 * BOTH COLLECTION INVERSE ARITIES ARE ORDINARY. A variant-bound to-many is a
 * fixed-variant junction VIEW (§9.5): the binder supplies the same
 * `ResolvedJunctionTopology` in reverse orientation, and `RelationJunctionPart` /
 * `JunctionStatements` — written entirely against `membership.source` /
 * `membership.target` — own every verb unchanged. A variant-bound singular slot
 * is one member-junction row under a UNIQUE over the complete variant side,
 * which is a to-one slot with a to-one slot's vocabulary.
 * `RelationJunctionToOnePart` lowers its four correlated spellings, so the
 * ordinary to-one families serve it verbatim and there is nothing left here to
 * substitute.
 *
 * The removal verbs hang on the two derived facts alone — `slotMayBeEmpty` and
 * `membershipCanBeCleared`, both read from the ONE resolved edge — rather than
 * on a declared flag a schema author had to remember to write.
 */
export type GetRelationSchemas<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> =
  Cardinality<S> extends "many"
    ? ToManySchemas<Source, Key, S>
    : ToOneSchemas<Source, Key, S>;

// =============================================================================
// MAIN EXPORT
// =============================================================================

/** Get all schemas for a relation, from its own cardinality. */
export const getRelationSchemas = <
  Source extends AnyModel,
  Key,
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  relation: AnyRelation,
  resolved: ResolvedSlot,
  targetSchemas: T
) => {
  const isToMany = relation["~"].state.cardinality === "many";
  // The bundle builders are left to INFER, so the union each write family really
  // carries is visible inside this function; {@link GetRelationSchemas} is the
  // type-level owner of which arm a given `<Source, Key, S>` lands on, and this is
  // the single seam where the two meet — the same boundary crossing this return
  // has always performed.
  return (isToMany
    ? toManySchemas<Source, Key, S, T>(relation, resolved, targetSchemas)
    : toOneSchemas<Source, Key, S, T>(
        relation,
        resolved,
        targetSchemas
      )) as unknown as GetRelationSchemas<Source, Key, S>;
};

/**
 * Every MODEL-target relation of one model, keyed by its own field key.
 *
 * The key is not decoration: it is the asking-slot identity the static
 * membership projection excludes in step 2, and a projection that dropped it
 * would let a self relation select its own declaration as its inverse.
 */
export const getRelationsSchemas = <Source extends AnyModel>(
  source: Source,
  createSchemasGetter: <S extends RelationState>(
    relation: AnyRelation
  ) => SchemaGetter<S>,
  slots: ReadonlyMap<string, ResolvedSlot>
) => {
  // Build each relation's schemas lazily: a relation's filter/create/update/
  // select/include schemas are only constructed when that relation is first
  // referenced (via `v.fromObject(relations, "<subkey>")`). A query that
  // touches no relations (e.g. findUnique by id) builds none of them.
  const builders: Record<string, () => unknown> = {};
  const relations: Record<string, AnyRelation> = source["~"].state.relations;
  for (const field in relations) {
    const relation = relations[field]!;
    if (isVariantRelationState(relation["~"].state)) continue;
    const resolved = resolvedSlotOrThrow(source, field, slots);
    builders[field] = () => {
      const targetSchemas = createSchemasGetter(relation);
      return getRelationSchemas(relation, resolved, targetSchemas);
    };
  }
  return lazyRecord(builders) as GetRelationsSchemas<Source>;
};

/**
 * The registry's operation schemas ARE topology answers — which mutation verbs a
 * caller may spell, which keys a nested payload owns — so a registry built over
 * an index that does not describe this schema has no answer to give. That is a
 * different failure from an invalid schema (the definition gate owns that one):
 * it means two different schema objects were composed at one boundary.
 */
const resolvedSlotOrThrow = (
  source: AnyModel,
  field: string,
  slots: ReadonlyMap<string, ResolvedSlot>
): ResolvedSlot => {
  const resolved = slots.get(field);
  if (resolved) return resolved;
  const model = source["~"].names.ts ?? "model";
  throw new ValidationError({ kind: "registry", property: field }, [
    {
      path: `${model}.${field}`,
      message: `The resolved relation index does not describe '${model}.${field}'`,
    },
  ]);
};

/** The MODEL-target keys of a relation map — the half this module owns. */
type ModelRelationKeys<Relations> = {
  [Key in keyof Relations]: Relations[Key] extends {
    readonly "~": {
      readonly state: { readonly target: { readonly kind: "variants" } };
    };
  }
    ? never
    : Key;
}[keyof Relations];

export type GetRelationsSchemas<Source extends AnyModel> = {
  [R in ModelRelationKeys<
    Source["~"]["state"]["relations"]
  >]: GetRelationSchemas<
    Source,
    R,
    Source["~"]["state"]["relations"][R]["~"]["state"]
  >;
};
