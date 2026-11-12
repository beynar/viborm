/**
 * What a language supplies to the engine: `docs/architecture/query-backend-frontier.md`.
 * The classes own what reads and writes mean and how rows decode. Their abstract
 * members are what is written in the language, and a backend that leaves one out
 * does not compile.
 */

import type { AnyModel } from "@schema/model";
import type { PreparedBatchOperation } from "../../types";
import type { Queries, Read } from "./query";
import type { Arguments } from "./schema";
import type { SqlOperationContext } from "./sql-operation-context";

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

/** What the engine asks of one call's context, whatever language writes it. */
export interface CallContext {
  /** Runs the call's body; `single` where a write is one statement. */
  run<T>(body: () => Promise<T>, single?: boolean): Promise<T>;
  publish(read: Read, missing?: () => Error): Promise<unknown>;
  publishPrepared(read: Read, missing?: () => Error): undefined;
  preparedBatch(): PreparedBatchOperation<unknown> | undefined;
  isIncompletePreparation(error: unknown): boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: a backend's context is its own class; the engine hands it back as it was made
export interface EngineBackend<Context extends CallContext = any> {
  readonly queries: new (
    ...args: ConstructorParameters<typeof Queries>
  ) => Queries;
  readonly context: new (
    ...args: ConstructorParameters<typeof SqlOperationContext>
  ) => Context;
  /** How a write runs in the backend's language: one statement where `single`. */
  readonly plan: (
    context: Context,
    model: AnyModel,
    args: Arguments,
    raw: Arguments
  ) => { readonly single: boolean; run(): Promise<unknown> };
}
