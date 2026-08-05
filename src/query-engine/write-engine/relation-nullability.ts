import { NestedWriteError } from "@errors";
import type { FkDirection } from "../builders/relation-data-builder";
import type { RelationInfo } from "../types";

export function requiredForeignKeyFields(fk: FkDirection): string[] {
  return fk.fkFields.filter(
    (field) =>
      fk.fkHolder["~"].state.scalars[field]?.["~"].state.nullable !== true
  );
}

export function assertRelationCanDisconnect(
  relation: RelationInfo,
  fk: FkDirection
): void {
  const requiredFields = requiredForeignKeyFields(fk);
  if (requiredFields.length === 0) return;

  throw new NestedWriteError(
    `Cannot disconnect relation '${relation.name}' because foreign key field(s) ${requiredFields.join(", ")} are required.`,
    relation.name
  );
}
