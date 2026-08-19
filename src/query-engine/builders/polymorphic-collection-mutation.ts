import type { AnyModel } from "@schema/model";
import { manyToMany, type PolymorphicJunctionMember } from "@schema/relation";
import { getCompatiblePolymorphicInverseBinding } from "@schema/relation/inverse";
import type { RelationState } from "@schema/relation/types";
import {
  isPolymorphicToOneRelationInfo,
  type PolymorphicToManyRelationInfo,
  type QueryScope,
  type RelationInfo,
} from "../types";
import {
  type JunctionBoundRelation,
  polymorphicMemberMembership,
} from "./relation-data-builder";

/**
 * The OWNER-ORIENTED member-junction bind — the direct half of the pair whose
 * inverse half is `bindPolymorphicMemberJunction`.
 *
 * One member table, two traversals. The stored topology is always
 * owner-side-`source` / variant-side-`target`, so an inverse traversal reads it
 * with the sides swapped; `polymorphicMemberMembership(member, "owner")` is the
 * orientation nothing produced before Package D, because until D nothing
 * traversed a collection from the owner in a WRITE.
 *
 * There is no resolver here and there must not be one: Package B materialized
 * `PolymorphicJunctionMember.junction` at definition validation. This is a
 * projection of that, exactly as its inverse twin is.
 */
export function bindPolymorphicCollectionMember(
  ctx: QueryScope,
  relation: PolymorphicToManyRelationInfo,
  member: PolymorphicJunctionMember
): JunctionBoundRelation {
  return {
    position: "junction",
    // MEMBER-LOCAL: each variant's inverse chose "one" or "many" independently,
    // and a `"one"` member is the singular slot whose replacement needs the
    // transfer protocol. The OWNER side is always plural.
    cardinality: member.inverseCardinality,
    relationInfo: collectionMemberCarrier(relation, member),
    sourceModel: ctx.model,
    membership: polymorphicMemberMembership(member, "owner"),
  };
}

/**
 * The OWNER-ORIENTED bind of the member table an INVERSE edge traverses — the
 * one input the singular membership transfer may legally receive (plan §9.4).
 *
 * The inverse traversal's own bind (`bindPolymorphicMemberJunction`, which passes
 * `"variant"`) is provably WRONG input there: `membershipOwners` selects
 * `membership.source`'s columns filtered by `membership.target`, so a
 * variant-oriented junction asks "which VARIANT rows sit on this owner" — many
 * rows on a healthy schema — and trips the malformed multi-owner throw. The
 * transfer's `cardinality !== "one"` gate does not catch it, because the inverse
 * singular bind IS `"one"`.
 *
 * It resolves the OWNER's collection relation rather than flipping the bound
 * membership's two sides, so `polymorphicMemberMembership(member, "owner")` keeps
 * exactly one call site — {@link bindPolymorphicCollectionMember} — and the
 * orientation is stated once, by the projection owner, instead of re-derived by a
 * swap the next reader has to verify.
 *
 * @param ownerScope - a scope over the POLYMORPHIC OWNER model, which is the
 *   inverse edge's `targetModel`. The bound value's `sourceModel` is the owner,
 *   exactly as it is for a direct collection traversal.
 * @param variantModel - the model that DECLARES the inverse edge.
 */
export function bindOwnerOrientedCollectionMember(
  ownerScope: QueryScope,
  variantModel: AnyModel,
  inverse: RelationInfo
): JunctionBoundRelation | undefined {
  const binding = getCompatiblePolymorphicInverseBinding(
    inverse.relation["~"].state as RelationState,
    variantModel
  );
  if (!binding) return undefined;
  const info = ownerScope.polymorphicRelations.get(binding.relationKey);
  if (!info || isPolymorphicToOneRelationInfo(info)) return undefined;
  const member = info.storage.members.get(binding.publicType);
  return member
    ? bindPolymorphicCollectionMember(ownerScope, info, member)
    : undefined;
}

/**
 * The `RelationInfo` a member-junction bind carries, for the two things a bound
 * relation reads one for: ERROR SENTENCES and STEP-ID LABELS.
 * `BoundRelationBase.relationInfo` is required, and `JunctionStatements`'
 * `targetValue`/`targetValues` plus `getStepModelName` are its only readers on
 * this path.
 *
 * `name` is VARIANT-QUALIFIED — `items.post`, not `items` — and that is a
 * decision, not an accident. `getStepModelName(targetModel, relationName)`
 * drives the step-id prefix and `StepScope.allocate` appends `#N` on repeats, so
 * a shared `items` across three variants would allocate `items.find`,
 * `items.find#1`, `items.find#2` — ids whose meaning depends on emission order.
 * Variant-qualified names give `items.post.find`, `items.video.find`:
 * deterministic, readable, collision-free.
 *
 * The carrier is BRANDED and is never in `ctx.model["~"].state.relations`, so
 * the re-resolution prohibition is structural: nothing can look it up by name,
 * and the one remaining route into a resolver — `classifyRelation` — refuses it
 * by name.
 */
function collectionMemberCarrier(
  relation: PolymorphicToManyRelationInfo,
  member: PolymorphicJunctionMember
): RelationInfo {
  const carrier = manyToMany(() => member.targetModel);
  carrier["~"].setSource(relation.storage.ownerModel);
  return {
    name: `${relation.name}.${member.publicType}`,
    relation: carrier,
    targetModel: member.targetModel,
    // The PUBLIC slot's shape, which is what the relation-mutation parser reads
    // to choose its vocabulary: a collection takes the ordinary to-many verbs
    // (`updateMany`/`deleteMany` legal, `update` addressed by a unique `where`)
    // whatever a given variant's inverse cardinality is. The member's own
    // arity lives on the BOUND relation, where slot replacement consults it.
    type: "manyToMany",
    cardinality: "many",
    isOptional: relation.relation["~"].state.optional === true,
    // A junction stores its membership in a third table; neither row holds a
    // foreign key for it.
    fields: undefined,
    references: undefined,
    polymorphicMemberCarrier: true,
  };
}
