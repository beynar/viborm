import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { getScalarCastType } from "../query-engine/builders/values-builder";
import type { QueryEngine } from "../query-engine/query-engine";
import type { QueryScope } from "../query-engine/types";
import { uniqueConflictTarget } from "../query-engine/WritePrograms";
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

/**
 * The found-branch exists guard (ATOM §2): an existing-row premise, pinned
 * `raceable: false`. Emitted only in batch mode; transaction mode locks the
 * probe instead.
 */
export function existsGuard(
  id: string,
  statement: Sql,
  relation: string
): GuardStep {
  return {
    id,
    kind: "guard",
    premise: { kind: "exists", statement },
    failure: {
      kind: "nestedWrite",
      message: `Nested upsert premise changed for relation '${relation}'.`,
      relation,
      raceable: false,
    },
  };
}
