// Nested relation-data projection — ONE owner, both levels.
//
// A nested payload never writes into the target model's own `core.create` /
// `core.update`: it writes into the projection of those schemas that the ENCLOSING
// relation leaves for the caller. Two edges answer "what does the enclosing step
// already own" differently — an ordinary inverse owns the target's foreign-key
// SCALARS, a polymorphic inverse owns the target's direct RELATION KEY — and until
// this module existed each answer had its own verb factories.
//
// This is the one place that difference is decided. The verb factories
// (`toOne/toMany` × `create/update`) consume the projection blindly, so a surface
// that used to be a clone is now the same factory with a different projection.
// One selected-arm exception is also owned here: an update-root to-many
// `upsert.update` may spell a polymorphic inverse's relation key because the engine
// has already selected that exact incoming parent and carries its row continuity.
// Ordinary update/updateMany and every create surface keep the omission.
//
// What this module deliberately does NOT own: whether the membership it projects can
// be CLEARED. That is a schema fact about storage, not a fact about which keys a
// nested payload may spell, and its owner is `@schema/relation/clearability` — read
// there by the update factories, which are its only consumers.

import type { AnyModel } from "@schema/model";
import {
  type CanBindPolymorphicInverse,
  canBindPolymorphicInverse,
  getPolymorphicInverseBinding,
} from "@schema/relation/inverse";
import type { GetPolymorphicInverseBinding } from "@schema/relation/polymorphic";
import type { RelationState } from "@schema/relation/types";
import { getInverseRelationMap } from "@schema/relation/types";
import { type V, v } from "../primitives/v";
import type { CreateWithOmittedFk, UpdateWithOmittedFk } from "./create";
import type { GetTargetSchemas, SchemaGetter, TargetModel } from "./helpers";

// =============================================================================
// WHICH EDGE — the one dispatch
// =============================================================================

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

/**
 * The ONE type-level question the projection asks.
 *
 * The shape gate is the schema layer's ({@link canBindPolymorphicInverse}); what this
 * adds is the OMISSION obligation — the resolved relation key must be a key the
 * target's create schema actually has, because that key is what `V.Omit` removes.
 * `clearability.ts` asks the same first question and then a different second one (is
 * that relation's own membership state readable), which is why the two spellings are
 * not one: they share the gate, not the obligation.
 */
export type HasPolymorphicInverse<
  S extends RelationState,
  Source extends AnyModel,
> = CanBindPolymorphicInverse<S> extends true
  ? HasNamedTargetPolymorphicRelations<S> extends true
    ? HasExactPolymorphicInverse<S, Source>
    : false
  : false;

// =============================================================================
// THE POLYMORPHIC ARM
// =============================================================================

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

/** A correlated to-many upsert found arm has selected-row continuity back to its
 * enclosing polymorphic parent. That one arm may therefore re-enter the direct
 * relation key; ordinary update/updateMany payloads still omit it. */
type PolymorphicInverseSelectedUpsertUpdateTarget<S extends RelationState> =
  GetTargetSchemas<S>["core"]["update"];

// =============================================================================
// THE PROJECTION — one alias, one instantiation per relation
// =============================================================================

/**
 * Every projected fact of one nesting context, computed ONCE per `<S, Source>`.
 *
 * Deliberately a single record rather than one conditional per verb: the
 * polymorphic-vs-ordinary question is the expensive one (it resolves the target
 * model's inverse binding through the schema graph), and a per-verb spelling would
 * instantiate it six times for every relation in the schema.
 */
export type NestedRelationDataProjection<
  S extends RelationState,
  Source extends AnyModel,
> = HasPolymorphicInverse<S, Source> extends true
  ? {
      create: PolymorphicInverseCreateTarget<S, Source>;
      update: PolymorphicInverseUpdateTarget<S, Source>;
      selectedUpsertUpdate: PolymorphicInverseSelectedUpsertUpdateTarget<S>;
      createUpsertUpdate: PolymorphicInverseUpdateTarget<S, Source>;
    }
  : {
      create: CreateWithOmittedFk<S, Source>;
      update: UpdateWithOmittedFk<S, Source>;
      selectedUpsertUpdate: UpdateWithOmittedFk<S, Source>;
      createUpsertUpdate: GetTargetSchemas<S>["core"]["update"];
    };

/** The target schema a nested `create` payload writes into. */
export type ProjectedNestedCreate<
  S extends RelationState,
  Source extends AnyModel,
> = NestedRelationDataProjection<S, Source>["create"];

/** The target schema nested UPDATE data writes into (Package N1's omission). */
export type ProjectedNestedUpdate<
  S extends RelationState,
  Source extends AnyModel,
> = NestedRelationDataProjection<S, Source>["update"];

