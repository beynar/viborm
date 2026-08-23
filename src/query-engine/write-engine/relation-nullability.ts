import { clearableMembership } from "@schema/relation";
import type {
  ChildHeldRelation,
  ParentHeldRelation,
} from "../builders/relation-data-builder";

/** A relation whose membership is columns on a row — i.e. not a junction. */
type RowHeldRelation = ParentHeldRelation | ChildHeldRelation;

/**
 * The ordered subset of a row-held membership's columns that EMPTYING it writes
 * NULL into (plan §8.4).
 *
 * One owner, asked from either end of the edge: `clearability.ts` derives it
 * from the resolved edge's stored reference, so the columns a disconnect clears
 * and the columns the operation schema published `disconnect` for are the same
 * list by construction. A mixed compound key answers with its nullable members
 * only — the required ones are CONTEXT the membership keeps.
 */
export function clearableForeignKeyFields(
  relation: RowHeldRelation
): readonly string[] {
  const clearable = clearableMembership(relation.relationRef.resolved);
  return clearable.kind === "columns" ? clearable.fields : [];
}

/**
 * The complement: the members emptying must RETAIN, in the same order.
 *
 * Two readers, both of which name it in a sentence or a guard premise rather
 * than writing it — `RelationSetPart`'s `setRequiredOrphan` message and the
 * native-batch `notExists` premise that stands in for it.
 */
export function requiredForeignKeyFields(relation: RowHeldRelation): string[] {
  const clearable = new Set(clearableForeignKeyFields(relation));
  const { membership } = relation;
  const fields =
    membership.kind === "polymorphic"
      ? [membership.storage.typeColumn.name, membership.storage.idColumn.name]
      : membership.foreignFields;
  return fields.filter((field) => !clearable.has(field));
}
