/**
 * Unit F — retry (pattern-engine-ideal-state.md §8.4).
 *
 * A retryable race — the missing arm's unique violation classified by the
 * driver's error mapping against the write's pinned target, a deadlock raised
 * while a pinned write was in flight, or a guard abort self-declared
 * `meta.raceable` — re-runs the operation once, from the start: construction,
 * allocation and scheduling produce fresh variables, which is why the program
 * is taken as a thunk. A committed prefix forbids the whole-operation retry;
 * the segments enforcer retries only the current fragment after one (today's
 * `runProgressiveRecordSeriesMember`).
 *
 * Classification is `write-engine/race-retry.ts`, unchanged: the executors mark
 * pinned violations from inside the atomic scope, this module only decides
 * whether to run again.
 */
import { hasCommittedRecordSeriesProgress } from "@errors";
import { isRetryableRace } from "../../write-engine/race-retry";

/** Run `attempt` and, on one retryable race with no committed prefix, once more. */
export async function withRaceRetry<T>(
  attempt: (attempt: number) => Promise<T>
): Promise<T> {
  try {
    return await attempt(0);
  } catch (error) {
    if (!isRetryableRace(error) || hasCommittedRecordSeriesProgress(error)) {
      throw error;
    }
    return attempt(1);
  }
}

export { isRetryableRace } from "../../write-engine/race-retry";
