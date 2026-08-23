import { UnsupportedOperationError } from "@errors";
import type {
  GuardStep,
  OperationFragment,
  OperationStep,
  OperationValueReference,
  StatementOutputSource,
  StatementStep,
} from "./OperationFragment";
import { statementReferences } from "./OperationFragment";

export interface GeneratedOutputSegment {
  readonly steps: readonly OperationStep[];
  readonly continuationGuards: readonly GuardStep[];
}

function operationStepReferences(
  step: OperationStep
): readonly OperationValueReference[] {
  if (step.kind === "recordSeries") return [];
  const statement =
    step.kind === "guard" ? step.premise.statement : step.statement;
  return statementReferences(statement);
}

export function statementStepsById(
  fragment: OperationFragment
): ReadonlyMap<string, StatementStep> {
  const steps = new Map<string, StatementStep>();
  for (const step of fragment.steps) {
    if (step.kind === "read" || step.kind === "write") {
      steps.set(step.id, step);
    }
  }
  return steps;
}

function outputSource(
  reference: OperationValueReference,
  steps: ReadonlyMap<string, StatementStep>
): StatementOutputSource | undefined {
  return steps.get(reference.step)?.outputs[reference.output];
}

function outputDependsOnProvider(
  reference: OperationValueReference,
  steps: ReadonlyMap<string, StatementStep>,
  visiting: Set<string> = new Set()
): boolean {
  const key = `${reference.step}.${reference.output}`;
  if (visiting.has(key)) return true;
  const source = outputSource(reference, steps);
  if (!source) return false;
  if (source.kind !== "consumedValue") return true;
  if (source.source.kind === "literal") return false;
  visiting.add(key);
  const depends = outputDependsOnProvider(
    source.source.reference,
    steps,
    visiting
  );
  visiting.delete(key);
  return depends;
}

function outputNeedsAtomicMaterialization(
  reference: OperationValueReference,
  steps: ReadonlyMap<string, StatementStep>,
  supportsInsertIdScratch: boolean,
  visiting: Set<string> = new Set()
): boolean {
  const key = `${reference.step}.${reference.output}`;
  if (visiting.has(key)) return true;
  const source = outputSource(reference, steps);
  if (!source) return false;
  if (source.kind === "insertId") return !supportsInsertIdScratch;
  if (source.kind !== "consumedValue") return true;
  if (source.source.kind === "literal") return false;
  visiting.add(key);
  const needs = outputNeedsAtomicMaterialization(
    source.source.reference,
    steps,
    supportsInsertIdScratch,
    visiting
  );
  visiting.delete(key);
  return needs;
}

export function generatedOutputSegments(
  fragment: OperationFragment,
  supportsInsertIdScratch: boolean
): readonly GeneratedOutputSegment[] | undefined {
  if (fragment.steps.some((step) => step.kind === "recordSeries")) {
    return undefined;
  }
  const stepsById = statementStepsById(fragment);
  const needsFallback = firstGeneratedOutputDependency(
    fragment,
    stepsById,
    supportsInsertIdScratch
  );
  if (!needsFallback) return undefined;

  const rawSegments: OperationStep[][] = [];
  let current: OperationStep[] = [];
  let currentIds = new Set<string>();
  const flush = () => {
    if (current.length === 0) return;
    rawSegments.push(current);
    current = [];
    currentIds = new Set<string>();
  };
  for (const step of fragment.steps) {
    const crossesProviderOutput = operationStepReferences(step).some(
      (reference) =>
        currentIds.has(reference.step) &&
        outputNeedsAtomicMaterialization(
          reference,
          stepsById,
          supportsInsertIdScratch
        )
    );
    if (crossesProviderOutput) flush();
    current.push(step);
    currentIds.add(step.id);
  }
  flush();

  const priorIds = new Set<string>();
  return rawSegments.map((segment) => {
    const guards = crossedReferenceContinuationGuards(
      segment,
      priorIds,
      stepsById
    );
    for (const step of segment) priorIds.add(step.id);
    return { steps: segment, continuationGuards: guards };
  });
}

export function firstGeneratedOutputDependency(
  fragment: OperationFragment,
  stepsById: ReadonlyMap<string, StatementStep>,
  supportsInsertIdScratch: boolean
): OperationValueReference | undefined {
  for (const step of fragment.steps) {
    for (const reference of operationStepReferences(step)) {
      if (
        outputNeedsAtomicMaterialization(
          reference,
          stepsById,
          supportsInsertIdScratch
        )
      ) {
        return reference;
      }
    }
  }
  return undefined;
}

export function crossedReferenceContinuationGuards(
  steps: readonly OperationStep[],
  priorIds: ReadonlySet<string>,
  stepsById: ReadonlyMap<string, StatementStep>
): readonly GuardStep[] {
  const guards = new Map<string, GuardStep>();
  for (const step of steps) {
    for (const reference of operationStepReferences(step)) {
      if (!priorIds.has(reference.step)) continue;
      const producer = stepsById.get(reference.step);
      const continuation = producer?.progressiveContinuation;
      if (!continuation) {
        if (!outputDependsOnProvider(reference, stepsById)) continue;
        throw new UnsupportedOperationError(
          `query-engine-v2 cannot continue a generated-output write after '${reference.step}.${reference.output}' without the producer's exact row premise.`
        );
      }
      guards.set(continuation.id, continuation);
    }
  }
  return [...guards.values()];
}
