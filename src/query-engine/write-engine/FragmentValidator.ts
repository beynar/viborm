// biome-ignore-all lint/style/useFilenamingConvention: FragmentValidator is the architecture name.
import { QueryEngineError } from "@errors";
import { isSql } from "@sql";
import {
  type GuardStep,
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  statementOutputReferences,
  statementReferences,
} from "./OperationFragment";

interface StepRecord {
  readonly index: number;
  readonly outputs: ReadonlySet<string>;
  readonly kind: OperationStep["kind"];
}

/**
 * The executable contract of ATOM's `The execution vocabulary` and `Branch
 * premises and pins`. Runs on every fragment before provider access; an invalid
 * fragment is a typed error, never a silent execution. This is a check on
 * compiler output — cheap enough to run every time — not a defensive parser.
 */
export function validateFragment(
  fragment: OperationFragment | PlanningFragment
): void {
  const records = indexSteps(fragment.steps);
  assertBackwardLocalReferences(fragment.steps, records);
  assertConsumedOutputsAreValues(fragment.steps);
  // A planning fragment declares no outputs — its publication is derived from
  // the steps themselves, so there is nothing that could fail to resolve.
  if ("outputs" in fragment) {
    assertOutputsResolvable(fragment, records);
  }
  assertGuardPinRule(fragment.steps, records);
}

function assertConsumedOutputsAreValues(steps: readonly OperationStep[]): void {
  for (const step of steps) {
    if (step.kind === "guard" || step.kind === "recordSeries") continue;
    const consumedReferences = statementReferences(step.statement);
    for (const [name, source] of Object.entries(step.outputs)) {
      if (source.kind === "consumedValue" && step.kind !== "write") {
        throw new QueryEngineError(
          `Consumed-value output '${step.id}.${name}' must belong to a successful write step.`
        );
      }
      if (
        source.kind === "consumedValue" &&
        source.source.kind === "reference"
      ) {
        const published = source.source.reference;
        const wasConsumed = consumedReferences.some(
          (reference) =>
            reference.step === published.step &&
            reference.output === published.output
        );
        if (!wasConsumed) {
          throw new QueryEngineError(
            `Consumed-value output '${step.id}.${name}' must publish a reference the successful write statement consumed.`
          );
        }
      }
      if (
        source.kind === "consumedValue" &&
        source.source.kind === "literal" &&
        (isSql(source.source.value) ||
          isOperationValueReference(source.source.value))
      ) {
        throw new QueryEngineError(
          `Consumed-value output '${step.id}.${name}' must use its explicit reference arm for an operation reference and cannot forward SQL.`
        );
      }
    }
  }
}

function indexSteps(
  steps: readonly OperationStep[]
): ReadonlyMap<string, StepRecord> {
  const records = new Map<string, StepRecord>();
  const recordId = (id: string, record: StepRecord): void => {
    if (records.has(id)) {
      throw new QueryEngineError(`Fragment step id '${id}' is not unique.`);
    }
    records.set(id, record);
  };
  steps.forEach((step, index) => {
    const outputs =
      step.kind === "guard" || step.kind === "recordSeries"
        ? new Set<string>()
        : new Set(Object.keys(step.outputs));
    recordId(step.id, { index, outputs, kind: step.kind });
    if (step.kind === "recordSeries" && step.progressive.kind === "guarded") {
      recordId(step.progressive.guard.id, {
        index,
        outputs: new Set<string>(),
        kind: "guard",
      });
    }
  });
  return records;
}

function assertBackwardLocalReferences(
  steps: readonly OperationStep[],
  records: ReadonlyMap<string, StepRecord>
): void {
  steps.forEach((step, index) => {
    if (step.kind === "recordSeries") {
      if (step.progressive.kind === "unsupported") return;
      assertStatementReferencesBackward(
        step.progressive.guard.id,
        step.progressive.guard.premise.statement,
        index,
        records
      );
      return;
    }
    const statement =
      step.kind === "guard" ? step.premise.statement : step.statement;
    assertStatementReferencesBackward(step.id, statement, index, records);
    if (step.kind === "read" || step.kind === "write") {
      for (const reference of statementOutputReferences(step)) {
        assertReferenceBackward(step.id, reference, index, records);
      }
      if (step.progressiveContinuation) {
        assertStatementReferencesAvailableAfterStep(
          step.progressiveContinuation.id,
          step.progressiveContinuation.premise.statement,
          index,
          records
        );
      }
    }
  });
}

