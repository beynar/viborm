/**
 * What the cache says about its own units, read on demand: `cacheFacts` on a
 * `cache` unit, `cacheOutcomes` on the `operation` unit a cached read runs
 * in. This module does not import the cache driver, so an extension that
 * presents cache units carries none of it.
 */
import type { DriverIdentity } from "@drivers/driver-identity";
import type { QueryExecutionContext } from "@drivers/types";
import {
  type CacheCompletion,
  type CacheOutcome,
  sourceOf,
  type Unit,
  type UnitSource,
} from "@extensions/unit-source";

export type { CacheOutcome } from "@extensions/unit-source";

/** One logical execution's cache decisions, open while its operation runs. */
export interface CacheOutcomeList {
  readonly outcomes: CacheOutcome[];
  /** Set once the operation's reader has read the list. */
  completed: boolean;
}

/**
 * The lists opened by `cacheOutcomes`, by the execution context the cache
 * records against. Without one open, the cache records nothing.
 */
export const executionOutcomes = new WeakMap<
  QueryExecutionContext,
  CacheOutcomeList
>();

const NO_OUTCOMES: readonly CacheOutcome[] = Object.freeze([]);

/**
 * Called on an `operation` unit before `next()`: opens the list the cache
 * fills while the call runs. The function it returns closes and reads it.
 */
export function cacheOutcomes(unit: Unit): () => readonly CacheOutcome[] {
  const context = sourceOf(unit)?.context;
  if (context === undefined) return () => NO_OUTCOMES;
  let list = executionOutcomes.get(context);
  if (list === undefined) {
    list = { outcomes: [], completed: false };
    executionOutcomes.set(context, list);
  }
  const open = list;
  return () => {
    open.completed = true;
    return Object.freeze([...open.outcomes]);
  };
}

/** What a `cache` unit is about, and, once it settled, how it ended. */
export interface CacheFacts {
  /** The cache backend's name; absent for a revalidation. */
  readonly driver?: string;
  /** set: the entry's lifetime in milliseconds. */
  readonly ttl?: number;
  /** revalidate: the replayed read, a root operation of its own. */
  readonly read?: {
    readonly model: string;
    readonly operation: string;
    readonly driver: DriverIdentity | undefined;
  };
  /** The model and operation of the logical call the step belongs to. */
  readonly model?: string;
  readonly operation?: string;
  /** get, once settled: what the backend returned. */
  readonly result?: "hit" | "miss" | "stale";
  /**
   * Once settled: a background set failure no open list took, or a
   * revalidation's terminal outcome.
   */
  readonly outcomes?: readonly CacheOutcome[];
}

/** Each settled step's completion, computed once: placing it has effects. */
const completions = new WeakMap<UnitSource, CacheCompletion | undefined>();

/** The facts of a `cache` unit; `undefined` for any other unit. */
export function cacheFacts(unit: Unit): CacheFacts | undefined {
  const source = sourceOf(unit);
  const cache = source?.cache;
  if (source === undefined || cache === undefined) return undefined;
  let completion: CacheCompletion | undefined;
  if (source.failed !== undefined) {
    if (completions.has(source)) completion = completions.get(source);
    else {
      completion = cache.complete?.(source.failed, source.failure);
      completions.set(source, completion);
    }
  }
  const { context } = source;
  return {
    ...(cache.driver === undefined ? {} : { driver: cache.driver }),
    ...(cache.ttl === undefined ? {} : { ttl: cache.ttl }),
    ...(cache.read === undefined ? {} : { read: cache.read }),
    ...(context?.model === undefined ? {} : { model: context.model }),
    ...(context?.operation === undefined
      ? {}
      : { operation: context.operation }),
    ...(completion?.result === undefined ? {} : { result: completion.result }),
    ...(completion?.outcomes === undefined
      ? {}
      : { outcomes: completion.outcomes }),
  };
}
