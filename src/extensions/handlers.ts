/**
 * The handlers of `request` and `query`, compiled once per chain: one frozen
 * array for each exact (model, operation) a definition names, and one for
 * every other call.
 */
import type { FirstMoment, runFirstMoments } from "./call";
import type { Application } from "./chain";
import type {
  ResolvedExtensionChain,
  ResolvedExtensionOperationLookup,
  ResolvedOperationHandler,
} from "./chain-state";

/** A compiled lookup, and the handlers one call runs. */
export interface OperationHandlers<
  Handler extends CallableFunction = CallableFunction,
> extends ResolvedExtensionOperationLookup<Handler> {
  /**
   * The precompiled array itself: lookup scans and merges nothing. A call
   * of no model (raw SQL) runs only the handlers of every call, and only
   * where they may run on one.
   */
  readonly handlers: (
    model: string | undefined,
    operation: string
  ) => readonly ResolvedOperationHandler<Handler>[] | undefined;
}

/** The first moments of `call` and `around`, and what runs them for one call. */
export interface RequestHandlers extends OperationHandlers<FirstMoment> {
  readonly apply: typeof runFirstMoments;
}

/**
 * `previous` with one definition's `request` or `query` appended. Every
 * array of `previous` is copied, so the chain it belongs to keeps its own.
 */
export function compileHandlers<Handler extends CallableFunction>(
  previous: ResolvedExtensionOperationLookup<Handler> | undefined,
  owner: Application["owner"],
  contribution:
    | Handler
    | Readonly<Record<string, Readonly<Record<string, Handler>>>>
    | undefined,
  raw: boolean
): OperationHandlers<Handler> {
  const own = (handler: Handler): ResolvedOperationHandler<Handler> =>
    Object.freeze(
      owner.controls === undefined
        ? { extension: owner.name, handler }
        : { extension: owner.name, handler, controls: owner.controls }
    );
  const global = [...(previous?.global ?? [])];
  const models: Record<
    string,
    Record<string, ResolvedOperationHandler<Handler>[]>
  > = Object.create(null);
  for (const [model, operations] of Object.entries(previous?.models ?? {})) {
    const copied: Record<string, ResolvedOperationHandler<Handler>[]> =
      Object.create(null);
    for (const [operation, handlers] of Object.entries(operations))
      copied[operation] = [...handlers];
    models[model] = copied;
  }
  if (typeof contribution === "function") {
    const handler = own(contribution);
    global.push(handler);
    for (const operations of Object.values(models))
      for (const handlers of Object.values(operations)) handlers.push(handler);
  } else if (contribution !== undefined) {
    for (const [model, operations] of Object.entries(contribution)) {
      for (const [operation, handler] of Object.entries(operations)) {
        const modelOperations = (models[model] ??= Object.create(null));
        (modelOperations[operation] ??= [...global]).push(own(handler));
      }
    }
  }
  const frozen: Record<
    string,
    Readonly<Record<string, readonly ResolvedOperationHandler<Handler>[]>>
  > = Object.create(null);
  for (const [model, operations] of Object.entries(models)) {
    for (const handlers of Object.values(operations)) Object.freeze(handlers);
    frozen[model] = Object.freeze(operations);
  }
  const every = global.length === 0 ? undefined : Object.freeze(global);
  return {
    global: every ?? Object.freeze([]),
    models: Object.freeze(frozen),
    handlers: (model, operation) =>
      model === undefined
        ? raw
          ? every
          : undefined
        : (frozen[model]?.[operation] ?? every),
  };
}

/** Whether `lookup` holds a handler for some call. */
export function hasCompiledHandlers(
  lookup: ResolvedExtensionOperationLookup
): boolean {
  if (lookup.global.length > 0) return true;
  for (const operations of Object.values(lookup.models)) {
    if (Object.keys(operations).length > 0) return true;
  }
  return false;
}

/** The handlers one call of `chain` runs, as its `request` or `query` answers. */
export function lookupResolvedExtensionHandlers(
  chain: ResolvedExtensionChain | undefined,
  component: "request" | "query",
  model: string | undefined,
  operation: string
): readonly ResolvedOperationHandler[] | undefined {
  return chain?.[component]?.handlers(model, operation);
}
