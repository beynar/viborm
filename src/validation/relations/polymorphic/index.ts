import type { AnyModel } from "@schema/model";
import {
  type AnyPolymorphicRelation,
  type PolymorphicCardinalityOf,
  type PolymorphicRelationState,
  polymorphicCardinality,
} from "@schema/relation";
import { lazyRecord } from "@validation/lazy";
import type { ModelSchemas } from "@validation/model";
import type { VibSchema } from "@validation/types";

export {
  type PolymorphicCollectionCreateInput,
  type PolymorphicCollectionCreateOutput,
  type PolymorphicCollectionCreateSchema,
  type PolymorphicCollectionUpdateInput,
  type PolymorphicCollectionUpdateOutput,
  type PolymorphicCollectionUpdateSchema,
  polymorphicCollectionCreateFactory,
  polymorphicCollectionUpdateFactory,
} from "./collection-mutation";
export {
  type PolymorphicCollectionCountFilterSchema,
  polymorphicCollectionCountFilterFactory,
} from "./count-filter";
export {
  type PolymorphicCreateInput,
  type PolymorphicCreateOutput,
  type PolymorphicCreateSchema,
  polymorphicCreateFactory,
} from "./create";
export {
  type PolymorphicCreateManySchema,
  polymorphicCreateManyFactory,
} from "./create-many";
export {
  type PolymorphicCollectionFilterSchema,
  type PolymorphicFilterSchema,
  polymorphicCollectionFilterFactory,
  polymorphicFilterFactory,
} from "./filter";
export {
  type PolymorphicCollectionOrderBySchema,
  polymorphicCollectionOrderByFactory,
} from "./order-by";
export {
  type PolymorphicCollectionIncludeSchema,
  type PolymorphicCollectionProjectionInput,
  type PolymorphicCollectionProjectionOutput,
  type PolymorphicCollectionSelectSchema,
  type PolymorphicIncludeSchema,
  type PolymorphicProjectionInput,
  type PolymorphicProjectionOutput,
  type PolymorphicSelectSchema,
  polymorphicCollectionIncludeFactory,
  polymorphicCollectionSelectFactory,
  polymorphicIncludeFactory,
  polymorphicSelectFactory,
} from "./select-include";
export {
  type TaggedPredicateInput,
  type TaggedPredicateOutput,
  taggedTargetPredicate,
} from "./tagged-predicate";
export type {
  ExactPolymorphicTargetSchemaGetters,
  PolymorphicTargetSchemaGetters,
} from "./types";
export {
  type PolymorphicUpdateSchema,
  polymorphicUpdateFactory,
} from "./update";

import {
  type PolymorphicCollectionCreateSchema,
  type PolymorphicCollectionUpdateSchema,
  polymorphicCollectionCreateFactory,
  polymorphicCollectionUpdateFactory,
} from "./collection-mutation";
import {
  type PolymorphicCollectionCountFilterSchema,
  polymorphicCollectionCountFilterFactory,
  polymorphicToOneCountFilterRefusal,
} from "./count-filter";
import {
  type PolymorphicCreateSchema,
  polymorphicCreateFactory,
} from "./create";
import {
  type PolymorphicCreateManySchema,
  polymorphicCreateManyFactory,
} from "./create-many";
import {
  type PolymorphicCollectionFilterSchema,
  type PolymorphicFilterSchema,
  polymorphicCollectionFilterFactory,
  polymorphicFilterFactory,
} from "./filter";
import {
  type PolymorphicCollectionOrderBySchema,
  polymorphicCollectionOrderByFactory,
  polymorphicToOneOrderByRefusal,
} from "./order-by";
import {
  type PolymorphicCollectionSelectSchema,
  type PolymorphicIncludeSchema,
  type PolymorphicSelectSchema,
  polymorphicCollectionIncludeFactory,
  polymorphicCollectionSelectFactory,
  polymorphicIncludeFactory,
  polymorphicSelectFactory,
} from "./select-include";
import type { PolymorphicTargetSchemaGetters } from "./types";
import {
  type PolymorphicUpdateSchema,
  polymorphicUpdateFactory,
} from "./update";

type TargetModel<
  State extends PolymorphicRelationState,
  PublicType extends keyof State["targets"],
> = State["targets"][PublicType] extends () => infer Target
  ? Target extends AnyModel
    ? Target
    : never
  : never;

