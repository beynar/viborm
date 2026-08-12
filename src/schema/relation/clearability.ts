// The TWO facts about EMPTYING a relation — deliberately two, at both levels.
//
// `slotMayBeEmpty` is the PUBLIC shape: may this relation hold nothing? It is the
// declaration's own `.optional()`, and it is what makes `delete` spellable — deleting
// the related record leaves the slot empty, whatever the storage looks like.
//
// `membershipCanBeCleared` is PHYSICAL storage: can the columns that record the
// membership be set to NULL while both records survive? That is what makes
// `disconnect` spellable.
//
// On a polymorphic edge the two coincide by DEFINITION — the private `(type, id)`
// pair's nullability IS the relation's optionality (`schema/validation/rules/
// polymorphic.ts`). On an ordinary edge they diverge, and that divergence is a real
// schema: an optional slot whose child-side foreign key is NOT nullable may be
// emptied by deleting the child and may not be emptied by disconnecting it. A rule
// forcing relation optionality and foreign-key nullability to agree would be
// source-breaking, and the compression plan (§8.2) explicitly leaves it as a separate
// product decision — so these stay two functions, and no caller may derive one from
// the other.
//
// The ENGINE does not read this module. It answers the same physical question from
// BOUND membership (`write-engine/relation-nullability.ts`), which is the
// only reading available to it on a trusted internal program that never passed the
// public schema — see the guard-ownership ledger.

import type { AnyModel } from "@schema/model";
import {
  type CanBindPolymorphicInverse,
  canBindPolymorphicInverse,
  getPolymorphicInverseBinding,
} from "./inverse";
import type { GetPolymorphicInverseBinding } from "./polymorphic";
import type { GetInverseRelationMap, RelationState } from "./types";
import { getInverseRelationMap } from "./types";

/** The target model of a relation, inferred through its getter (never constrained). */
type RelationTarget<S extends RelationState> = S["getter"] extends () => infer T
  ? T extends AnyModel
    ? T
    : never
  : never;

// =============================================================================
// FACT 1 — the public slot
// =============================================================================

/**
 * May this relation's slot be EMPTY? Public cardinality/optionality only.
 *
 * This is the availability rule for `delete` on a to-one surface. It says nothing
 * about whether the membership can be cleared without removing the record — see
 * {@link membershipCanBeCleared}, which is a different question with a different
 * answer on an ordinary edge.
 */
export const slotMayBeEmpty = (state: RelationState): boolean =>
  state.optional === true;

/** The type twin of {@link slotMayBeEmpty} — one rule, both levels. */
export type SlotMayBeEmpty<S extends RelationState> = S["optional"] extends true
  ? true
  : false;

// =============================================================================
// FACT 2 — the physical membership
// =============================================================================

type PolymorphicInverseBindingFor<
  S extends RelationState,
  Source extends AnyModel,
> = GetPolymorphicInverseBinding<RelationTarget<S>, Source, S["name"]>;

/**
 * The TARGET's own polymorphic relation state, when this edge is the inverse of one.
 * `never` when the edge's shape cannot bind a polymorphic inverse, or when no binding
 * resolves — which is exactly when the ordinary reading applies.
 */
type PolymorphicInverseMembershipState<
  S extends RelationState,
  Source extends AnyModel,
> =
  CanBindPolymorphicInverse<S> extends true
    ? PolymorphicInverseBindingFor<S, Source> extends {
        readonly relationKey: infer RelationKey;
      }
      ? [RelationKey] extends [never]
        ? never
        : RelationKey extends keyof RelationTarget<S>["~"]["state"]["polymorphicRelations"]
          ? RelationTarget<S>["~"]["state"]["polymorphicRelations"][RelationKey]["~"]["state"]
          : never
      : never
    : never;

type NullableScalarKeys<Model extends AnyModel> = {
  [Key in keyof Model["~"]["state"]["scalars"]]: Model["~"]["state"]["scalars"][Key]["~"]["state"] extends {
    nullable: true;
  }
    ? Key
    : never;
}[keyof Model["~"]["state"]["scalars"]];

/** The ordinary reading: EVERY inverse foreign-key column must accept NULL. */
type InverseFkMembershipCanBeCleared<
  S extends RelationState,
  Source extends AnyModel,
> =
  Extract<
    GetInverseRelationMap<S, Source>,
    readonly string[]
  > extends infer Fields
    ? [Fields] extends [never]
      ? false
      : Fields extends readonly string[]
        ? [Fields[number]] extends [never]
          ? false
          : Exclude<
                Fields[number],
                NullableScalarKeys<RelationTarget<S>>
              > extends never
            ? true
            : false
        : false
    : false;

/**
 * Can the membership be CLEARED while both records survive? Physical storage only.
 *
 * Ordinary edge: every inverse foreign-key scalar on the target is nullable.
 * Polymorphic inverse: the target's direct polymorphic relation is optional, which is
 * the same statement about its private `(type, id)` columns.
 *
 * This is the availability rule for `disconnect` (and, on a to-many, the one the
 * junction case bypasses — a `manyToMany` membership always clears, because clearing
 * it removes a junction row rather than nulling a column).
 */
export const membershipCanBeCleared = (
  state: RelationState,
  source: AnyModel
): boolean => {
  const binding = canBindPolymorphicInverse(state)
    ? getPolymorphicInverseBinding(state.getter(), source, state.name)
    : undefined;
  if (binding) {
    const targetModel: AnyModel = state.getter();
    return (
      targetModel["~"].state.polymorphicRelations[binding.relationKey]?.["~"]
        .state.optional === true
    );
  }
  const inverseFields: unknown = getInverseRelationMap(state, source);
  if (!Array.isArray(inverseFields) || inverseFields.length === 0) return false;
  const targetModel = state.getter();
  return inverseFields.every(
    (field) =>
      typeof field === "string" &&
      targetModel["~"].state.scalars[field]?.["~"].state.nullable === true
  );
};

/** The type twin of {@link membershipCanBeCleared} — one rule, both levels. */
export type MembershipCanBeCleared<
  S extends RelationState,
  Source extends AnyModel,
> = [PolymorphicInverseMembershipState<S, Source>] extends [never]
  ? InverseFkMembershipCanBeCleared<S, Source>
  : PolymorphicInverseMembershipState<S, Source> extends { optional: true }
    ? true
    : false;
