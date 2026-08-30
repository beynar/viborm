/**
 * The ONE rule for retaining secondary failures beside a primary failure.
 *
 * A secondary failure can arrive while a primary is already propagating: a
 * pinned session cleanup can fail after its body, or a pool can retain an idle
 * socket failure before a requested acquisition fails. The rule is total,
 * because every way of bending it loses evidence the caller can act on:
 *
 * - the primary failure stays primary, and stays UNCHANGED. Appending the
 *   secondary's text to `message` writes to an object VibORM does not own —
 *   which throws outright for a frozen Error or an accessor-backed `message`,
 *   and then the caller is told about a `TypeError` from evidence recording
 *   instead of the failure that produced it.
 * - the secondary failure stays inspectable beside it, because a caller sees ONE
 *   thrown value and anything that value does not carry is gone.
 * - the record of what failed lives HERE, in this module's own map, and never
 *   on the error. The error is not VibORM's object: a frozen one refuses the
 *   write outright, a Proxy can accept it and store nothing, and a visible
 *   property is a copy anything can rewrite afterwards.
 * - recording it cannot itself throw. Neither value is coerced, rendered, or
 *   assigned. The optional debugger mirror is attempted only when its name is
 *   unused, and every reflection or write refusal is contained.
 *
 * Not the transaction layer's `AggregateError` shape (`transactions.ts`): that
 * one REPLACES the primary, which is right where the caller is handed a
 * lifecycle report and wrong where the caller is handed the estate's own
 * failure. Here the primary is what the command already promised to report.
 */

/**
 * Where a failure MIRRORS its suppressed evidence.
 *
 * A named own property rather than a symbol: it is meant to be found by a human
 * reading a caught error in a debugger. It is non-enumerable so that it stays
 * out of every structured log line and JSON snapshot of the error. It is added
 * only when the name is unused; an existing property belongs to the caller and
 * must stay unchanged. The canonical reader never answers from this mirror.
 */
const SUPPRESSED_FAILURES_MIRROR = "suppressedFailures";

/**
 * The canonical ordered record, for every reference primary.
 *
 * Not a fallback for the errors that refused the property: THE record, written
 * first and read alone. A Proxy whose `defineProperty` trap answers `true`
 * without defining anything is the case that makes the distinction matter —
 * nothing throws, so a fallback keyed on the write's failure never fires and
 * the evidence is simply gone. Keyed weakly on the failure itself, so the
 * record lives precisely as long as the error a caller still holds.
 */
const RECORDED_SUPPRESSED_FAILURES = new WeakMap<object, readonly unknown[]>();

/** Whether a value can carry an own property or key a WeakMap. */
function isReference(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

/**
 * The secondary failures this module recorded against a thrown value, oldest
 * first.
 *
 * One source, and it is not the error: the question a caller asks is "what
 * secondary failures did VibORM retain", and only this module can answer it.
 * Reading the error's own `suppressedFailures` would answer "does this object
 * have a property with that name", which is a different question.
 */
export function readSuppressedFailures(thrown: unknown): readonly unknown[] {
  if (!isReference(thrown)) {
    return [];
  }
  return RECORDED_SUPPRESSED_FAILURES.get(thrown) ?? [];
}

/**
 * The value to throw for `primary`, now also carrying `secondary`.
 *
 * Returns `primary` ITSELF, at its exact identity, for every object — a frozen
 * Error, a Proxy that lies about the write, a proxy revoked afterwards, all of
 * them, because the record does not live on the value. A primary that is not an
 * object cannot key the record, and only then does the thrown value change
 * shape: an `AggregateError` whose `errors[0]` and `cause` are that primary, so
 * it is still the first thing anyone reads.
 */
export function withSuppressedFailure(
  primary: unknown,
  secondary: unknown
): unknown {
  if (!isReference(primary)) {
    // The carrier then carries the evidence the same way everything else does,
    // so one reader answers for every shape this rule can produce.
    return withSuppressedFailure(
      new AggregateError([primary, secondary], describe(primary), {
        cause: primary,
      }),
      secondary
    );
  }

  // Extends this module's OWN previous record, never an array found on the
  // error. Iterating a caller's array is running the caller's code at the exact
  // moment a failure is propagating, and a throw there does not lose
  // the secondary evidence — it replaces the primary with a report about the
  // recording. Frozen because the reader hands this array out, and the record
  // the next secondary extends must be the one this one wrote.
  const recorded = Object.freeze([
    ...(RECORDED_SUPPRESSED_FAILURES.get(primary) ?? []),
    secondary,
  ]);
  RECORDED_SUPPRESSED_FAILURES.set(primary, recorded);
  mirrorOnto(primary, recorded);
  return primary;
}

/**
 * Publishes the record onto the failure, for whoever opens it in a debugger.
 *
 * Best effort by definition, and by design: a frozen Error refuses the write, a
 * Proxy may accept it and store nothing, and a revoked one refuses everything.
 * None of that costs a caller evidence, because the record is already complete
 * before this runs and the canonical reader never uses the property.
 */
function mirrorOnto(primary: object, recorded: readonly unknown[]): void {
  try {
    if (
      Object.getOwnPropertyDescriptor(primary, SUPPRESSED_FAILURES_MIRROR) !==
      undefined
    ) {
      return;
    }
    Object.defineProperty(primary, SUPPRESSED_FAILURES_MIRROR, {
      configurable: true,
      enumerable: false,
      value: recorded,
      writable: true,
    });
  } catch {
    // An error VibORM does not own is entitled to refuse the write, and the
    // refusal is not this module's to report.
  }
}

/**
 * A message for the carrier, from a primary that is not an object.
 *
 * `String()` throws on a Symbol and runs a caller's `toString` on anything
 * else, so the coercion is attempted and its refusal answered — the carrier's
 * whole job is to keep both values, not to describe them.
 */
function describe(primary: unknown): string {
  try {
    return typeof primary === "string" ? primary : String(primary);
  } catch {
    return "The operation failed, with an additional suppressed failure.";
  }
}
