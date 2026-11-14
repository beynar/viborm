/**
 * The handlers of `call` and `around`, in chain order, each with the calls
 * its target selects, and the handlers one call runs: found the first time
 * a (model, operation) asks, and kept for the chain.
 */
import type { FirstMoment, runFirstMoments } from "./call";
import type { ResolvedOperationHandler } from "./chain-state";

/** One handler of a chain, and the calls it concerns. */
export interface PlacedHandler<
  Handler extends CallableFunction = CallableFunction,
> extends ResolvedOperationHandler<Handler> {
  /** The models and operations a target selects; every call without one. */
  readonly on?: {
    readonly models: ReadonlySet<string>;
    readonly operations: ReadonlySet<string>;
  };
  /** Placed nearest the core, after every other handler (`around`'s `inner`). */
  readonly inner?: boolean;
}

/** A chain's handlers of one moment, and the handlers one call runs. */
export interface OperationHandlers<
  Handler extends CallableFunction = CallableFunction,
> {
  readonly placed: readonly PlacedHandler<Handler>[];
  /** The handlers without a target: the only ones a raw statement runs. */
  readonly global: readonly ResolvedOperationHandler<Handler>[];
  readonly handlers: (
    model: string | undefined,
    operation: string
  ) => readonly ResolvedOperationHandler<Handler>[] | undefined;
}

/** The first moments of `call` and `around`, and what runs them for one call. */
export interface RequestHandlers extends OperationHandlers<FirstMoment> {
  readonly apply: typeof runFirstMoments;
}

/** The lookup of `placed`, in its order. */
export function handlersOf<Handler extends CallableFunction>(
  placed: readonly PlacedHandler<Handler>[]
): OperationHandlers<Handler> {
  const global = Object.freeze(placed.filter((entry) => !entry.on));
  const found = new Map<string, readonly PlacedHandler<Handler>[]>();
  return {
    placed,
    global,
    handlers(model, operation) {
      if (model === undefined) return global.length > 0 ? global : undefined;
      const key = `${model}.${operation}`;
      let list = found.get(key);
      if (list === undefined) {
        list = Object.freeze(
          placed.filter(
            ({ on }) =>
              !on || (on.models.has(model) && on.operations.has(operation))
          )
        );
        found.set(key, list);
      }
      return list.length > 0 ? list : undefined;
    },
  };
}
