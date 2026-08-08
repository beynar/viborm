/**
 * A virtual clock for the `Clock` seam in `src/clock.ts`.
 *
 * Time only moves when a test moves it. `advance(ms)` walks to the new instant
 * through every timer due along the way, firing each at its own due time, so a
 * callback that reads `now()` sees the moment it was scheduled for and not the
 * end of the jump. Timers armed by a firing callback are picked up in the same
 * walk if they too come due.
 *
 * This deliberately drives only the seam. Promises the host is resolving —
 * a live database round trip, say — are not timers and are not affected: to
 * wait for those, await them.
 */

import type { Clock, ClockTimer } from "@src/clock";

interface ScheduledTimer {
  readonly dueAt: number;
  readonly callback: () => void;
  cancelled: boolean;
}

export interface TestClock extends Clock {
  /** Move time forward by `ms`, running every timer that comes due. */
  advance(ms: number): void;
  /** Timers armed and not yet fired or cancelled. */
  pendingCount(): number;
}

/** A clock that starts at `startAt` and moves only when told to. */
export function createTestClock(startAt = 1_700_000_000_000): TestClock {
  let current = startAt;
  const scheduled = new Set<ScheduledTimer>();

  const nextDue = (limit: number): ScheduledTimer | undefined => {
    let earliest: ScheduledTimer | undefined;
    for (const timer of scheduled) {
      if (timer.cancelled || timer.dueAt > limit) continue;
      if (!earliest || timer.dueAt < earliest.dueAt) earliest = timer;
    }
    return earliest;
  };

  return {
    now: () => current,

    setTimeout(callback: () => void, ms: number): ClockTimer {
      const timer: ScheduledTimer = {
        dueAt: current + ms,
        callback,
        cancelled: false,
      };
      scheduled.add(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
          scheduled.delete(timer);
        },
      };
    },

    advance(ms: number): void {
      const target = current + ms;
      let due = nextDue(target);
      while (due) {
        scheduled.delete(due);
        current = due.dueAt;
        due.callback();
        due = nextDue(target);
      }
      current = target;
    },

    pendingCount: () => scheduled.size,
  };
}
