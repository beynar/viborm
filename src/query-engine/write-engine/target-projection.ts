import type { Model } from "@schema/model";
import type { PolymorphicStorageColumn } from "@schema/relation";
import type { Sql } from "@sql";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import { buildScalarSqlValueForScalar } from "../builders/values-builder";
import { getPrimaryKeyValuesFromRecord } from "../operations/mutation-identity";
import {
  normalizeTargetConstraint,
  type TargetConstraint,
} from "../TargetConstraint";
import type { QueryScope } from "../types";
import type { StatementOutputSource } from "./OperationFragment";

/**
 * Every public field and private column a compiler consumes from a captured row.
 *
 * `identityFields` is the target's ROW KEY — the complete primary key in schema
 * order — and is the only thing a captured UPDATE/DELETE/guard may address the
 * selected record by. `fields` opens with that row key and continues with the
 * other target fields compilation demands, which include REFERENCE-KEY fields a
 * relation points at when they are not row-key fields (CONTEXT.md keeps those two
 * questions apart). This carries no mapping from child storage members to the
 * fields they reference: that correspondence is bound relation topology, and a
 * projection only says which target values the probe publishes.
 */
export interface TargetProjection {
  readonly identityFields: readonly string[];
  readonly fields: readonly string[];
  readonly columns: readonly PolymorphicStorageColumn[];
}

/**
 * The row key leads `fields` so a caller never has to pass a primary-key field
 * beside a projection, and the remaining demanded fields keep their request order
 * after it. Duplicates collapse, which keeps the published output list and the
 * probe's `select` one field per name.
 */
export function buildTargetProjection(
  model: Model<any>,
  requiredFields: readonly string[] = [],
  columns: readonly PolymorphicStorageColumn[] = []
): TargetProjection {
  const identityFields = getPrimaryKeyFields(model);
  return {
    identityFields,
    fields: [...new Set([...identityFields, ...requiredFields])],
    columns,
  };
}

export function targetProjectionColumns(
  scope: QueryScope,
  projection: TargetProjection,
  qualifier = scope.rootAlias
): { readonly name: string; readonly sql: Sql }[] {
  return projection.columns.map((column) => ({
    name: column.name,
    sql: scope.adapter.identifiers.aliased(
      scope.adapter.identifiers.column(qualifier, column.name),
      column.name
    ),
  }));
}

export function targetProjectionOutputs(
  projection: TargetProjection,
  optional = false
): Record<string, StatementOutputSource> {
  return Object.fromEntries(
    [
      ...projection.fields,
      ...projection.columns.map((column) => column.name),
    ].map((field) => [
      field,
      {
        kind: "firstRowField" as const,
        field,
        ...(optional ? { optional: true } : {}),
      },
    ])
  );
}

/** The probe/guard `select` that publishes the whole row key. */
export function targetProjectionRowKeySelect(
  projection: TargetProjection
): Record<string, boolean> {
  return Object.fromEntries(
    projection.identityFields.map((field) => [field, true])
  );
}

/**
 * The probe `select` that publishes every demanded field — the row key plus the
 * reference-key and scalar fields compilation asked for, in `fields` order, which
 * is the same order {@link targetProjectionOutputs} publishes them in.
 */
export function targetProjectionSelect(
  projection: TargetProjection
): Record<string, boolean> {
  return Object.fromEntries(projection.fields.map((field) => [field, true]));
}

/**
 * The captured row key as a `whereUnique` — what a targeted UPDATE or DELETE
 * addresses the selected record by, every member of it.
 *
 * The read of the captured members is {@link getPrimaryKeyValuesFromRecord}, the
 * one extractor this codebase has for "the row key values inside this record",
 * and it is reused rather than reimplemented — so its arity check is the only one
 * and its message is INHERITED VERBATIM, including the "Cannot refetch mutation
 * result …" wording it carries for the refetch seam that first needed it. A
 * captured member is missing only when a probe published fewer fields than the
 * projection declared, which is an engine fault either way; reworded copies of
 * that error would be a second extractor in all but name.
 */
