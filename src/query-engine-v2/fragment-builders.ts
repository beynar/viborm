import type { Model } from "@schema/model";
import { isSql, type Sql } from "@sql";
import {
  decimalLiteral,
  getScalarCastType,
  isBatchValueRef,
} from "../query-engine/builders/values-builder";
import type { QueryEngine } from "../query-engine/query-engine";
import type { QueryScope } from "../query-engine/types";
import { uniqueConflictTarget } from "../query-engine/unique-conflict-target";
import { upsertPremiseChanged } from "./messages";
import {
  type Failure,
  type GuardStep,
  isOperationValueReference,
  type Postcondition,
  type TargetConstraintPin,
} from "./OperationFragment";

/**
 * Lower a value to destination-field-aware SQL (ATOM §1 / §6), wrapped in the
 * adapter's cast for the target column. The `value` may be a symbolic `Ref`
 * (materialized later, create context) or a concrete planning literal (inlined
 * now, update-by-unique context); both ride inside `Sql.values` identically, so
 * create INSERTs and update SETs consume one FK expression regardless of
 * provenance. Clause builders beneath never learn `Ref` exists.
 *
 * A CONCRETE DECIMAL takes the exact-decimal literal instead — the same
 * `decimalLiteral` every other decimal write uses, canonicalization included.
 * Nothing else will do: a decimal relation key is compared against a parent
 * column that was written canonically, so `9.50` reaching here as a cast
 * parameter matches nothing on SQLite (canonical TEXT storage), and the cast
 * alone cannot fix a spelling. Writing an FK any other way than its referenced
 * column is how the two ends of one relation came to disagree inside a single
 * statement pair — silently on drivers with foreign keys off, as a spurious
 * `ForeignKeyError` on drivers with them on.
 *
 * A `Ref` or a pre-built `Sql` cannot be canonicalized here (its value does not
 * exist yet), so it keeps the cast path — which is now the EXACT-decimal cast
 * (`getScalarCastType` -> `"decimal"`), not the float `"numeric"` one.
 */
export function referenceSql(
  engine: QueryEngine,
  model: Model<any>,
  field: string,
  value: unknown
): Sql {
  const cast = getScalarCastType(model, field);
  if (cast === "decimal" && isConcreteFkValue(value)) {
    return decimalLiteral(engine.adapter, field, value);
  }
  const sqlValue = engine.adapter.literals.value(value);
  return cast ? engine.adapter.expressions.cast(sqlValue, cast) : sqlValue;
}

/** A value whose spelling is knowable NOW — not a deferred symbol, not a
 *  pre-built fragment, not the absent value of a nullable FK. */
function isConcreteFkValue(value: unknown): boolean {
  return (
    value !== null &&
    value !== undefined &&
    !isSql(value) &&
    !isOperationValueReference(value) &&
    !isBatchValueRef(value)
  );
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
 * A raceable `query` failure — the abort class for a **retained `notExists`
 * pin** (ATOM §2): the top-level upsert's targetWhere/setWhere skip premise (no
 * INSERT exists for a constraint to fire on, so the constraint cannot enforce
 * it). `raceable: true` per the Pin Rule's materialized-condition class, which
 * the fragment validator requires of every `notExists` guard.
 */
export function raceableQueryFailure(message: string): Failure {
  return { kind: "query", message, raceable: true };
}

/**
 * A **retained `notExists` pin** (ATOM §2, the Pin Rule's own exception): batch
 * mode pins that a conditional premise still does NOT hold (`raceable: true`).
 * The only P2b user is the top-level upsert skip branch — planning decided the
 * existing row does not match targetWhere/setWhere (silent no-op, V1's contract);
 * this guard aborts the batch if a concurrent write made it match. Transaction
 * mode pins the same premise with the locked planning read, needing no guard.
 */
export function absenceGuard(
  id: string,
  statement: Sql,
  failure: Failure
): GuardStep {
  return {
    id,
    kind: "guard",
    premise: { kind: "notExists", statement },
    failure,
  };
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
