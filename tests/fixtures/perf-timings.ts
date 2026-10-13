import { expect } from "vitest";

/**
 * Absolute wall-clock budgets hold only where a run opts in with
 * `VIBORM_PERF_TIMINGS=1`: the nightly and manual `Performance timings`
 * workflow (.github/workflows/perf-timings.yml). Every other run, including
 * every pull-request job, still executes the measured operations and every
 * behaviour, statement-count and shape assertion beside them; only the
 * millisecond bound is skipped. A shared runner's CPU contention fails such a
 * bound with no regression, and a red PR then costs another full CI run.
 */
export const PERF_TIMINGS_ASSERTED = process.env.VIBORM_PERF_TIMINGS === "1";

export function expectWithinTimingBudget(
  measuredMs: number,
  budgetMs: number,
  label?: string
): void {
  if (!PERF_TIMINGS_ASSERTED) return;
  // biome-ignore lint/suspicious/noMisplacedAssertion: Called only from registered tests.
  expect(measuredMs, label).toBeLessThan(budgetMs);
}