export function capturedTargetWhere(
  model: Model<any>,
  projection: TargetProjection,
  captured: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return buildPrimaryKeyWhereUnique(
    model,
    capturedTargetValues(model, projection, captured)
  );
}

/**
 * Every captured row-key member, in the projection's declared order.
 *
 * The projection is the ONE source of which members those are: it names them and
 * the extractor reads exactly them, so a member the probe did not publish raises
 * the inherited error instead of arriving as an absent value that the where
 * builder would quietly drop from the selector. `model` names the constraint the
 * members nest under and the model the error reports; it is not a second answer
 * to which fields the row key has.
 */
export function capturedTargetValues(
  model: Model<any>,
  projection: TargetProjection,
  captured: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return getPrimaryKeyValuesFromRecord(
    model,
    captured,
    model["~"].names.ts ?? "unknown",
    projection.identityFields
  );
}

/**
 * The captured row key as filter conjuncts — the shape a guard or probe `AND`s
 * beside its selector and membership terms, where a `whereUnique` discriminator
 * cannot go. Same extractor, same members, different consumer.
 */
export function capturedTargetFilters(
  model: Model<any>,
  projection: TargetProjection,
  captured: Readonly<Record<string, unknown>>
): Record<string, unknown>[] {
  return Object.entries(capturedTargetValues(model, projection, captured)).map(
    ([field, value]) => ({ [field]: { equals: value } })
  );
}

/**
 * The captured row key as an exact target constraint.
 *
 * It normalizes the ROW KEY, not `getTargetIdentityFields`' wider addressable-key
 * set: those answer different questions (CONTEXT.md, "Row key" vs "Addressable
 * key"), and what a probe captured and a write will address is the row key.
 *
 * A `TargetConstraint` is a canonical SET for overlap comparison — every builder
 * of one sorts its members — so read the row key's order from `identityFields`,
 * never from the returned map.
 *
 * STILL NO PRODUCTION CONSUMER, and Package D was the named candidate. §6 D3
 * ("generalize occupied guards") was expected to consume it; it does not, and the
 * reason is a shape mismatch rather than a missed opportunity, recorded here so
 * Package O deletes it on evidence:
 *
 *  · an occupied-slot predicate is a `where` over the CHILD scope whose conjuncts
 *    pair the child's FOREIGN fields with the PARENT's pre-transition referenced
 *    values. A `TargetConstraint` binds one model's own field names to values, so
 *    the cross-model pairing the relation topology owns has nowhere to live in it;
 *  · it asks "does any row exist here", not "do these two static targets overlap",
 *    which is the only question `classifyTargetConstraintOverlap` /
 *    `exactTargetConstraintKey` / `getTargetConstraintPredicateFields` answer;
 *  · there is no captured child row to normalize. Discovering whether one exists
 *    is the guard's entire purpose.
 *
 * The guard's conjuncts come from the correlated membership binding through
 * `planningMembershipCondition` / `finalMembershipCondition` instead — the same
 * owner every other membership predicate already uses. Where a captured row key
 * DOES belong beside a selector, `capturedTargetFilters` above is the live shape.
 */
export function capturedTargetConstraint(
  model: Model<any>,
  projection: TargetProjection,
  captured: Readonly<Record<string, unknown>>
): TargetConstraint {
  return normalizeTargetConstraint(
    model,
    projection.identityFields,
    capturedTargetValues(model, projection, captured)
  );
}

/** Reassert every private value that influenced the compiled record branch. */
export function capturedTargetColumnPredicate(
  scope: QueryScope,
  projection: TargetProjection,
  captured: Readonly<Record<string, unknown>>,
  qualifier = scope.rootAlias
): Sql | undefined {
  const predicates = projection.columns.map((column) => {
    const target = scope.adapter.identifiers.column(qualifier, column.name);
    const value = captured[column.name];
    return value === null || value === undefined
      ? scope.adapter.operators.isNull(target)
      : scope.adapter.operators.eq(
          target,
          buildScalarSqlValueForScalar(scope, column.scalar, column.name, value)
        );
  });
  if (predicates.length === 0) return undefined;
  return predicates.length === 1
    ? predicates[0]
    : scope.adapter.operators.and(...predicates);
}
