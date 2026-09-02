// Nested relation-data projection — ONE owner, both levels.
//
// A nested payload never writes into the target model's own `core.create` /
// `core.update`: it writes into the projection of those schemas that the ENCLOSING
// relation leaves for the caller. Two edges answer "what does the enclosing step
// already own" differently — an inverse stored reference owns the target's
// foreign-key COLUMNS, a variant inverse owns the target's CARRIER RELATION KEY —
// and until this module existed each answer had its own verb factories.
//
// This is the one place that difference is decided, and it is decided from ONE
// input: the membership of the asking slot. The type half reads the static
// projection (`@schema/relation/static-membership`), the runtime half reads the
// resolved edge. Neither scans the target model's declarations, invokes a getter,
// or reconstructs a binding.
//
// The verb factories (`toOne/toMany` × `create/update`) consume the projection
// blindly, so a surface that used to be a clone is now the same factory with a
// different projection.

import type { AnyModel } from "@schema/model";
import type {
  DerivedNestedKeys,
  StaticResolvedMembership,
} from "@schema/relation/static-membership";
import type { RelationState } from "@schema/relation/types";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
import { type V, v } from "../primitives/v";
import type { GetTargetSchemas, SchemaGetter } from "./helpers";

// =============================================================================
// WHAT THE ENCLOSING STEP OWNS — one question, asked once per nesting context
// =============================================================================

/**
 * How the enclosing step records this membership on the TARGET row.
 *
 *  - `columns` — an inverse-held foreign key. The keys are writable scalars.
 *  - `carrier` — a variant carrier. The one key is that carrier's relation field.
 *  - `none` — the asking slot holds the membership itself, or the graph is
 *    unproven. Nothing on the target row is derived, so nothing is omitted.
 */
type OwnershipKind<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = StaticResolvedMembership<Source, Key, S> extends infer Membership
  ? Membership extends {
      readonly kind: "foreignKey";
      readonly owner: "inverse";
    }
    ? "columns"
    : Membership extends { readonly kind: "variantInverse" }
      ? "carrier"
      : "none"
  : never;

/**
 * The keys of the TARGET's schemas that the enclosing step already owns.
 *
 * Narrowed to keys the schema actually HAS, because that intersection is what
 * `V.Omit` removes: a derived column the target's schema does not expose (a
 * model-level `.omit()`, a generated column) is already absent, and naming it
 * would make the omission list a claim about a key that is not there.
 */
type OwnedTargetKeys<
  Source extends AnyModel,
  Key,
  S extends RelationState,
  Entries,
> = Extract<DerivedNestedKeys<Source, Key, S>, keyof Entries>;

type CreateWithOwnedKeysOmitted<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = V.Omit<
  GetTargetSchemas<S>["core"]["create"],
  readonly [
    OwnedTargetKeys<
      Source,
      Key,
      S,
      GetTargetSchemas<S>["core"]["create"]["entries"]
    >,
  ]
>;

type UpdateWithOwnedKeysOmitted<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = V.Omit<
  GetTargetSchemas<S>["core"]["update"],
  readonly [
    OwnedTargetKeys<
      Source,
      Key,
      S,
      GetTargetSchemas<S>["core"]["update"]["entries"]
    >,
  ]
>;

// =============================================================================
// THE TWO RE-ENTRY EXCEPTIONS
// =============================================================================
//
// An omitted key may be spelled again only where re-entering it cannot create a
// SECOND PROVENANCE for the membership the enclosing step has already bound.
// That single rule produces exactly two cells, one per ownership kind, and they
// are on opposite verbs:
//
//  - `columns` on a CREATE root: the engine ABSORBS an agreeing owned foreign
//    key (`RelationUpsertPart.withoutAgreeingOwnedFk`), and only a create root
//    whose own key is spelled has a value to agree with. A carrier relation key
//    is not a column and has no value to agree with, so the exception does not
//    apply to it.
//  - `carrier` on an UPDATE root's SELECTED arm: the engine has already located
//    that exact incoming parent and carries its row continuity, so re-entering
//    the carrier relation is a second write to a bound parent, not a second
//    claim about which parent. A writable foreign-key COLUMN in the same place
//    could repoint the row, so it stays omitted.
//
// Both are retained behavior. Neither direction may be "unified" into the other.

/** The update arm of a to-many `upsert` under an UPDATE root. */
type SelectedUpsertUpdate<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = OwnershipKind<Source, Key, S> extends "carrier"
  ? GetTargetSchemas<S>["core"]["update"]
  : UpdateWithOwnedKeysOmitted<Source, Key, S>;

/** The update arm of a to-many `upsert` under a CREATE root. */
type CreateUpsertUpdate<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = OwnershipKind<Source, Key, S> extends "columns"
  ? GetTargetSchemas<S>["core"]["update"]
  : UpdateWithOwnedKeysOmitted<Source, Key, S>;

// =============================================================================
// THE PROJECTION — one alias, one instantiation per relation
// =============================================================================

/**
 * Every projected fact of one nesting context, computed ONCE per
 * `<Source, Key, S>`.
 *
 * Deliberately a single record rather than one conditional per verb: proving
 * the pairing through the schema graph is the expensive question, and a
 * per-verb spelling would instantiate it six times for every relation in the
 * schema.
 */
