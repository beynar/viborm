import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { getScalarCastType } from "../query-engine/builders/values-builder";
import type { QueryEngine } from "../query-engine/query-engine";
import type { QueryScope } from "../query-engine/types";
import { uniqueConflictTarget } from "../query-engine/WritePrograms";
import { upsertPremiseChanged } from "./messages";
import type {
  Failure,
  GuardStep,
  Postcondition,
  TargetConstraintPin,
} from "./OperationFragment";

/**
 * Lower a value to destination-field-aware SQL (ATOM §1 / §6), wrapped in the
 * adapter's cast for the target column. The `value` may be a symbolic `Ref`
 * (materialized later, create context) or a concrete planning literal (inlined
 * now, update-by-unique context); both ride inside `Sql.values` identically, so
 * create INSERTs and update SETs consume one FK expression regardless of
 * provenance. Clause builders beneath never learn `Ref` exists.
 */
export function referenceSql(
  engine: QueryEngine,
  model: Model<any>,
  field: string,
  value: unknown
): Sql {
  const sqlValue = engine.adapter.literals.value(value);
  const cast = getScalarCastType(model, field);
  return cast ? engine.adapter.expressions.cast(sqlValue, cast) : sqlValue;
}

/** The pinned unique target whose violation is the raceable create-branch signal. */
export function childRacePin(
  child: QueryScope,
  where: Record<string, unknown>
): TargetConstraintPin {
  return uniqueConflictTarget(child, where);
}

export function affectedRows(
  expected: number | { readonly min: number },
  failure: Failure
): Postcondition {
  return { kind: "affectedRows", expected, failure };
}

export function exactlyOneRow(failure: Failure): Postcondition {
  return { kind: "exactlyOneRow", failure };
}

/** A `notFound` failure — its message is informational; the executor builds the
 *  public `NotFoundError` from the execution context's model/operation. */
export function notFoundFailure(message: string): Failure {
  return { kind: "notFound", message, raceable: false };
}

/** A `nestedWrite` failure (V1's `NestedWriteError`), raceable per the Pin Rule. */
export function nestedWriteFailure(
  message: string,
  relation: string,
  raceable = false
): Failure {
  return { kind: "nestedWrite", message, relation, raceable };
}

/** A `query` failure — a terminal read that did not observe its promised row. */
export function queryFailure(message: string): Failure {
  return { kind: "query", message, raceable: false };
}

/**
 * An existing-row premise guard (ATOM §2): pinned `raceable: false`, carrying an
 * arbitrary typed {@link Failure}. Emitted only in batch mode; transaction mode
 * pins the same premise with a locked planning read. This is the reusable
 * adapter-assertion pin behind the found-upsert premise, the connect/disconnect
 * target premise, and the batch-mode `affectedRows` enforcement (ATOM §8.1 note
 * (b)) — all one existing-row premise, never a `notExists` create-branch guard.
 */
export function presenceGuard(
  id: string,
  statement: Sql,
  failure: Failure
): GuardStep {
  return { id, kind: "guard", premise: { kind: "exists", statement }, failure };
}

/**
 * The found-branch exists guard (ATOM §2) for the nested upsert: an existing-row
 * premise pinned `raceable: false`, carrying V1's `Nested upsert premise changed`
 * message. A thin wrapper over {@link presenceGuard}.
 */
export function existsGuard(
  id: string,
  statement: Sql,
  relation: string
): GuardStep {
  return presenceGuard(
    id,
    statement,
    nestedWriteFailure(upsertPremiseChanged(relation), relation, false)
  );
}