/** The update branch of a to-many upsert under an update root. Only this branch
 * carries the selected incoming-parent continuity needed to expose an inverse
 * polymorphic relation key safely. */
export type ProjectedSelectedUpsertUpdate<
  S extends RelationState,
  Source extends AnyModel,
> = NestedRelationDataProjection<S, Source>["selectedUpsertUpdate"];

/**
 * The `upsert.update` arm of a to-many payload under a CREATE root, and the one
 * place the two edges deliberately disagree: the ordinary edge keeps the target's
 * BARE `core.update` because the engine ABSORBS an agreeing owned foreign key there
 * (`RelationUpsertPart.withoutAgreeingOwnedFk`), while a polymorphic
 * membership has no spellable column to agree with and keeps the projection.
 * Neither direction may be "unified" into the other.
 */
export type ProjectedCreateUpsertUpdate<
  S extends RelationState,
  Source extends AnyModel,
> = NestedRelationDataProjection<S, Source>["createUpsertUpdate"];

// =============================================================================
// RUNTIME
// =============================================================================

type AnyObjectSchema = V.Object<any, any>;

/** The runtime twin of {@link NestedRelationDataProjection}. */
export interface NestedRelationDataSchemas {
  /** `v.omit(core.create, <what the enclosing edge owns>)`. */
  readonly getCreateSchema: () => AnyObjectSchema;
  /** The same omission applied to nested UPDATE data, gated per edge. */
  readonly getUpdateSchema: () => AnyObjectSchema;
  /** The selected found arm may re-enter an inverse polymorphic owner. */
  readonly getSelectedUpsertUpdateSchema: () => AnyObjectSchema;
  /** See {@link ProjectedCreateUpsertUpdate} — the agreeing-owned-FK asymmetry. */
  readonly getCreateUpsertUpdateSchema: () => AnyObjectSchema;
}

/**
 * Does the TARGET row hold this relation's foreign key? Only then is a spelled
 * column a SECOND provenance for the value the enclosing step's fold derives. The
 * type twin is `TargetHoldsInverseFk` ({@link file://./create.ts}); this is the one
 * runtime reading of it.
 */
const targetHoldsInverseFk = (state: RelationState): boolean =>
  state.type !== "manyToMany" &&
  (state.fields === undefined || state.fields.length === 0);

/**
 * Build the projection for one nesting context.
 *
 * LAZINESS IS A NON-TERMINATION HAZARD, not a performance note. This function
 * resolves `state.getter()` — cheap, schema-layer state only — but every schema it
 * returns is a THUNK, because materializing the target model's `core.create` while
 * the enclosing model's schemas are still under construction never terminates for a
 * self-referential relation. Call it from inside a verb factory (each of which is
 * itself reached through `v.lazy`), never from `getRelationSchemas`: the pin is
 * `polymorphic.core.test.ts` "inverse topology stays lazy until create validation",
 * which counts ZERO target-getter invocations after `core.create` is merely READ.
 */
export const nestedRelationDataProjection = <
  S extends RelationState,
  Source extends AnyModel,
  T extends SchemaGetter<S>,
>(
  state: S,
  source: Source,
  targetSchemas: T
): NestedRelationDataSchemas => {
  const binding = canBindPolymorphicInverse(state)
    ? getPolymorphicInverseBinding(state.getter(), source, state.name)
    : undefined;

  if (binding) {
    const relationKey = binding.relationKey;
    const getCreateSchema = () =>
      v.omit(targetSchemas().core.create as unknown as AnyObjectSchema, [
        relationKey,
      ]);
    // A polymorphic inverse is ALWAYS child-held, so the omission needs no gate.
    const getUpdateSchema = () =>
      v.omit(targetSchemas().core.update as unknown as AnyObjectSchema, [
        relationKey,
      ]);
    return {
      getCreateSchema,
      getUpdateSchema,
      getSelectedUpsertUpdateSchema: () =>
        targetSchemas().core.update as unknown as AnyObjectSchema,
      getCreateUpsertUpdateSchema: getUpdateSchema,
    };
  }

  const getCreateSchema = () =>
    v.omit(
      targetSchemas().core.create as unknown as AnyObjectSchema,
      getInverseRelationMap(state, source) as unknown as
        | readonly string[]
        | undefined
    );
  const getUpdateSchema = () =>
    v.omit(
      targetSchemas().core.update as unknown as AnyObjectSchema,
      (targetHoldsInverseFk(state)
        ? getInverseRelationMap(state, source)
        : undefined) as unknown as readonly string[] | undefined
    );
  return {
    getCreateSchema,
    getUpdateSchema,
    getSelectedUpsertUpdateSchema: getUpdateSchema,
    getCreateUpsertUpdateSchema: () =>
      targetSchemas().core.update as unknown as AnyObjectSchema,
  };
};
