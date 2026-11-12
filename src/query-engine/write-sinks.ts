import type { QueryExecutionContext } from "@drivers/types";
import type { AnyModel } from "@schema/model";
import type { PreparedProjection, Queries } from "./raptor3/shared/query";
import type { Arguments, Input } from "./raptor3/shared/schema";

/**
 * What asked to see the rows one call writes, keyed by that call's
 * attribution. Only a call something watches has one, so every other write
 * asks a WeakMap and moves on. The engine names what it asks and holds none
 * of what answers: what watches brings it.
 */
export interface WriteSink {
  /** Are the rows a write `kind`s on `model` to be shown? */
  wants(model: string, kind: WriteKind): boolean;
  /** What watches one run of the call's writes: a run made again starts another. */
  attempt(): WriteWatch;
}

/** One run of a call's writes, as what watches it is told. */
export interface WriteWatch {
  wants(model: string, kind: WriteKind): boolean;
  /**
   * Rows the call wrote to `model` through a relation, whole: as the write
   * left them, as they were before a delete.
   */
  shows(model: string, kind: WriteKind, rows: readonly object[]): void;
  /**
   * The call's own rows, where something wants one of `kinds`: the
   * projection that reads them whole beside what the caller selected, and
   * what shows the rows read, then cuts them back to what the caller asked.
   */
  own(
    queries: Queries,
    model: AnyModel,
    args: Arguments,
    kinds: readonly WriteKind[]
  ):
    | {
        readonly projection: PreparedProjection;
        cut(rows: Input[], kind: WriteKind | undefined): Input[];
      }
    | undefined;
  /** Every write of the run is made. */
  done(): void;
}

export type WriteKind = "create" | "update" | "delete";

export const writeSinks = new WeakMap<QueryExecutionContext, WriteSink>();
