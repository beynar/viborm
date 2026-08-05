import { getPrimaryKeyFields } from "./builders/correlation-utils";
import { getFkDirection } from "./builders/relation-data-builder";
import type { RelationMutationProgram } from "./builders/relation-mutation-parser";
import { classifyRelationKeyScalarUpdate } from "./TargetConstraint";
import { NestedWriteError, type QueryScope } from "./types";

/**
 * V1's updateMany-data relation legality (P6 pure-leaf extraction, consumed by
 * V2): a nested relation write inside `updateMany` data is inexpressible, rejected
 * before any effect with the byte-identical typed message. `relations` is the
 * canonical relation-program split of one updateMany input's `data`.
 */
export function assertUpdateManyRelationsAreCompilable(
  relationName: string,
  relations: Record<string, RelationMutationProgram>
): void {
  const relationKeys = Object.keys(relations);
  if (relationKeys.length === 0) return;
  throw new NestedWriteError(
    `Nested relation writes inside updateMany data for relation '${relationName}' are not supported.`,
    relationName,
    { meta: { operation: "updateMany", relations: relationKeys } }
  );
}

/**
 * V1's relation-key referential-action legality (P6 pure-leaf extraction, consumed
 * by V2): a relation key field mutated with a non-literal operation while its
 * relation is being written is rejected before any effect with the byte-identical
 * typed message.
 */
export function assertRelationKeyUpdatesAreCompilable(
  ctx: QueryScope,
  scalarData: Record<string, unknown>,
  relations: Record<string, RelationMutationProgram>
): void {
  const primaryKeyFields = new Set(getPrimaryKeyFields(ctx.model));

  for (const mutation of Object.values(relations)) {
    if (mutation.relationInfo.type === "manyToMany") continue;

    const fk = getFkDirection(ctx, mutation.relationInfo);
    const relationKeyFields = fk.holdsFK ? fk.fkFields : fk.pkFields;
    for (const field of relationKeyFields) {
      if (scalarData[field] === undefined) continue;
      if (primaryKeyFields.has(field) && !fk.holdsFK) continue;
      if (classifyRelationKeyScalarUpdate(scalarData[field]).resolved) continue;

      throw new NestedWriteError(
        `Cannot update relation key field '${field}' with a non-literal operation while mutating relation '${mutation.relationInfo.name}'. Use a literal value or '{ set: ... }'.`,
        mutation.relationInfo.name,
        {
          meta: {
            operation: "update",
            field,
            relation: mutation.relationInfo.name,
          },
        }
      );
    }
  }
}
