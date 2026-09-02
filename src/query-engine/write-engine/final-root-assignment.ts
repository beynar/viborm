import { classifyRelationKeyScalarUpdate } from "../TargetConstraint";
import { isOperationValueReference } from "./OperationFragment";
import { type FinalReferenceSource, fkEquals } from "./relation-membership";
import { UnsupportedOperationError } from "./shared";

export type FinalAssignmentIdentity =
  | { readonly kind: "literal"; readonly value: unknown }
  | {
      readonly kind: "source";
      readonly source: FinalReferenceSource;
      readonly referencedField: string;
    }
  | { readonly kind: "opaque"; readonly value: unknown };

export type FinalAssignmentOrigin = "scalar" | "fold" | "membership" | "demand";

export interface RecordedFinalAssignment {
  readonly identity: FinalAssignmentIdentity;
  readonly origin: FinalAssignmentOrigin;
}

/**
 * One physical root column's final-value truth. It compares pre-cast semantic
 * sources; mutation compilers remain responsible for assembling SQL and ordering.
 */
export class FinalRootAssignmentTruth {
  private readonly assignments = new Map<string, RecordedFinalAssignment>();

  get(column: string): RecordedFinalAssignment | undefined {
    return this.assignments.get(column);
  }

  fork(): FinalRootAssignmentTruth {
    const fork = new FinalRootAssignmentTruth();
    for (const [column, assignment] of this.assignments) {
      fork.assignments.set(column, assignment);
    }
    return fork;
  }

  contribute(
    column: string,
    identity: FinalAssignmentIdentity,
    origin: FinalAssignmentOrigin,
    failure: string,
    preserveExistingOnEqual = false
  ): void {
    const previous = this.assignments.get(column);
    if (!previous) {
      this.assignments.set(column, { identity, origin });
      return;
    }
    if (finalAssignmentIdentitiesEqual(previous.identity, identity)) {
      if (!preserveExistingOnEqual) {
        this.assignments.set(column, { identity, origin });
      }
      return;
    }
    refuseFinalAssignment(failure);
  }
}

export function assignmentIdentityFromScalar(
  value: unknown
): FinalAssignmentIdentity {
  const scalar = classifyRelationKeyScalarUpdate(value);
  return scalar.resolved
    ? { kind: "literal", value: scalar.value }
    : { kind: "opaque", value };
}

export function assignmentIdentityFromFieldValue(
  field: string,
  value: unknown
): FinalAssignmentIdentity {
  if (isOperationValueReference(value)) {
    return {
      kind: "source",
      source: { kind: "finalRef", ref: value },
      referencedField: field,
    };
  }
  return assignmentIdentityFromScalar(value);
}

export function refuseFinalAssignment(message: string): never {
  throw new UnsupportedOperationError(message);
}

function finalAssignmentIdentitiesEqual(
  left: FinalAssignmentIdentity,
  right: FinalAssignmentIdentity
): boolean {
  // biome-ignore lint/style/useDefaultSwitchClause: every arm returns and there is no trailing return — the switch's exhaustiveness is what makes this compile, so a default clause would turn a missing arm from a type error into a silent undefined.
  switch (left.kind) {
    case "literal":
      return right.kind === "literal"
        ? fkEquals(left.value, right.value)
        : right.kind === "source" &&
            finalSourceEqualsLiteral(right, left.value);
    case "source":
      return right.kind === "literal"
        ? finalSourceEqualsLiteral(left, right.value)
        : right.kind === "source" &&
            finalReferenceSourcesEqual(
              left.source,
              left.referencedField,
              right.source,
              right.referencedField
            );
    case "opaque":
      return false;
  }
}

function finalSourceEqualsLiteral(
  source: Extract<FinalAssignmentIdentity, { kind: "source" }>,
  value: unknown
): boolean {
  return (
    source.source.kind === "literal" && fkEquals(source.source.value, value)
  );
}

function finalReferenceSourcesEqual(
  left: FinalReferenceSource,
  leftField: string,
  right: FinalReferenceSource,
  rightField: string
): boolean {
  if (left.kind !== right.kind) return false;
  // biome-ignore lint/style/useDefaultSwitchClause: every arm returns and there is no trailing return — the switch's exhaustiveness is what makes this compile, so a default clause would turn a missing arm from a type error into a silent undefined.
  switch (left.kind) {
    case "literal":
      return right.kind === "literal" && fkEquals(left.value, right.value);
    case "finalRef":
      return (
        right.kind === "finalRef" &&
        left.ref.step === right.ref.step &&
        left.ref.output === right.ref.output
      );
    case "planningField":
      return (
        right.kind === "planningField" &&
        left.step === right.step &&
        leftField === rightField
      );
    case "transitionedPlanningField":
      return (
        right.kind === "transitionedPlanningField" &&
        left.step === right.step &&
        left.apply === right.apply &&
        leftField === rightField
      );
    case "selectedRowContinuity":
      return (
        right.kind === "selectedRowContinuity" &&
        left.step === right.step &&
        left.apply === right.apply &&
        leftField === rightField
      );
    case "lookup":
      return (
        right.kind === "lookup" &&
        left.statement === right.statement &&
        leftField === rightField
      );
  }
}
