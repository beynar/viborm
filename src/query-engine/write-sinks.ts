import type { QueryExecutionContext } from "@drivers/types";

/**
 * What the write engine tells the official `on` extension while one
 * operation runs, keyed by that operation's attribution. Only an operation
 * a hook concerns has one, so every other write asks a WeakMap and moves on.
 */
export interface WriteSink {
  /** The arm a root `upsert` took: `true` when it created its row. */
  upserted(created: boolean): void;
}

export const writeSinks = new WeakMap<QueryExecutionContext, WriteSink>();
