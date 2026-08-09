import { NestedWriteError } from "@errors";
import type {
  ChildHeldToMany,
  ChildHeldToOne,
  ParentHeldToOne,
  PolymorphicChildHeldRelation,
} from "../builders/relation-data-builder";

type ForeignKeyRelation =
  | ParentHeldToOne
  | ChildHeldToOne
  | ChildHeldToMany
  | PolymorphicChildHeldRelation;

export function requiredForeignKeyFields(
  relation: ForeignKeyRelation
): string[] {
  if (
    relation.kind === "polymorphicChildHeldToOne" ||
    relation.kind === "polymorphicChildHeldToMany"
  ) {
    return [relation.storage.typeColumn, relation.storage.idColumn]
      .filter((column) => !column.nullable)
      .map((column) => column.name);
  }
  const holder =
    relation.kind === "parentHeldToOne"
      ? relation.sourceModel
      : relation.relationInfo.targetModel;
  return relation.foreignFields.filter(
    (field) => holder["~"].state.scalars[field]?.["~"].state.nullable !== true
  );
}

export function assertRelationCanDisconnect(
  relation: ForeignKeyRelation
): void {
  const requiredFields = requiredForeignKeyFields(relation);
  if (requiredFields.length === 0) return;

  throw new NestedWriteError(
    `Cannot disconnect relation '${relation.relationInfo.name}' because foreign key field(s) ${requiredFields.join(", ")} are required.`,
    relation.relationInfo.name
  );
}
