import type { FkDirection } from "../../builders/relation-data-builder";
import { NestedWriteError } from "../../types";
import { recordNotFoundError } from "./record-access";

export type UniqueInput = Record<string, unknown>;

export function assertSingleRelationInput(
  relationName: string,
  operation: string,
  inputs: UniqueInput[]
): void {
  if (inputs.length <= 1) {
    return;
  }

  throw new NestedWriteError(
    `Cannot use multiple '${operation}' inputs for to-one relation '${relationName}'.`,
    relationName
  );
}

export function getNonNullableFkFields(fkDir: FkDirection): string[] {
  return fkDir.fkFields.filter((fkField) => {
    const field = fkDir.fkHolder["~"].state.scalars[fkField];
    return field?.["~"].state.nullable !== true;
  });
}

export function assertFkCanBeSetNull(
  relationName: string,
  fkDir: FkDirection
): void {
  const nonNullableFkFields = getNonNullableFkFields(fkDir);

  if (nonNullableFkFields.length === 0) {
    return;
  }

  throw new NestedWriteError(
    `Cannot disconnect relation '${relationName}' because foreign key field(s) ${nonNullableFkFields.join(
      ", "
    )} are required.`,
    relationName
  );
}

export function throwIfNoCorrelatedRowsAffected(
  result: { rowCount: number },
  relationName: string,
  operation: string
): void {
  if (result.rowCount > 0) {
    return;
  }

  throw recordNotFoundError({ relationName, operation, kind: "correlated" });
}
