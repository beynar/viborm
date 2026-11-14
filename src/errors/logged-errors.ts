/**
 * The line of successors the package makes from one failure.
 *
 * One failure can reach a caller as several error objects: a statement fails,
 * then the package clones its error to add the operation's execution context
 * or a commit certainty. Whoever presents failures (the official
 * instrumentation logs a statement's, then the operation's) needs to know
 * that two of them are one: `errorOrigin` gives the first of the line.
 *
 * A `WeakMap` holds no strong reference: an entry disappears with the error
 * that keyed it, so nothing survives a request in a reused isolate.
 */

const origins = new WeakMap<object, unknown>();

/** Record that the package made `successor` from `source`. */
export function recordErrorSuccessor(source: Error, successor: Error): void {
  origins.set(successor, origins.get(source) ?? source);
}

/** The first error `error` was made from, or `error` itself. */
export function errorOrigin(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (origins.get(error) ?? error)
    : error;
}
