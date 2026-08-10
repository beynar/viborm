import { NestedWriteError, UnsupportedOperationError } from "@errors";
import { bindRelation } from "./builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  type RelationMutationProgram,
} from "./builders/relation-mutation-parser";
import { createQueryScope, getPrimaryKeyFields } from "./context/query-scope";
import { classifyRelationKeyScalarUpdate } from "./TargetConstraint";
import type { QueryScope } from "./types";

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
 * Reject relation writes carried by any direct `updateMany` entry in one
 * selected-record update. Callers own when this check runs so an untaken upsert
 * arm remains inert.
 */
export function assertUpdateManyDataRelationsAreCompilable(
  source: QueryScope,
  relations: Readonly<Record<string, RelationMutationProgram>>
): void {
  const invalid = findRelationBearingUpdateManyData(source, relations);
  if (!invalid) return;
  assertUpdateManyRelationsAreCompilable(
    invalid.relationName,
    invalid.relations
  );
}

/** Preserve the selected-record compiler's existing refusal and message. */
export function assertSelectedUpdateManyDataIsScalar(
  source: QueryScope,
  relations: Readonly<Record<string, RelationMutationProgram>>
): void {
  const invalid = findRelationBearingUpdateManyData(source, relations);
  if (!invalid) return;
  if (invalid.isJunction) {
    throw new UnsupportedOperationError(
      `query-engine-v2 nested 'updateMany' on many-to-many relation '${invalid.relationName}' does not support nested relation writes in its data.`
    );
  }
  throw new UnsupportedOperationError(
    `query-engine-v2 updateMany for relation '${invalid.relationName}' does not support nested relation writes in its data.`
  );
}

/*
 * D2 — `assertPinnedTransitionIsCompilable` lived here and is DELETED. It refused a
 * selected target that transitions a row-key member the locator does not pin while a
 * deeper non-cascading edge references that member, because the engine could not name
 * the member's pre-transition value: "…transitions the target primary key '<field>'
 * while writing a deeper edge whose foreign key does not cascade on update; it must
 * locate the target by that primary key."
 *
 * `RecordUpdateCompiler.interpretReferencedKeyTransition` now names it — the located
 * row supplies every member's OLD value and `postTransitionReference` derives every
 * member's NEW value — so the refusal has a compiling answer and its five eager arm-side
 * call sites are gone with it. Its domain was also strictly NARROWER than the compiler's
 * (row-key members only, and it matched `parentHeldToOne.referencedFields`, which name
 * the TARGET's columns rather than the selected model's, by name across two models).
 */

function findRelationBearingUpdateManyData(
  source: QueryScope,
  relations: Readonly<Record<string, RelationMutationProgram>>
):
  | {
      readonly relationName: string;
      readonly relations: Record<string, RelationMutationProgram>;
      readonly isJunction: boolean;
    }
  | undefined {
  for (const program of Object.values(relations)) {
    const relation = bindRelation(source, program.relationInfo);
    const target = createQueryScope(
      source.adapter,
      program.relationInfo.targetModel
    );
    for (const entry of program.entries) {
      if (entry.kind !== "updateMany") continue;
      for (const input of entry.items) {
        const nested = buildParsedRelationPrograms(
          target,
          input.data
        ).relations;
        if (Object.keys(nested).length > 0) {
          return {
            relationName: program.relationInfo.name,
            relations: nested,
            isJunction: relation.kind === "junction",
          };
        }
      }
    }
  }
  return undefined;
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
    const relation = bindRelation(ctx, mutation.relationInfo);
    if (relation.kind === "junction") continue;
    const relationKeyFields =
      relation.kind === "parentHeldToOne"
        ? relation.foreignFields
        : relation.referencedFields;
    for (const field of relationKeyFields) {
      if (scalarData[field] === undefined) continue;
      if (primaryKeyFields.has(field) && relation.kind !== "parentHeldToOne") {
        continue;
      }
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
