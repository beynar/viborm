/**
 * The time seam.
 *
 * Two subsystems decide things by reading the wall clock and arming timers:
 * cache freshness (TTL, and the stale window SWR serves from) and the
 * transaction `timeout` / `maxWait` bounds. Both are behavior worth testing,
 * and testing either through the host clock means sleeping — which buys a slow
 * suite and a timing race, not a proof.
 *
 * So both take their time from a `Clock`. The default is the host's own, and
 * nothing here is public API: the override exists so a test can advance time
 * instead of waiting for it. Driver-internal timers are deliberately out of
 * scope — they belong to the database client, not to us.
 */

/**
 * A timer armed by a `Clock`. The handle owns its own cancellation, so a call
 * site never reaches for a host timer function to undo what a clock started.
 */
export interface ClockTimer {
  /** Cancel the pending callback. Safe to call after it has already fired. */
  cancel(): void;
  /**
   * Release the host's hold on the event loop, where the host has one to
   * release. Node timers do; a virtual clock has nothing to release and says
   * so by omitting this.
   */
  unref?(): void;
}

/** The reading of time and the arming of timers, as one injectable thing. */
export interface Clock {
  /** Milliseconds since the epoch, exactly as `Date.now()` reports them. */
  now(): number;
  /** Arm `callback` to run `ms` from now. Cancel through the returned handle. */
  setTimeout(callback: () => void, ms: number): ClockTimer;
}

/** The host clock: `Date.now` and the global timer functions. The default. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback: () => void, ms: number): ClockTimer {
    const timer = setTimeout(callback, ms);
    return {
      cancel: () => clearTimeout(timer),
      // Hosts that are not Node (browsers, some edge runtimes) hand back a
      // number with no `unref`. Asking is cheaper than assuming.
      unref: () => {
        if (typeof timer.unref === "function") timer.unref();
      },
    };
  },
};
