// biome-ignore-all lint/style/useFilenamingConvention: FragmentValidator is the architecture name.
import { QueryEngineError } from "@errors";
import {
  type GuardStep,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
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
  // A planning fragment declares no outputs — its publication is derived from
  // the steps themselves, so there is nothing that could fail to resolve.
  if ("outputs" in fragment) {
    assertOutputsResolvable(fragment, records);
  }
  assertGuardPinRule(fragment.steps);
}

function indexSteps(
  steps: readonly OperationStep[]
): ReadonlyMap<string, StepRecord> {
  const records = new Map<string, StepRecord>();
  steps.forEach((step, index) => {
    if (records.has(step.id)) {
      throw new QueryEngineError(
        `Fragment step id '${step.id}' is not unique.`
      );
    }
    const outputs =
      step.kind === "guard"
        ? new Set<string>()
        : new Set(Object.keys(step.outputs));
    records.set(step.id, { index, outputs, kind: step.kind });
  });
  return records;
}

function assertBackwardLocalReferences(
  steps: readonly OperationStep[],
  records: ReadonlyMap<string, StepRecord>
): void {
  steps.forEach((step, index) => {
    const statement =
      step.kind === "guard" ? step.premise.statement : step.statement;
    for (const reference of statementReferences(statement)) {
      const producer = records.get(reference.step);
      if (!producer) {
        throw new QueryEngineError(
          `Reference '${reference.step}.${reference.output}' in step '${step.id}' points outside the fragment.`
        );
      }
      if (producer.index >= index) {
        throw new QueryEngineError(
          `Reference '${reference.step}.${reference.output}' in step '${step.id}' does not point backward.`
        );
      }
      if (!producer.outputs.has(reference.output)) {
        throw new QueryEngineError(
          `Reference '${reference.step}.${reference.output}' in step '${step.id}' points at an undeclared output.`
        );
      }
    }
  });
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

function assertGuardPinRule(steps: readonly OperationStep[]): void {
  for (const step of steps) {
    if (step.kind !== "guard") continue;
    assertGuardRaceability(step);
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
