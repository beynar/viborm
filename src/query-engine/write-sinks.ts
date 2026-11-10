import type { QueryExecutionContext } from "@drivers/types";

/**
 * What the write engine tells the official `on` extension while one
 * operation runs, keyed by that operation's attribution. Only an operation
 * a hook concerns has one, so every other write asks a WeakMap and moves on.
 */
export interface WriteSink {
  /** The arm a root `upsert` took: `true` when it created its row. */
  upserted(created: boolean): void;
  /** Does a hook want the rows a nested write `kind`s on `model`? */
  wants(model: string, kind: WriteKind): boolean;
  /**
   * Rows a nested write wrote to `model`, read in the operation's own unit:
   * as the write left them, as they were before a delete.
   */
  wrote(model: string, kind: WriteKind, rows: readonly object[]): void;
}

export type WriteKind = "create" | "update" | "delete";

export const writeSinks = new WeakMap<QueryExecutionContext, WriteSink>();
