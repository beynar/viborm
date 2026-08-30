import type { Model } from "@schema/model";
import type { Scalar } from "@schema/scalars/base";
import { isSql, type Sql } from "@sql";
import { dateTimeNativeTypeOf } from "../builders/datetime-field";
import { decimalDescriptorOfScalar } from "../builders/decimal-field";
import {
  decimalLiteral,
  getScalarCastTypeForScalar,
  getScalarTypeForScalar,
} from "../builders/values-builder";
import { getWhereUniqueFilters } from "../builders/where-unique-builder";
import type { QueryEngine } from "../query-engine";
import type { QueryScope } from "../types";
import { uniqueConflictTarget } from "../unique-conflict-target";
import { upsertPremiseChanged } from "./messages";
import {
  type Failure,
  type GuardStep,
  isOperationValueReference,
  type Postcondition,
  type TargetConstraintPin,
} from "./OperationFragment";

/**
 * Lower a value to destination-field-aware SQL (ATOM “Field-bound foreign-key provenance”), wrapped in the
 * adapter's cast for the target column. The `value` may be a symbolic `Ref`
 * (materialized later, create context) or a concrete planning literal (inlined
 * now, update-by-unique context); both ride inside `Sql.values` identically, so
 * create INSERTs and update SETs consume one FK expression regardless of
 * provenance. Clause builders beneath never learn `Ref` exists.
 *
 * A CONCRETE DECIMAL takes the exact-decimal literal instead — the same
 * `decimalLiteral` every other decimal write uses, canonicalization included.
 * Nothing else will do: a decimal relation key is compared against a parent
 * column that was written through the same field codec, so `9.50` reaching here
 * as an unscaled parameter matches nothing on SQLite (coefficient storage), and
 * a generic cast cannot supply the missing scale. Writing an FK any other way
 * than its referenced column is how the two ends of one relation came to
 * disagree inside a single statement pair — silently on drivers with foreign
 * keys off, as a spurious `ForeignKeyError` on drivers with them on.
 *
 * A CONCRETE DATETIME takes the adapter's `dateTime` literal, for the same
 * reason and with the same measurement behind it. MySQL's `DATETIME` rejects
 * ISO-8601's `Z` suffix, so `literals.value` hands the referenced column a
 * spelling that column never wears: `ER_TRUNCATED_WRONG_VALUE — Incorrect
 * datetime value: '2020-01-01T00:00:00.000Z'` (errno 1292, SQLSTATE 22007) on
 * 8.4.10, measured with and without a cast around it. `literals.dateTime` is the
 * one serialization every other datetime write in the engine already goes
 * through ({@link buildScalarSqlValue}, {@link scalarValueLiteral}); a relation
 * key written any other way is the two-ends-disagree bug the decimal note above
 * describes, in a second type. Restore `literals.value` here and the witnesses
 * that die are the concrete ones — the fresh-parent adopt, the created child,
 * connectOrCreate — on Docker MySQL only; PostgreSQL accepts the ISO spelling
 * into a `timestamptz`, so this branch is the one MySQL leg no local substrate
 * can stand in for.
 *
 * Like the decimal branch, this returns UNCAST: the temporal cast was the other
 * half of the same defect, and it is gone at the source
 * ({@link getScalarCastType}), which is where the DEFERRED temporal key — a
 * `Ref` this function cannot spell yet — is covered.
 *
 * A `Ref` or a pre-built `Sql` cannot be canonicalized here (its value does not
 * exist yet), so a decimal is cast through the referenced field's exact
 * descriptor rather than through the approximate `numeric` cast map. A
 * deferred temporal value remains uncast.
 */
export function referenceSql(
  engine: QueryEngine,
  model: Model<any>,
  field: string,
  value: unknown
): Sql {
  return referenceScalarSql(
    engine,
    model["~"].state.scalars[field],
    field,
    value
  );
}

/** Destination-aware deferred value lowering for private and public columns. */
export function referenceScalarSql(
  engine: QueryEngine,
  scalar: Scalar | undefined,
  field: string,
  value: unknown
): Sql {
  const decimal = decimalDescriptorOfScalar(scalar);
  if (decimal !== undefined) {
    if (isConcreteFkValue(value)) {
      // The DOMAIN travels with the value: on SQLite it is what turns the
      // logical key into the coefficient the referenced column stores.
      return decimalLiteral(engine.adapter, field, value, decimal);
    }
    return engine.adapter.expressions.decimalCast(
      engine.adapter.literals.value(value),
      decimal
    );
  }
  const cast = getScalarCastTypeForScalar(scalar);
  if (
    isConcreteFkValue(value) &&
    getScalarTypeForScalar(scalar) === "datetime" &&
    typeof value === "string"
  ) {
    return engine.adapter.literals.dateTime(
      value,
      dateTimeNativeTypeOf(scalar)
    );
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
    !isOperationValueReference(value)
  );
}

/**
 * The pinned unique target whose violation is the raceable create-branch signal —
 * present only for a PLAIN unique selector.
 *
 * The nested `upsert` selector admits an extended target, which makes the root's rule
 * ({@link UpsertOperation.createArmRacePin}) reachable one level down, and the
 * argument is unchanged by depth: a `racePin` claims "the probe proved unique key K
 * was free, so a violation on K means someone else took it between our read and our
 * write — re-plan and adopt". With an EXTENDED selector the probe proves something
 * weaker: no row matches `K ∧ filters`. A row on K may exist and be excluded by the
 * filter, and then the INSERT's violation is a GENUINE CONFLICT — re-planning re-reads
 * the same excluded row, takes the create arm again, and violates again. Pinning it
 * would buy one pointless retry and mis-attribute a real conflict as raceable.
 *
 * The withholding lives HERE, in the one function that mints these pins, rather than
 * at each call site: a caller whose selector cannot carry filters (`connect` /
 * `connectOrCreate`, still strict by W4's scoping) is unaffected by construction, and
 * a future widening cannot reintroduce the bug by forgetting a site.
 */
export function selectorRacePin(
  child: QueryScope,
  where: Record<string, unknown>
): TargetConstraintPin | undefined {
  if (getWhereUniqueFilters(child, where)) return undefined;
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

/** A raceable query failure for a retained absence premise. No same-target
 * constraint can enforce it, and fragment validation requires `raceable: true`. */
export function raceableQueryFailure(message: string): Failure {
  return { kind: "query", message, raceable: true };
}

/** Pin that a conditional premise still does not hold. The top-level upsert
 * skip branch uses it after its captured-row presence guard; transaction mode
 * gets both facts from the locked planning read. */
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
 * An existing-row premise guard (ATOM “Branch premises and pins”): pinned `raceable: false`, carrying an
 * arbitrary typed {@link Failure}. Emitted only in batch mode; transaction mode
 * pins the same premise with a locked planning read. This is the reusable
 * adapter-assertion pin behind the found-upsert premise, the connect/disconnect
 * target premise, and the batch-mode `affectedRows` enforcement (ATOM “Branch
 * premises and pins”) — all one existing-row premise, never a `notExists`
 * create-branch guard.
 */
export function presenceGuard(
  id: string,
  statement: Sql,
  failure: Failure
): GuardStep {
  return { id, kind: "guard", premise: { kind: "exists", statement }, failure };
}

/**
 * The found-branch exists guard (ATOM “Branch premises and pins”) for the nested upsert: an existing-row
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