export type RegisteredPolymorphicTargetSchemas<
  State extends PolymorphicRelationState,
> = {
  readonly [PublicType in keyof State["targets"]]: () => ModelSchemas<
    TargetModel<State, PublicType>
  >;
};

/** A family that exists so it can EXPLAIN itself, and accepts nothing. */
type RefusedFamily = VibSchema<never, never>;

/** The eight families a polymorphic TO-ONE slot offers. */
export interface PolymorphicToOneRelationSchemas<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
> {
  readonly filter: PolymorphicFilterSchema<State, Getters>;
  readonly create: PolymorphicCreateSchema<Getters>;
  readonly createMany: PolymorphicCreateManySchema<Getters>;
  readonly update: PolymorphicUpdateSchema<State, Getters>;
  readonly select: PolymorphicSelectSchema<Getters>;
  readonly include: PolymorphicIncludeSchema<Getters>;
  readonly orderBy: RefusedFamily;
  readonly countFilter: RefusedFamily;
}

/** The eight families a polymorphic COLLECTION offers. */
export interface PolymorphicCollectionRelationSchemas<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
> {
  readonly filter: PolymorphicCollectionFilterSchema<Getters>;
  readonly create: PolymorphicCollectionCreateSchema<Getters>;
  /**
   * The ROOT-`createMany` ROW context. It is not the `createMany` VERB — that
   * lives inside the two bags above — it is the shape a bulk ROW may spell for
   * this key, and it is the SAME family `create` offers.
   *
   * A collection row is relation-BEARING (plan §9.6): `routing.ts`'s
   * `relationBearingRow` now answers true for a polymorphic collection key
   * through `isPolymorphicCollectionRelation`, so the whole call routes to the
   * relation-bearing record series and the member junction inserts follow the
   * owner root. The direct polymorphic TO-ONE row keeps its narrower
   * connect-only union and its grouped INSERT.
   */
  readonly createMany: PolymorphicCollectionCreateSchema<Getters>;
  readonly update: PolymorphicCollectionUpdateSchema<Getters>;
  readonly select: PolymorphicCollectionSelectSchema<Getters>;
  readonly include: PolymorphicCollectionSelectSchema<Getters>;
  readonly orderBy: PolymorphicCollectionOrderBySchema;
  readonly countFilter: PolymorphicCollectionCountFilterSchema<Getters>;
}

/**
 * ONE dispatch, both levels. The runtime reads
 * {@link polymorphicCardinality}; the type reads its twin
 * {@link PolymorphicCardinalityOf}. Neither tests `state.cardinality` inline.
 */
export type PolymorphicRelationSchemas<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
> = PolymorphicCardinalityOf<State> extends "many"
  ? PolymorphicCollectionRelationSchemas<State, Getters>
  : PolymorphicToOneRelationSchemas<State, Getters>;

export type GetPolymorphicRelationsSchemas<Source extends AnyModel> = {
  readonly [RelationKey in keyof Source["~"]["state"]["polymorphicRelations"]]: Source["~"]["state"]["polymorphicRelations"][RelationKey]["~"]["state"] extends infer State extends
    PolymorphicRelationState
    ? PolymorphicRelationSchemas<
        State,
        RegisteredPolymorphicTargetSchemas<State>
      >
    : never;
};

function getTargetSchemas<State extends PolymorphicRelationState>(
  relation: AnyPolymorphicRelation,
  resolve: (model: AnyModel) => ModelSchemas<AnyModel>
): RegisteredPolymorphicTargetSchemas<State> {
  const getters: Record<string, () => ModelSchemas<AnyModel>> = {};
  for (const entry of relation["~"].targetEntries()) {
    getters[entry.publicType] = () => resolve(entry.targetModel as AnyModel);
  }
  return getters as unknown as RegisteredPolymorphicTargetSchemas<State>;
}

