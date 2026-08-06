// biome-ignore-all lint/style/useFilenamingConvention: Part is the architecture name.
import {
  type FragmentOutputSource,
  type OperationStep,
  ref,
  type StatementOutputSource,
  type StatementStep,
} from "./OperationFragment";
import type { StepScope } from "./StepScope";

/**
 * Planning outputs handed to `compile` (ATOM §9 invariant 3 — the sanctioned
 * data crossing between the planning and final fragments). Keyed by
 * {@link planningKey} so two same-model probes under one parent never collide.
 */
export type PlanningKnown = Readonly<Record<string, unknown>>;

/**
 * A composable operation fragment. A parent passes field-bound references and
 * relation position to its Parts; it does not hand them the parent operation.
 * Planning contributes the reads needed to decide or materialize the final
 * fragment. Compilation emits only the selected effects.
 *
 * Step IDs are allocated at construction. Planning and compilation are
 * deterministic over those IDs, so the same Part can compile different known
 * planning results without mutating its structure.
 */
export interface Part {
  planning(scope: StepScope): readonly StatementStep[];
  compile(scope: StepScope, known: PlanningKnown): readonly OperationStep[];
}

/** Stable address of a planning read's output inside {@link PlanningKnown}. */
export function planningKey(step: string, output: string): string {
  return `${step}.${output}`;
}

/**
 * Derive a planning fragment's outputs from its read steps: every declared
 * output of every planning read is exposed under its {@link planningKey}, so
 * `compile` receives each probe's and locate read's rows at a stable, collision-
 * free address — the mechanism that lets one planning read feed another's
 * decision (ATOM §3 technique 1) across any number of same-model children.
 */
export function planningOutputs(
  steps: readonly StatementStep[]
): Record<string, FragmentOutputSource> {
  const outputs: Record<string, FragmentOutputSource> = {};
  for (const step of steps) {
    for (const name of Object.keys(step.outputs)) {
      outputs[planningKey(step.id, name)] = ref(step.id, name);
    }
  }
  return outputs;
}

/**
 * Make a selected arm's descendant plan safe while the owner has not selected that
 * arm yet. A missing arm may leave first-row outputs absent, and no expectation from
 * the untaken arm may reject planning.
 */
export function conditionalArmPlanning(
  steps: readonly StatementStep[]
): readonly StatementStep[] {
  return steps.map((step) => {
    const outputs = Object.fromEntries(
      Object.entries(step.outputs).map(
        ([name, source]): [string, StatementOutputSource] => [
          name,
          source.kind === "firstRowField"
            ? { ...source, optional: true }
            : source,
        ]
      )
    );
    const { expects: _expects, ...withoutExpectation } = step;
    return { ...withoutExpectation, outputs };
  });
}