export interface NestedRelationDataProjection<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> {
  create: CreateWithOwnedKeysOmitted<Source, Key, S>;
  update: UpdateWithOwnedKeysOmitted<Source, Key, S>;
  selectedUpsertUpdate: SelectedUpsertUpdate<Source, Key, S>;
  createUpsertUpdate: CreateUpsertUpdate<Source, Key, S>;
}

/** The target schema a nested `create` payload writes into. */
export type ProjectedNestedCreate<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = NestedRelationDataProjection<Source, Key, S>["create"];

/** The target schema nested UPDATE data writes into. */
export type ProjectedNestedUpdate<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = NestedRelationDataProjection<Source, Key, S>["update"];

/** See the re-entry rule above. */
export type ProjectedSelectedUpsertUpdate<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = NestedRelationDataProjection<Source, Key, S>["selectedUpsertUpdate"];

/** See the re-entry rule above. */
export type ProjectedCreateUpsertUpdate<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = NestedRelationDataProjection<Source, Key, S>["createUpsertUpdate"];

// =============================================================================
// RUNTIME
// =============================================================================

type AnyObjectSchema = V.Object<any, any>;

/** The runtime twin of {@link NestedRelationDataProjection}. */
export interface NestedRelationDataSchemas {
  /** `v.omit(core.create, <what the enclosing edge owns>)`. */
  readonly getCreateSchema: () => AnyObjectSchema;
  /** The same omission applied to nested UPDATE data. */
  readonly getUpdateSchema: () => AnyObjectSchema;
  /** See {@link ProjectedSelectedUpsertUpdate}. */
  readonly getSelectedUpsertUpdateSchema: () => AnyObjectSchema;
  /** See {@link ProjectedCreateUpsertUpdate}. */
  readonly getCreateUpsertUpdateSchema: () => AnyObjectSchema;
}

type Ownership = {
  readonly kind: "columns" | "carrier" | "none";
  readonly keys: readonly string[];
};

const NOTHING_OWNED: Ownership = { kind: "none", keys: [] };

/** `(model, field)` is the whole contextual identity of a slot. */
const isAskingSlot = (
  resolved: ResolvedSlot,
  candidate: { readonly source: AnyModel; readonly field: string }
): boolean =>
  candidate.source === resolved.slot.source &&
  candidate.field === resolved.slot.field;

/**
 * The runtime twin of {@link OwnershipKind} + {@link DerivedNestedKeys}, read
 * from the resolved edge.
 *
 * An asking-held foreign key names columns on the SOURCE row, which a nested
 * TARGET payload could not spell anyway, so it owns nothing here — that is the
 * exact-omission rule (§11.2.21), not an oversight: a self parent/children pair
 * omits `parentId` from `children.create` and from nothing else.
 */
const ownedByEnclosingStep = (resolved: ResolvedSlot): Ownership => {
  const edge = resolved.edge;
  if (edge.kind === "foreignKey") {
    return isAskingSlot(resolved, edge.owner)
      ? NOTHING_OWNED
      : {
          kind: "columns",
          keys: edge.reference.members.map((member) => member.foreignField),
        };
  }
  if (
    edge.kind === "variantRowCarrier" ||
    edge.kind === "variantJunctionCarrier"
  ) {
    return isAskingSlot(resolved, edge.carrier)
      ? NOTHING_OWNED
      : { kind: "carrier", keys: [edge.carrier.field] };
  }
  // A junction row records the membership; no key on either row does.
  return NOTHING_OWNED;
};

/**
 * Build the projection for one nesting context.
 *
 * LAZINESS IS A NON-TERMINATION HAZARD, not a performance note. Every schema this
 * returns is a THUNK, because materializing the target model's `core.create` while
 * the enclosing model's schemas are still under construction never terminates for a
 * self-referential relation. Call it from inside a verb factory (each of which is
 * itself reached through `v.lazy`), never from `getRelationSchemas`: the pin is
 * `polymorphic.core.test.ts` "inverse topology stays lazy until create validation",
 * which counts ZERO target-getter invocations after `core.create` is merely READ.
 */
export const nestedRelationDataProjection = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  resolved: ResolvedSlot,
  targetSchemas: T
): NestedRelationDataSchemas => {
  const owned = ownedByEnclosingStep(resolved);
  const bareUpdate = () =>
    targetSchemas().core.update as unknown as AnyObjectSchema;
  const getCreateSchema = () =>
    v.omit(
      targetSchemas().core.create as unknown as AnyObjectSchema,
      owned.keys
    ) as unknown as AnyObjectSchema;
  const getUpdateSchema = () =>
    v.omit(bareUpdate(), owned.keys) as unknown as AnyObjectSchema;
  return {
    getCreateSchema,
    getUpdateSchema,
    getSelectedUpsertUpdateSchema:
      owned.kind === "carrier" ? bareUpdate : getUpdateSchema,
    getCreateUpsertUpdateSchema:
      owned.kind === "columns" ? bareUpdate : getUpdateSchema,
  };
};
