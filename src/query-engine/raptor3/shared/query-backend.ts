/**
 * What a language supplies to the engine: `docs/architecture/query-backend-frontier.md`.
 * The classes own what reads and writes mean and how rows decode. Their abstract
 * members are what is written in the language, and a backend that leaves one out
 * does not compile.
 */

import type { OperationContext } from "./operation-context";
import type { Queries } from "./query";

export interface QueryBackend {
  readonly queries: new (
    ...args: ConstructorParameters<typeof Queries>
  ) => Queries;
  readonly context: new (
    ...args: ConstructorParameters<typeof OperationContext>
  ) => OperationContext;
}
