import type {
  QueryInterceptorExecutionControl,
  TransactionWriteOutcomes,
  WriteOutcome,
  WriteOutcomeNotifications,
} from "./query";

export interface ArrayDeferred<Value> {
  readonly promise: Promise<Value>;
  reject(reason: unknown): void;
  resolve(value: Value): void;
}

/** Extension-only state shared by native and fallback array coordination. */
export interface ArrayAdmissionSlot {
  admitted: boolean;
  admissionFailures?: unknown[];
  readonly child: ArrayDeferred<unknown>;
  certainty?: WriteOutcome["certainty"];
  notifications?: WriteOutcomeNotifications;
  observation?: ArrayDeferred<unknown>;
  query?: Promise<unknown>;
}

type StartArrayQuery<Slot extends ArrayAdmissionSlot> = (
  slot: Slot,
  child: (notifications?: WriteOutcomeNotifications) => Promise<unknown>,
  control: QueryInterceptorExecutionControl
) => Promise<unknown>;

/** Create one privately observed result rail for array admission. */
export function createArrayDeferred<Value>(): ArrayDeferred<Value> {
  let settled = false;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  let resolvePromise: (value: Value | PromiseLike<Value>) => void = () =>
    undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  promise.catch(() => undefined);
  return {
    promise,
    reject(reason) {
      if (settled) return;
      settled = true;
      rejectPromise(reason);
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
  };
}

/**
 * Start every query onion and release the array only after every member has
 * reached its authoritative child. Failures are returned in stable order so
 * the client keeps ownership of its public transaction error composition.
 */
export async function admitArrayQueries<Slot extends ArrayAdmissionSlot>(
  slots: readonly Slot[],
  outcomes: TransactionWriteOutcomes,
  start: StartArrayQuery<Slot>
): Promise<readonly unknown[] | undefined> {
  let firstFailure: unknown;
  let hasFailure = false;
  let remaining = slots.length;
  const signal = createArrayDeferred<void>();
  if (remaining === 0) signal.resolve();

  for (const slot of slots) {
    const reportAdmissionFailure = (failure: unknown): void => {
      const failures = slot.admissionFailures;
      if (failures === undefined) {
        slot.admissionFailures = [failure];
      } else if (!failures.includes(failure)) {
        failures.push(failure);
      }
      if (hasFailure) return;
      hasFailure = true;
      firstFailure = failure;
      signal.reject(failure);
    };
    let query: Promise<unknown>;
    try {
      query = start(
        slot,
        (notifications) => {
          slot.notifications = notifications;
          if (!slot.admitted) {
            slot.admitted = true;
            remaining -= 1;
            if (remaining === 0) signal.resolve();
          }
          return slot.child.promise;
        },
        {
          reportAdmissionFailure,
          readCommitCertainty: () => slot.certainty,
        }
      );
    } catch (error) {
      reportAdmissionFailure(error);
      query = Promise.reject(error);
    }
    slot.query = query;
    if (slot.observation !== undefined) {
      query
        .then(slot.observation.resolve, slot.observation.reject)
        .catch(() => undefined);
    }
    query.catch(reportAdmissionFailure);
  }

  try {
    await signal.promise;
    await Promise.resolve();
    if (hasFailure) throw firstFailure;
    return undefined;
  } catch (fallback) {
    outcomes.discardAll();
    for (const slot of slots) slot.child.reject(fallback);
    const settled = await Promise.allSettled(slots.map(readArrayQuery));
    const reported = slots.flatMap((slot) => slot.admissionFailures ?? []);
    const primary = reported[0] ?? fallback;
    const failures: unknown[] = reported.length === 0 ? [primary] : reported;
    for (const outcome of settled) {
      if (
        outcome.status === "rejected" &&
        outcome.reason !== primary &&
        failures.indexOf(outcome.reason, 1) === -1
      ) {
        failures.push(outcome.reason);
      }
    }
    return failures;
  }
}

/** Read the public query onion, or its authoritative child before attachment. */
export function readArrayQuery(slot: ArrayAdmissionSlot): Promise<unknown> {
  return slot.query ?? slot.child.promise;
}
