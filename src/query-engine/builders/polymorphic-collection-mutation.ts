import type { ResolvedVariantJunctionMember } from "@schema/validation/relation-resolution";
import { memberRef } from "../context";
import type {
  QueryScope,
  VariantJunctionCarrierSlot,
  VariantJunctionInverseSlot,
} from "../types";
import {
  bindMemberJunction,
  type JunctionBoundRelation,
} from "./relation-data-builder";

/**
 * The OWNER-ORIENTED member-junction bind — the direct half of the pair whose
 * inverse half `classifyRelation` binds for a variant model's own slot.
 *
 * One member table, two traversals. The stored topology is always
 * owner-side-`source` / variant-side-`target`, so an inverse traversal reads it
 * with the sides swapped.
 *
 * There is no resolver here and there must not be one: the schema-wide gate
 * expanded `member.topology` once. This is a projection of that (§11.5.9), and
 * the reference it carries is the carrier's own slot narrowed to this member —
 * no synthetic relation, no brand, nothing to refuse (D9).
 */
export function bindPolymorphicCollectionMember(
  ctx: QueryScope,
  carrier: VariantJunctionCarrierSlot,
  member: ResolvedVariantJunctionMember
): JunctionBoundRelation {
  return bindMemberJunction(ctx, memberRef(carrier, member), member, "owner");
}

/**
 * The OWNER-ORIENTED bind of the member table an INVERSE edge traverses — the
 * one input the singular membership transfer may legally receive (plan §9.4).
 *
 * The inverse traversal's own bind (variant-oriented) is provably WRONG input
 * there: `membershipOwners` selects `membership.source`'s columns filtered by
 * `membership.target`, so a variant-oriented junction asks "which VARIANT rows
 * sit on this owner" — many rows on a healthy schema — and trips the malformed
 * multi-owner throw. The transfer's `cardinality !== "one"` gate does not catch
 * it, because the inverse singular bind IS `"one"`.
 *
 * @param ownerScope - a scope over the VARIANT CARRIER's model, which is the
 *   inverse edge's `targetModel`. The bound value's `sourceModel` is the owner,
 *   exactly as it is for a direct collection traversal.
 * @param inverse - the inverse slot the variant model declares, resolved.
 */
export function bindOwnerOrientedCollectionMember(
  ownerScope: QueryScope,
  inverse: VariantJunctionInverseSlot
): JunctionBoundRelation {
  const carrier: VariantJunctionCarrierSlot = {
    slot: inverse.edge.carrier,
    edge: inverse.edge,
  };
  return bindPolymorphicCollectionMember(ownerScope, carrier, inverse.member);
}
