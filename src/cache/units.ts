/**
 * The cache's units (`get`, `set`, `invalidate`, `revalidate`, and the
 * `delete` and `clear` an invalidation runs) and the outcomes of a read
 * (`hit`, a stale `hit`, `miss`, `bypass`, `cache-set-failed`) that the
 * instrumentation presents on the operation.
 *
 * This is the one module of the cache that reaches past the public
 * contract: until extensions can emit a unit kind of their own and note facts
 * on an operation (`work`, `note`), it runs each step through the chain's
 * observers and hands the operation its outcome list. Rewiring the cache to
 * those words is a change of this module only.
 */
import { readDriverIdentity } from "@drivers/driver-identity";
import { getExecutionExtensionChain } from "@drivers/execution-context";
import type { QueryExecutionContext } from "@drivers/types";
import {
  getOfficialInstrumentationChainCapability,
  runProtectedObservers,
  selectTrustedObservers,
} from "@extensions/observation";
import type {
  CacheCompletionFacts,
  CacheOutcome,
  CacheUnitFacts,
} from "@extensions/official-facts";
import { callOf, scopeOf } from "@extensions/origin";
import {
  createOperationExecutionContext,
  noteOperationOutcomes,
} from "@query-engine/execution-context";

/** The execution a cache step belongs to: what correlates and observes it. */
export type CacheContext = QueryExecutionContext;

/** What a step reads of where it was asked: a call, its run, or a scope. */
export interface CacheOrigin {
  readonly context: CacheContext | undefined;
  /** The database driver of the call, which a revalidation presents. */
  readonly driver?: Parameters<typeof readDriverIdentity>[0];
}

/**
 * The execution a call, its run or a method's scope works in. A method has
 * no operation of its own: its invalidation is one, on its view's chain.
 */
export function originOf(x: object): CacheOrigin {
  const of = callOf(x)?.of;
  if (of !== undefined)
    return { context: of.context, driver: of.engine.driver };
  const scope = scopeOf(x);
  return {
    context:
      scope &&
      createOperationExecutionContext(
        "$cache",
        "$invalidate",
        scope.engine.extensionChain
      ),
  };
}

interface CacheOutcomeList {
  readonly outcomes: CacheOutcome[];
  /** Set once the operation completion has read the list. */
  completed: boolean;
}

/** One outcome list per logical cache execution, keyed by its context. */
const executionOutcomes = new WeakMap<CacheContext, CacheOutcomeList>();

const completeWithoutFacts = (): undefined => undefined;

/** One logical outcome of a cache step. */
export function cacheOutcome(
  event: CacheOutcome["event"],
  status?: string,
  error?: unknown
): CacheOutcome {
  return { event, status, at: Date.now(), error };
}

/** Record one decision of a read when the instrumentation wants outcomes. */
export function recordOutcome(
  context: CacheContext | undefined,
  event: CacheOutcome["event"],
  status?: string,
  error?: unknown
): void {
  if (
    context === undefined ||
    getOfficialInstrumentationChainCapability(
      getExecutionExtensionChain(context)
    )?.wants("cache-outcomes") !== true
  ) {
    return;
  }
  let list = executionOutcomes.get(context);
  if (list === undefined) {
    const opened: CacheOutcomeList = { outcomes: [], completed: false };
    list = opened;
    executionOutcomes.set(context, opened);
    noteOperationOutcomes(context, () => {
      opened.completed = true;
      return Object.freeze([...opened.outcomes]);
    });
  }
  list.outcomes.push(cacheOutcome(event, status, error));
}

/**
 * A background set failure joins its read's list while that list is still
 * open, so it presents after the logical miss; otherwise it completes the set
 * unit itself.
 */
function placeSetFailure(
  context: CacheContext,
  failure: unknown
): CacheCompletionFacts | undefined {
  const outcome = cacheOutcome("miss", "cache-set-failed", failure);
  const list = executionOutcomes.get(context);
  if (list !== undefined && !list.completed) {
    list.outcomes.push(outcome);
    return undefined;
  }
  return Object.freeze({ kind: "cache", outcomes: [outcome] });
}

/** What completes a background set's unit: its failure, placed. */
export const setCompletion =
  (backgroundOf: CacheContext | undefined): CacheUnitFacts["complete"] =>
  (outcome) =>
    backgroundOf !== undefined && outcome.status === "failure"
      ? placeSetFailure(backgroundOf, outcome.failure)
      : undefined;

/**
 * Run one cache step inside its execution's observers. A backend delete or
 * clear has no public unit and reaches only the trusted observer.
 */
export function cacheStep<T>(
  step: "clear" | "delete" | "get" | "invalidate" | "set",
  context: CacheContext | undefined,
  driverName: string,
  execute: () => Promise<T>,
  complete: CacheUnitFacts["complete"] = completeWithoutFacts,
  ttl?: number
): Promise<T> {
  const observers = getExecutionExtensionChain(context)?.observe;
  // An unobserved step builds no unit and no facts closure. Measured on a
  // no-op backend: without this, a get allocates about 330 B more and takes
  // about 16 ns longer.
  if (observers === undefined || observers.length === 0) return execute();
  const backend = step === "clear" || step === "delete";
  return runProtectedObservers(
    { kind: "cache", operation: backend ? "invalidate" : step },
    backend ? selectTrustedObservers(observers) : observers,
    execute,
    undefined,
    () =>
      Object.freeze(
        backend
          ? {
              kind: "cache-backend",
              boundary: step,
              driverName,
              complete: completeWithoutFacts,
            }
          : {
              kind: "cache",
              context,
              driverName,
              ...(ttl === undefined ? {} : { ttl }),
              complete,
            }
      )
  );
}

/** How a revalidation's work and cleanup failed, when someone observes it. */
export interface RevalidationFailure {
  failed: boolean;
  error: unknown;
}

/**
 * Run one actual revalidation as its own root unit when the chain has
 * observers: `work` is handed the record of its failure to fill.
 */
export async function revalidation(
  origin: CacheOrigin,
  model: string,
  operation: string,
  work: (failure: RevalidationFailure | undefined) => Promise<CacheOutcome>
): Promise<void> {
  const { context, driver } = origin;
  const observers = getExecutionExtensionChain(context)?.observe;
  if (observers === undefined || observers.length === 0) {
    await work(undefined);
    return;
  }
  const failure: RevalidationFailure = { failed: false, error: undefined };
  // The observed child stores its terminal outcome before it settles, and
  // the rail reads completion facts only after that.
  let completion: CacheCompletionFacts | undefined;
  await runProtectedObservers(
    { kind: "cache", operation: "revalidate" },
    observers,
    async () => {
      completion = Object.freeze({
        kind: "cache",
        outcomes: [await work(failure)],
      });
      if (failure.failed) throw failure.error;
    },
    undefined,
    (): CacheUnitFacts =>
      Object.freeze({
        kind: "cache",
        context,
        read: Object.freeze({
          model,
          operation,
          identity: driver && readDriverIdentity(driver),
        }),
        complete: () => completion,
      })
  );
}
