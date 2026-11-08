/**
 * What a language supplies to the engine: `docs/architecture/query-backend-frontier.md`.
 * The classes own what reads and writes mean and how rows decode. Their abstract
 * members are what is written in the language, and a backend that leaves one out
 * does not compile.
 */

import type { OperationContext } from "./operation-context";
import type { Queries } from "./query";

declare const OPAQUE: unique symbol;

/**
 * A driver's backend as the published types see it: opaque, so the engine's
 * classes stay out of every entry's declarations. {@link engineBackend} is the
 * one crossing back.
 */
export interface QueryBackend {
  readonly [OPAQUE]: "QueryBackend";
}

/** What a driver states as its backend. */
export const queryBackend = (backend: EngineBackend): QueryBackend =>
  backend as never;

/** What the engine reads of a driver's backend. */
export const engineBackend = (backend: QueryBackend): EngineBackend =>
  backend as never;

export interface EngineBackend {
  readonly queries: new (
    ...args: ConstructorParameters<typeof Queries>
  ) => Queries;
  readonly context: new (
    ...args: ConstructorParameters<typeof OperationContext>
  ) => OperationContext;
}
