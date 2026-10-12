import { type Clock, type ClockTimer, systemClock } from "../../clock";

/**
 * `running`, or a rejection built by `expired` once `ms` passed without an
 * answer.
 *
 * The abandoned operation keeps running on the provider. Its rejection is
 * observed here so it never surfaces as unhandled, and a late success is
 * handed to `abandon` — a reservation nobody will use goes back.
 *
 * `clock` is the same internal seam the transaction bounds take.
 */
export async function settleWithin<T>(
  running: Promise<T>,
  ms: number,
  expired: () => Error,
  abandon?: (late: T) => void,
  clock: Clock = systemClock
): Promise<T> {
  let timer: ClockTimer | undefined;
  let late = false;
  running.then(
    (value) => {
      if (late) abandon?.(value);
    },
    () => undefined
  );
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = clock.setTimeout(() => {
      late = true;
      reject(expired());
    }, ms);
  });
  try {
    return await Promise.race([running, expiry]);
  } finally {
    timer?.cancel();
  }
}
