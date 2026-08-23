// The TWO facts about EMPTYING a relation — deliberately two.
//
// `slotMayBeEmpty` is the PUBLIC shape: may this relation hold nothing? It is
// what makes `delete` spellable — deleting the related record leaves the slot
// empty, whatever the storage looks like.
//
// `clearableMembership` is PHYSICAL storage: HOW the membership is cleared while
// both records survive. That is what makes `disconnect` spellable, and it is not
// a boolean: a junction clears by deleting its membership row, while a row
// reference clears by nulling an exact ordered subset of its columns — a mixed
// compound foreign key nulls its nullable members and keeps its required
// context ones.
//
// Both read the RESOLVED edge. Neither rescans the graph, and neither reads a
// declared `.optional()` flag on a model-target relation — that flag no longer
// exists, because emptiness follows from the stored tuple's nullability.

import type { AnyModel } from "@schema/model";
import type {
  ResolvedRelationEdge,
  ResolvedSlot,
} from "@schema/validation/relation-resolution";
import type { RelationSlot } from "./types";

/** How a membership is emptied without deleting either record. */
export type ClearableMembership =
  | { readonly kind: "none" }
  /** Deleting the junction row clears it, whatever the inverse cardinality. */
  | { readonly kind: "junctionRow" }
  | {
      readonly kind: "columns";
      readonly fields: readonly [string, ...string[]];
    };

// =============================================================================
// FACT 1 — the public slot
// =============================================================================

/**
 * May this relation's slot be EMPTY?
 *
 * A to-many slot is empty when its collection is; a foreign-key owner when any
 * local member accepts NULL, because one absent member makes the whole
 * membership absent; a non-owner always, because the membership lives on the
 * other row and may simply be missing; a row-held variant carrier exactly when
 * it was declared `.optional()`, which IS the nullability of its private
 * `(type, id)` pair.
 */
export const slotMayBeEmpty = (resolved: ResolvedSlot): boolean => {
  const edge = resolved.edge;
  if (edge.kind === "junction" || edge.kind === "variantJunctionCarrier") {
    return true;
  }
  if (edge.kind === "variantRowCarrier") {
    return isSlot(edge.carrier, resolved.slot)
      ? edge.storage.typeColumn.nullable
      : true;
  }
  return isSlot(edge.owner, resolved.slot)
    ? nullableForeignFields(edge).length > 0
    : true;
};

// =============================================================================
// FACT 2 — the physical membership
// =============================================================================

export const clearableMembership = (
  resolved: ResolvedSlot
): ClearableMembership => {
  const edge = resolved.edge;
  if (edge.kind === "junction" || edge.kind === "variantJunctionCarrier") {
    return { kind: "junctionRow" };
  }
  if (edge.kind === "variantRowCarrier") {
    return edge.storage.typeColumn.nullable
      ? {
          kind: "columns",
          fields: [edge.storage.typeColumn.name, edge.storage.idColumn.name],
        }
      : { kind: "none" };
  }
  // ONE answer per edge, asked from either end: the columns that record the
  // membership live on the owner's row, and clearing them is what "disconnect"
  // means from the owner slot AND from its inverse (§8.4).
  const [head, ...rest] = nullableForeignFields(edge);
  return head ? { kind: "columns", fields: [head, ...rest] } : { kind: "none" };
};

/**
 * Can the membership be cleared at all? The boolean projection of
 * {@link clearableMembership}, for callers that only decide whether to expose
 * `disconnect`.
 */
export const membershipCanBeCleared = (resolved: ResolvedSlot): boolean =>
  clearableMembership(resolved).kind !== "none";

/** `(model, field)` is the whole contextual identity of a slot. */
function isSlot(one: RelationSlot, other: RelationSlot): boolean {
  return one.source === other.source && one.field === other.field;
}

/** The ordered subset of the stored tuple whose scalars accept NULL. */
function nullableForeignFields(
  edge: Extract<ResolvedRelationEdge, { kind: "foreignKey" }>
): readonly string[] {
  const scalars: Record<string, AnyModel["~"]["state"]["scalars"][string]> =
    edge.owner.source["~"].state.scalars;
  return edge.reference.members
    .map((member) => member.foreignField)
    .filter((field) => scalars[field]?.["~"].state.nullable === true);
}
