/**
 * Cross-layer record of errors core has already selected for a log.
 *
 * One failure crosses two observers: the driver's statement completion selects
 * the failing *statement* for the error log and the query engine's operation
 * completion selects the failing *operation*. Both would report the same error
 * object, so the statement completion marks what it selected, synchronously,
 * and the operation completion skips anything already marked. Core selects and
 * marks; the official instrumentation extension only formats. The record lives
 * in `src/errors/` so that core has no runtime edge into the extension.
 *
 * ## Why a module-scoped WeakSet, and not the instrumentation context
 *
 * The de-duplication marker does not belong in the instrumentation context: it
 * describes one thrown error, not the client-wide observer configuration, and
 * the same context serves concurrent operations.
 *
 * ## Why not a property on the error
 *
 * The error is handed to the caller. Stamping it (the former
 * `Object.defineProperty(error, "logged", …)`) made an internal
 * de-duplication convention part of the public error's shape, and it could not
 * mark a frozen error at all — such an error was logged twice.
 *
 * ## Serverless note
 *
 * `src/instrumentation/AGENTS.md` Rule 3 keeps mutable state out of module
 * scope so nothing survives a request in a reused isolate. A `WeakSet` holds
 * no strong reference: an entry disappears with the error that keyed it, and
 * an error object never outlives the request that threw it. There is nothing
 * here to go stale, and nothing to grow.
 */

const loggedErrors = new WeakSet<Error>();

/** Record that core has selected this error for a log. */
export function markErrorLogged(error: Error): void {
  loggedErrors.add(error);
}

/** Preserve the report record when package code replaces one failure with its successor. */
export function transferLoggedErrorEvidence(
  source: Error,
  successor: Error
): void {
  if (loggedErrors.has(source)) loggedErrors.add(successor);
}

/** Whether core has already selected this error for a log. */
export function isErrorLogged(error: Error): boolean {
  return loggedErrors.has(error);
}
