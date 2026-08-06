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
 * A composable operation fragment (PLAN P1.3). Two functions, an interface, no
 * hierarchy — and, decisively, **no part holds its parent**: a parent hands a
 * child only a `Ref` value and an FK position (WHY §4.2), never itself. The
 * root part splices child parts around its own write by FK direction; multiple
 * relations under one root fold into one linear fragment.
 *
 * - `planning(scope)` contributes the part's planning reads. They may `Ref`
 *   earlier planning reads (ATOM §3 technique 1). Probes are consumed through
 *   the P0 `Probe` pairing (ATOM §2), validated at construction.
 * - `compile(scope, known)` **constructs** the taken steps from the planning
 *   outputs (build-don't-select, P1.2) and may throw typed errors (the
 *   uncorrelated-exists arm, ATOM §3 technique 2). It never selects from a
 *   pre-frozen branch pair.
 *
 * Step ids are scope-allocated once (at construction); `planning`/`compile` are
 * deterministic projections/constructions over those ids, so calling `compile`
 * repeatedly with different `known` is safe (the existing slice suite does it).
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