/**
 * THE GRAMMAR OWNER of what a polymorphic slot offers, per cardinality.
 *
 * B3 built NO families at all for a collection group: `v.object` is strict, so
 * one omission turned every collection key into an unknown-key refusal on all
 * six surfaces at once. That was the right lock while no storage backed the
 * key. Package C changes the boundary, not the discipline:
 *
 *   READS LAND. `where` takes `{ some | every | none }` over the tagged target
 *   predicate; `select` / `include` take the collection envelope
 *   (`{ only, variants }`); `orderBy` takes `{ _count }`; `_count` takes the
 *   filtered count. All four are backed by the per-variant member junction
 *   tables B2/B3 resolved at definition validation.
 *
 *   PACKAGE D LANDS THE NESTED WRITES. `create` and `update` are now the real
 *   tagged verb bags (`collection-mutation.ts`), so the relation-mutation parser
 *   DOES see a collection payload — the fourth `ParsedRelationMutation` arm — and
 *   the direct collection coordinator lowers it. `upsert` works transitively
 *   through both halves.
 *
 *   PACKAGE E LANDS THE ROOT-`createMany` ROW. The bulk row now mounts the SAME
 *   `create` family, because `routing.ts`'s `relationBearingRow` answers true for
 *   a collection key (through `isPolymorphicCollectionRelation`) and sends the
 *   whole call to the relation-bearing record series, where the member junction
 *   inserts follow the owner root. The silent-drop hazard the old refusal closed
 *   is now closed by the ROUTE; `bulk-polymorphic-connect.ts`'s narrowing throw
 *   stays as the engine-side closer for a scope built directly.
 *
 * WHY THE FAMILY KEY SET STAYS AT EIGHT (D1), even though nothing here is
 * refused any more. The key set must be IDENTICAL across cardinalities:
 * `v.fromObject` throws at schema-build time when a non-empty source record
 * matches no entries, so a model whose only polymorphic relation is a collection
 * would break `create` / `createMany` / `update` the instant those paths ran
 * `fromObject` over a record that had a `select` family but no `create` one —
 * and symmetrically for `orderBy` / `countFilter` on an all-to-one model. Eight
 * families, always present, keeps `fromObject` total with no primitive changes.
 * The two remaining `v.refused` entries (to-one `orderBy` / `countFilter`) hold
 * that line for the other cardinality.
 *
 * ONE GUARD: the engine's own union-narrowing throws stay, but they own a
 * DIFFERENT invariant ("no unvalidated storage enters SQL compilation") and are
 * reachable only through a directly-built scope. Nothing downstream re-checks
 * cardinality on this axis.
 *
 * The TYPE half dispatches on the same fact through `PolymorphicCardinalityOf`,
 * so the B3 type-advertises / runtime-refuses skew is closed: both halves now
 * say collection reads AND collection writes work.
 */

export function getPolymorphicRelationsSchemas<Source extends AnyModel>(
  source: Source,
  resolve: (model: AnyModel) => ModelSchemas<AnyModel>
): GetPolymorphicRelationsSchemas<Source> {
  const builders: Record<string, () => unknown> = {};
  for (const relationKey of Object.keys(
    source["~"].state.polymorphicRelations
  )) {
    const relation = source["~"].state.polymorphicRelations[relationKey]!;
    builders[relationKey] = () => {
      const state = relation["~"].state;
      const targets = getTargetSchemas<typeof state>(relation, resolve);
      if (polymorphicCardinality(state) === "many") {
        return lazyRecord({
          filter: () => polymorphicCollectionFilterFactory(state, targets),
          create: () => polymorphicCollectionCreateFactory(state, targets),
          createMany: () => polymorphicCollectionCreateFactory(state, targets),
          update: () => polymorphicCollectionUpdateFactory(state, targets),
          select: () => polymorphicCollectionSelectFactory(relation, targets),
          include: () => polymorphicCollectionIncludeFactory(relation, targets),
          orderBy: () => polymorphicCollectionOrderByFactory(),
          countFilter: () =>
            polymorphicCollectionCountFilterFactory(state, targets),
        });
      }
      return lazyRecord({
        filter: () => polymorphicFilterFactory(state, targets),
        create: () => polymorphicCreateFactory(state, targets),
        createMany: () => polymorphicCreateManyFactory(state, targets),
        update: () => polymorphicUpdateFactory(state, targets),
        select: () => polymorphicSelectFactory(relation, targets),
        include: () => polymorphicIncludeFactory(relation, targets),
        orderBy: () => polymorphicToOneOrderByRefusal(),
        countFilter: () => polymorphicToOneCountFilterRefusal(),
      });
    };
  }
  return lazyRecord(builders) as GetPolymorphicRelationsSchemas<Source>;
}
