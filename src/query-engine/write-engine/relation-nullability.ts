import { NestedWriteError } from "@errors";
import type {
  ChildHeldRelation,
  ParentHeldRelation,
} from "../builders/relation-data-builder";

/** A relation whose membership is columns on a row — i.e. not a junction. */
type RowHeldRelation = ParentHeldRelation | ChildHeldRelation;

export function requiredForeignKeyFields(relation: RowHeldRelation): string[] {
  const { membership } = relation;
  if (membership.kind === "polymorphic") {
    return [membership.storage.typeColumn, membership.storage.idColumn]
      .filter((column) => !column.nullable)
      .map((column) => column.name);
  }
  return membership.foreignFields.filter(
    (field) =>
      membership.holder["~"].state.scalars[field]?.["~"].state.nullable !== true
  );
}

export function assertRelationCanDisconnect(relation: RowHeldRelation): void {
  const requiredFields = requiredForeignKeyFields(relation);
  if (requiredFields.length === 0) return;

  throw new NestedWriteError(
    `Cannot disconnect relation '${relation.relationInfo.name}' because foreign key field(s) ${requiredFields.join(", ")} are required.`,
    relation.relationInfo.name
  );
}
