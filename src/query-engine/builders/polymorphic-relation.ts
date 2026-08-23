import { refFromSlot } from "../context";
import {
  QueryEngineError,
  type SelectedVariantRow,
  type VariantRowCarrierSlot,
} from "../types";
import {
  type BoundPolymorphicMembership,
  buildPolymorphicMembership,
} from "./relation-data-builder";

/**
 * Select one validated public discriminator on a row carrier.
 *
 * NO RELATION IS SYNTHESIZED (§8.3, D9). The carrier slot and the member the
 * discriminator names are both objects the gate published; selecting one is a
 * lookup in `edge.members`, and the reference the write parts address it by is
 * that same carrier slot narrowed to the member.
 *
 * DELIBERATELY row-held-only: the private `(type, id)` pair it addresses is a
 * thing a collection has no analogue of. A collection member's junction facts
 * live on its own resolved member and are bound by `bindMemberJunction`.
 */
export function selectVariantRow(
  carrier: VariantRowCarrierSlot,
  publicType: string
): SelectedVariantRow {
  const member = carrier.edge.members.find(
    (candidate) => candidate.variant === publicType
  );
  if (!member) {
    throw new QueryEngineError(
      `Unknown polymorphic target '${publicType}' for relation '${carrier.slot.field}'.`
    );
  }
  const ref = refFromSlot({ slot: carrier.slot, edge: carrier.edge, member });
  if (!ref) {
    // Structurally unreachable: a member-restricted carrier slot always names
    // one target model, which is what makes it addressable.
    throw new QueryEngineError(
      `query-engine-v2 internal: variant '${publicType}' of '${carrier.slot.field}' has no addressable target.`
    );
  }
  return { carrier, member, ref };
}

/**
 * The physical membership a selected DIRECT member writes — the same bound
 * membership an inverse edge on that private pair binds, so the two intents
 * produce one topology and one OwnWrite scope.
 *
 * The holder is the carrier's own model because that IS the scope the payload
 * was parsed against: a scope resolves only its own model's slots, so
 * `edge.carrier.source` and the resolving `scope.model` are the same instance —
 * and membership-scope equality compares model identity.
 */
export function directPolymorphicMembership(
  selected: SelectedVariantRow
): BoundPolymorphicMembership {
  return buildPolymorphicMembership(
    selected.carrier.edge.carrier.source,
    selected.member.targetModel,
    selected.carrier.edge,
    selected.member
  );
}