function assertStatementReferencesAvailableAfterStep(
  stepId: string,
  statement: GuardStep["premise"]["statement"],
  index: number,
  records: ReadonlyMap<string, StepRecord>
): void {
  for (const reference of statementReferences(statement)) {
    const producer = records.get(reference.step);
    if (!producer) {
      throw new QueryEngineError(
        `Reference '${reference.step}.${reference.output}' in step '${stepId}' points outside the fragment.`
      );
    }
    if (producer.index > index) {
      throw new QueryEngineError(
        `Reference '${reference.step}.${reference.output}' in step '${stepId}' does not point backward.`
      );
    }
    if (!producer.outputs.has(reference.output)) {
      throw new QueryEngineError(
        `Reference '${reference.step}.${reference.output}' in step '${stepId}' points at an undeclared output.`
      );
    }
  }
}

function assertStatementReferencesBackward(
  stepId: string,
  statement: GuardStep["premise"]["statement"],
  index: number,
  records: ReadonlyMap<string, StepRecord>
): void {
  for (const reference of statementReferences(statement)) {
    assertReferenceBackward(stepId, reference, index, records);
  }
}

function assertReferenceBackward(
  stepId: string,
  reference: { readonly step: string; readonly output: string },
  index: number,
  records: ReadonlyMap<string, StepRecord>
): void {
  const producer = records.get(reference.step);
  if (!producer) {
    throw new QueryEngineError(
      `Reference '${reference.step}.${reference.output}' in step '${stepId}' points outside the fragment.`
    );
  }
  if (producer.index >= index) {
    throw new QueryEngineError(
      `Reference '${reference.step}.${reference.output}' in step '${stepId}' does not point backward.`
    );
  }
  if (!producer.outputs.has(reference.output)) {
    throw new QueryEngineError(
      `Reference '${reference.step}.${reference.output}' in step '${stepId}' points at an undeclared output.`
    );
  }
}

function assertOutputsResolvable(
  fragment: OperationFragment,
  records: ReadonlyMap<string, StepRecord>
): void {
  for (const [name, source] of Object.entries(fragment.outputs)) {
    const references = Array.isArray(source) ? source : [source];
    if (references.length === 0) {
      throw new QueryEngineError(
        `Fragment output '${name}' names no produced value.`
      );
    }
    for (const reference of references) {
      const producer = records.get(reference.step);
      if (!producer?.outputs.has(reference.output)) {
        throw new QueryEngineError(
          `Fragment output '${name}' does not resolve to a produced value.`
        );
      }
    }
  }
}

function assertGuardPinRule(
  steps: readonly OperationStep[],
  records: ReadonlyMap<string, StepRecord>
): void {
  const continuationIds = new Set<string>();
  for (const step of steps) {
    if (step.kind === "guard") {
      assertGuardRaceability(step);
      continue;
    }
    if (
      (step.kind === "read" || step.kind === "write") &&
      step.progressiveContinuation
    ) {
      const continuation = step.progressiveContinuation;
      if (records.has(continuation.id)) {
        throw new QueryEngineError(
          `Progressive continuation guard id '${continuation.id}' collides with a fragment step id.`
        );
      }
      if (continuationIds.has(continuation.id)) {
        throw new QueryEngineError(
          `Progressive continuation guard id '${continuation.id}' is not unique.`
        );
      }
      continuationIds.add(continuation.id);
      if (
        continuation.premise.kind !== "exists" ||
        continuation.failure.raceable
      ) {
        throw new QueryEngineError(
          `Progressive continuation guard '${continuation.id}' must be an exists premise with raceable: false.`
        );
      }
      assertGuardRaceability(continuation);
    }
    if (step.kind === "recordSeries" && step.progressive.kind === "guarded") {
      assertGuardRaceability(step.progressive.guard);
    }
  }
}

function assertGuardRaceability(guard: GuardStep): void {
  if (guard.premise.kind === "exists" && guard.failure.raceable) {
    throw new QueryEngineError(
      `Guard '${guard.id}' pins an existing-row premise and must be raceable: false.`
    );
  }
  if (guard.premise.kind === "notExists" && !guard.failure.raceable) {
    throw new QueryEngineError(
      `Guard '${guard.id}' is a raceable: false notExists guard — the production-FATAL create-branch pin the Pin Rule forbids.`
    );
  }
}
