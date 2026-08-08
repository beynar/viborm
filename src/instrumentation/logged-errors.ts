/**
 * Cross-layer record of errors the driver layer has already reported.
 *
 * One failure crosses two observers: the driver logs the failing *statement*
 * (`logQuery`) and the query engine logs the failing *operation*. Both would
 * report the same error object, so the driver marks what it has reported and
 * the engine skips anything already marked.
 *
 * ## Why a module-scoped WeakSet, and not the instrumentation context
 *
 * Execution snapshots reference the same `InstrumentationContext` through the
 * weak mapping in `src/drivers/execution-context.ts`. The de-duplication marker
 * still does not belong in that context: it describes one thrown error, not the
 * client-wide observer configuration, and the same context serves concurrent
 * operations.
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

/** Record that this error has been reported to the logger. */
export function markErrorLogged(error: Error): void {
  loggedErrors.add(error);
}

/** Whether this error has already been reported to the logger. */
export function isErrorLogged(error: Error): boolean {
  return loggedErrors.has(error);
}
