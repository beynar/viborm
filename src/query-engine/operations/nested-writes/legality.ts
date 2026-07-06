import type { Operation, QueryContext } from "../../types";
import type { Mode } from "./mode";

/**
 * The single throw site for the capability contract (§6.3).
 *
 * Runs before any effect, in both modes, walking the whole tree. It is the
 * union of today's static checks (separateData parse validation,
 * `assertNoPlannedNestedMutationExecution`, `assertNestedUpdatePlanIsExecutable`,
 * `assertUpdateManyDataHasNoRelations`, `assertManyToManyStepCombinationIsSupported`,
 * FK-nullability checks) plus symbol-origin legality and probe independence.
 * Gates 1-5 are semantic invariants (both modes); gates 6-7 are mode-scoped by
 * the `mode` parameter, so the two modes can never disagree about where the
 * line is (§1.2 S2).
 *
 * M1 scaffolding: the individual static checks still fire inside the legacy
 * engines (the interpreter delegates 100% until later milestones, §11 M1), so
 * this gate is not yet on the execution path. M2 folds the checks in and routes
 * all static validation through here before either old engine runs.
 */
export function assertPlanExecutable(
  _ctx: QueryContext,
  _operation: Operation,
  _args: Record<string, unknown>,
  _mode: Mode
): void {
  // Composed at M2 (§11); see the JSDoc for the gate roster.
}
