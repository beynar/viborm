import { NestedWriteError } from "@errors";
import type {
  ChildHeldToMany,
  ChildHeldToOne,
  ParentHeldToOne,
} from "../builders/relation-data-builder";

type ForeignKeyRelation = ParentHeldToOne | ChildHeldToOne | ChildHeldToMany;

export function requiredForeignKeyFields(
  relation: ForeignKeyRelation
): string[] {
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
