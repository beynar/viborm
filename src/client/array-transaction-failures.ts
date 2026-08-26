import { attachCommitCertainty } from "@drivers/driver-error-context";
import { isVibORMError } from "@errors";
import type { WriteOutcome } from "@extensions/query";

export function markArrayCommitCertainty(
  error: unknown,
  certainty: WriteOutcome["certainty"]
): unknown {
  if (isVibORMError(error)) return attachCommitCertainty(error, certainty);
  if (!(error instanceof AggregateError)) return error;
  const marked = error.errors.map((failure) =>
    markArrayCommitCertainty(failure, certainty)
  );
  const cause =
    error.cause === error.errors[0]
      ? marked[0]
      : markArrayCommitCertainty(error.cause, certainty);
  return new AggregateError(marked, error.message, { cause });
}

export function combineArrayFailures(
  primary: unknown,
  suppressed: readonly unknown[]
): unknown {
  const distinct = suppressed.filter((failure) => failure !== primary);
  if (distinct.length === 0) return primary;
  return new AggregateError(
    [primary, ...distinct],
    "Array transaction and operation post-work both failed.",
    { cause: primary }
  );
}
