/**
 * The handlers of `call` and `around`, in chain order, each with the calls
 * its target selects, and the handlers one call runs: found the first time
 * a (model, operation) asks, and kept for the chain.
 */
import { memo } from "@query-engine/raptor3/shared/schema";
import type { FirstMoment, runFirstMoments } from "./call";
import type { CallHandler } from "./chain-state";

/** One handler of a chain, and the calls it concerns. */
export interface TargetedHandler<
  Handler extends CallableFunction = CallableFunction,
> extends CallHandler<Handler> {
  /** The models and operations a target selects; every call without one. */
  readonly on?: {
    readonly models: ReadonlySet<string>;
    readonly operations: ReadonlySet<string>;
  };
  /** Placed nearest the core, after every other handler (`around`'s `inner`). */
  readonly inner?: boolean;
}

/** A chain's handlers of one moment, and the handlers one call runs. */
export interface TargetedHandlers<
  Handler extends CallableFunction = CallableFunction,
> {
  readonly placed: readonly TargetedHandler<Handler>[];
  /** The handlers without a target: the only ones a raw statement runs. */
  readonly global: readonly CallHandler<Handler>[];
  readonly handlers: (
    model: string | undefined,
    operation: string
  ) => readonly CallHandler<Handler>[] | undefined;
}

/** The first moments of `call` and `around`, and what runs them for one call. */
export interface CallHandlers extends TargetedHandlers<FirstMoment> {
  readonly apply: typeof runFirstMoments;
}

/** The lookup of `placed`, in its order. */
export function targetedHandlers<Handler extends CallableFunction>(
  placed: readonly TargetedHandler<Handler>[]
): TargetedHandlers<Handler> {
  const global = placed.filter((entry) => !entry.on);
  const found = new Map<string, readonly TargetedHandler<Handler>[]>();
  return {
    placed,
    global,
    handlers(model, operation) {
      if (model === undefined) return global.length > 0 ? global : undefined;
      const key = `${model}.${operation}`;
      const list = memo(found, key, () =>
        placed.filter(
          ({ on }) =>
            !on || (on.models.has(model) && on.operations.has(operation))
        )
      );
      return list.length > 0 ? list : undefined;
    },
  };
}
