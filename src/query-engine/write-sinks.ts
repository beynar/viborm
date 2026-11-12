import type { QueryExecutionContext } from "@drivers/types";

/**
 * What asked to see the rows one call writes, keyed by that call's
 * attribution. Only a call something watches has one, so every other write
 * asks a WeakMap and moves on.
 */
export interface WriteSink {
  /** Are the rows a write `kind`s on `model` to be shown? */
  wants(model: string, kind: WriteKind): boolean;
  /**
   * Rows the call wrote to `model`, whole, told once every write of the call
   * is made: as the write left them, as they were before a delete. `nested`:
   * written through a relation, not by the call's own verb.
   */
  wrote(
    model: string,
    kind: WriteKind,
    rows: readonly object[],
    nested: boolean
  ): void;
  /** Every row the call wrote was told. */
  done(): void;
}

export type WriteKind = "create" | "update" | "delete";

export const writeSinks = new WeakMap<QueryExecutionContext, WriteSink>();
