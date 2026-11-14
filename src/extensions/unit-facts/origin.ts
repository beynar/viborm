import { errorOrigin } from "../../errors/logged-errors";

/**
 * The first error of a line of successors the package made from it (a clone
 * that adds execution context or commit certainty); the error itself when
 * it has none. Two units that fail with errors of one origin failed once.
 */
export const origin = (error: unknown): unknown => errorOrigin(error);
