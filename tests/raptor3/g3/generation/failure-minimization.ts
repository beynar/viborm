import type { FailureObservation } from "../../harness/protocol";
import { observeFailure } from "../../harness/sqlite-world";
import type { ProfileId, TransportProfileId } from "../../profiles";
import { shrinkG3Recipe, type G3GeneratedRecipe } from "./recipe";

type G3ProfileId = ProfileId | TransportProfileId;

interface FailedAttempt<Record> {
  readonly failure: unknown;
  readonly record?: Record;
}

interface SuccessfulAttempt<Record> {
  readonly record?: Record;
}

function stableProperty(failure: FailureObservation): string | undefined {
  return failure.message.match(/\bg3-[a-z0-9-]+:[a-z0-9-]+\b/i)?.[0];
}

function failureIdentity(
  recipe: G3GeneratedRecipe,
  profile: G3ProfileId,
  failure: unknown
) {
  const observation = observeFailure(failure);
  const property = stableProperty(observation);
  if (property === undefined) return undefined;
  return {
    contract: recipe.contract,
    profile,
    property,
    name: observation.name,
    ...(observation.code === undefined ? {} : { code: observation.code }),
  };
}

function sameIdentity(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Shrinks only a stable named failure on the same contract and profile. */
export async function minimizeG3Failure<Record>(
  original: G3GeneratedRecipe,
  profile: G3ProfileId,
  originalFailure: unknown,
  execute: (
    recipe: G3GeneratedRecipe,
    captureRecord: (record: Record) => void
  ) => Promise<void>,
  replay: (record: Record) => Promise<unknown>,
  replayCount: number
) {
  const identity = failureIdentity(original, profile, originalFailure);
  if (identity === undefined)
    return {
      status: "not-minimized",
      reason: "The original failure has no stable G3 property identity",
    };
  const attempts = new Map<
    G3GeneratedRecipe,
    FailedAttempt<Record> | SuccessfulAttempt<Record>
  >();
  const run = async (recipe: G3GeneratedRecipe) => {
    let record: Record | undefined;
    try {
      await execute(recipe, (captured) => {
        record = captured;
      });
      const attempt = record === undefined ? {} : { record };
      attempts.set(recipe, attempt);
      return attempt;
    } catch (failure) {
      const attempt = {
        failure,
        ...(record === undefined ? {} : { record }),
      };
      attempts.set(recipe, attempt);
      return attempt;
    }
  };
  const reproduces = async (recipe: G3GeneratedRecipe) => {
    const attempt = await run(recipe);
    return (
      "failure" in attempt &&
      sameIdentity(failureIdentity(recipe, profile, attempt.failure), identity)
    );
  };
  const shrink = await shrinkG3Recipe(original, reproduces);
  let reduced = attempts.get(shrink.reduced);
  if (reduced === undefined) reduced = await run(shrink.reduced);
  if (
    !("failure" in reduced) ||
    !sameIdentity(
      failureIdentity(shrink.reduced, profile, reduced.failure),
      identity
    )
  )
    throw new Error(
      "G3 minimizer did not preserve the original failure property"
    );
  if (reduced.record !== undefined) {
    for (let replayIndex = 0; replayIndex < replayCount; replayIndex++) {
      try {
        await replay(reduced.record);
      } catch (failure) {
        if (
          sameIdentity(
            failureIdentity(shrink.reduced, profile, failure),
            identity
          )
        )
          continue;
        throw new Error(
          "G3 minimized replay changed the original failure property",
          { cause: failure }
        );
      }
      throw new Error("G3 minimized replay did not reproduce the failure");
    }
  }
  return {
    status: "minimized",
    identity,
    original,
    reduced: shrink.reduced,
    attempts: shrink.attempts,
    replays: reduced.record === undefined ? 0 : replayCount,
    ...(reduced.record === undefined ? {} : { record: reduced.record }),
  };
}
