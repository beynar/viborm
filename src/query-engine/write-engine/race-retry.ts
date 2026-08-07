import {
  classifyFailure,
  isVibORMError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import type { TargetConstraintPin } from "./OperationFragment";

/**
 * Write-race retry classification. The retry itself lives **above** the executor
 * (in the routed
 * `PendingOperation` lifecycle); this module only decides *whether* a surfaced
 * error is a retryable race and lets the executor **mark** the ones it pinned.
 *
 * Two retryable classes, exactly V1's:
 *   1. a `UniqueConstraintError` whose normalized provider attribution matches a
 *      failed write step's `racePin` (the create-branch loser — ATOM “The execution vocabulary”), or a
 *      deadlock/serialization failure raised while a `racePin` write was in
 *      flight — the executor marks these via {@link markRaceable};
 *   2. any EXPECTED failure already carrying `meta.raceable === true` (the guard
 *      abort classes: materialized-set pins, the M2M symmetric-difference
 *      guards) — recognized from the error itself, no marking needed. "Expected"
 *      is {@link classifyFailure}'s verdict: a defect is never a race.
 *
 * A violation that matches **no** racePin and is not `meta.raceable` is not a
 * race: it propagates without retry (both directions are proven by test).
 */

// Errors the executor pinned as retryable races. A WeakSet keeps the marking
// invisible to every consumer (error type, message, and enumerable meta are
// untouched — an existing race test still sees a plain UniqueConstraintError).
const PINNED_RETRYABLE_RACES = new WeakSet<object>();

/** Mark an error the executor pinned as a retryable race (class 1 above). */
export function markRaceable(error: unknown): void {
  if (typeof error === "object" && error !== null) {
    PINNED_RETRYABLE_RACES.add(error);
  }
}

/**
 * Whether a surfaced error is a retryable write race (V1's
 * `isExplicitProgramRace`): pinned by the executor, or self-declared
 * `meta.raceable`.
 *
 * The self-declared arm reads {@link classifyFailure} rather than `isVibORMError`, which is the
 * same single check with the semantics spelled out: only an EXPECTED failure can be a race. A
 * defect — an engine invariant break, a raw throwable — is never re-run, whatever metadata it
 * happens to be wearing. Every error that actually carries `meta.raceable` is a
 * guard abort raised by `failureError` / `query-engine/batch-error-attribution.ts` —
 * a `NestedWriteError`, or the upsert skip premise's `TransactionError`
 * (`raceableQueryFailure`) — and both classify as expected, so the once-only
 * retry policy and the set of errors that retry are unchanged.
 */
export function isRetryableRace(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    PINNED_RETRYABLE_RACES.has(error)
  )
    return true;
  const classified = classifyFailure(error);
  return (
    classified.kind === "failure" && classified.error.meta.raceable === true
  );
}

/**
 * Classify a failed write step's error against its `racePin` and mark it
 * retryable when it matches (V1's `markRetryableRace`). The step's mere carrying
 * of a `racePin` means the pin is the exact single unique target (the fragment
 * builder only attaches exact pins — Pin Rule class 2), so no `isExact` gate is
 * needed here. Called by the executor from inside the atomic scope.
 */
export function markRaceIfPinned(
  error: unknown,
  pin: TargetConstraintPin
): void {
  if (error instanceof UniqueConstraintError) {
    if (racePinMatches(error, pin)) markRaceable(error);
    return;
  }
  if (
    isVibORMError(error) &&
    (error.code === VibORMErrorCode.DEADLOCK ||
      error.code === VibORMErrorCode.SERIALIZATION_FAILURE)
  ) {
    markRaceable(error);
  }
}

/**
 * Does a unique violation's normalized provider metadata identify the pinned
 * constraint? A faithful port of V1's `matchesPinnedUniqueConstraint`
 * (`OperationRuntime.ts`): the race is classified to the pin only when the
 * provider attributes the pinned table AND matching columns or constraint name.
 * Missing or contradictory attribution fails closed (returns false → no retry).
 */
export function racePinMatches(
  error: UniqueConstraintError,
  pin: TargetConstraintPin
): boolean {
  const meta = error.meta as {
    table?: string;
    columns?: string[];
    constraint?: string;
  };
  if (
    meta.table &&
    normalizeIdentifier(meta.table) !== normalizeIdentifier(pin.table)
  ) {
    return false;
  }
  let hasTargetAttribution = false;
  if (meta.columns) {
    hasTargetAttribution = true;
    const actual = meta.columns.map(normalizeIdentifier).sort();
    const expected = pin.columns.map(normalizeIdentifier).sort();
    if (actual.length !== expected.length) return false;
    if (!actual.every((column, index) => column === expected[index])) {
      return false;
    }
  }
  if (meta.constraint) {
    hasTargetAttribution = true;
    const expected = new Set(pin.constraints.map(normalizeIdentifier));
    if (!expected.has(normalizeIdentifier(meta.constraint))) return false;
  }
  return hasTargetAttribution;
}

function normalizeIdentifier(identifier: string): string {
  const segments = identifier.split(".");
  return (segments.at(-1) ?? identifier).replace(/["`[\]]/g, "").toLowerCase();
}
