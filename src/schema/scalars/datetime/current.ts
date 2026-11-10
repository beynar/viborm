/** The wall-clock value shared by temporal `now` and `updatedAt` generators. */
export type TemporalKind = "datetime" | "date" | "time";

/**
 * The instant every generator of the current synchronous run reads.
 *
 * A call's input is admitted in one synchronous run, and each `now` and
 * `updatedAt` field generates its value there, one after another: read
 * separately, a create's `createdAt` and `updatedAt` could straddle a
 * millisecond and differ. The first read of a run takes the clock and the
 * rest reuse it, until the run's microtasks run.
 */
let runInstant: string | undefined;

function currentInstant(): string {
  if (runInstant === undefined) {
    runInstant = new Date().toISOString();
    queueMicrotask(() => {
      runInstant = undefined;
    });
  }
  return runInstant;
}

/**
 * Read the host wall clock (once per synchronous run) and spell it in one
 * temporal scalar's logical input language.
 */
export function currentTemporalValue(kind: TemporalKind): string {
  const timestamp = currentInstant();
  if (kind === "date") return timestamp.slice(0, 10);
  if (kind === "time") return timestamp.slice(11, 19);
  return timestamp;
}
