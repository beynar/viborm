/**
 * The cache's units (`get`, `set`, `invalidate`, `revalidate`, and the
 * `delete` and `clear` an invalidation runs) and the outcomes of a read
 * (`hit`, a stale `hit`, `miss`, `bypass`, `cache-set-failed`), written with
 * the words any extension has: each step is a `cache` unit it emits
 * (`work`), its facts are noted on it, and each decision of a read is noted
 * on the call's `operation` unit (`note`). The instrumentation reads them
 * through `unit-facts.ts`.
 */
import { readDriverIdentity } from "@drivers/driver-identity";
import { getExecutionExtensionChain } from "@drivers/execution-context";
import type { QueryExecutionContext } from "@drivers/types";
import type { UnitContext } from "@extensions/contract";
import { work } from "@extensions/observation";
import { callOf, scopeOf } from "@extensions/origin";
import { note } from "@extensions/unit-words";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import type { CacheNote, CacheOutcome, CacheStep } from "./unit-facts";

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

/** One logical outcome of a cache step. */
export function cacheOutcome(
  event: CacheOutcome["event"],
  status?: string,
  error?: unknown
): CacheOutcome {
  return { event, status, at: Date.now(), error };
}

/**
 * Note one decision of a read on its call's `operation` unit; where no
 * handler runs around the call, nothing is kept.
 */
export function recordOutcome(
  context: CacheContext | undefined,
  event: CacheOutcome["event"],
  status?: string,
  error?: unknown
): void {
  if (context === undefined) return;
  const fact: CacheNote = { cacheOutcome: cacheOutcome(event, status, error) };
  note(context, fact);
}

/**
 * A background set failure joins its read's outcomes while that read's
 * operation still runs, so it presents after the logical miss; otherwise the
 * set unit presents it itself.
 */
export function placeSetFailure(
  backgroundOf: CacheContext,
  failure: unknown,
  unit: UnitContext
): void {
  const fact: CacheNote = {
    cacheOutcome: cacheOutcome("miss", "cache-set-failed", failure),
  };
  if (!note(backgroundOf, fact)) note(unit, fact);
}

/** Whether a handler runs around the units of `context`'s chain. */
const observed = (context: CacheContext | undefined): context is CacheContext =>
  context !== undefined &&
  getExecutionExtensionChain(context)?.observation !== undefined;

/**
 * Run one cache step as a `cache` unit of its execution's chain; `execute`
 * is handed the unit, to note what the step learns.
 */
export function cacheStep<T>(
  step: "clear" | "delete" | "get" | "invalidate" | "set",
  context: CacheContext | undefined,
  driverName: string,
  execute: (unit?: UnitContext) => Promise<T>,
  ttl?: number
): Promise<T> {
  // An unobserved step builds no unit. Measured on a no-op backend: without
  // this, a get allocates about 330 B more and takes about 16 ns longer.
  if (!observed(context)) return execute();
  const facts: CacheStep = {
    driver: driverName,
    ...(ttl === undefined ? {} : { ttl }),
    model: context.model,
    operation: context.operation,
  };
  return work(
    context,
    { kind: "cache", operation: step, note: { cache: facts } },
    execute
  );
}

/** How a revalidation's work and cleanup failed, when someone observes it. */
export interface RevalidationFailure {
  failed: boolean;
  error: unknown;
}

/**
 * Run one actual revalidation as its own `cache` unit when the chain has
 * handlers: `run` is handed the record of its failure to fill, and its
 * terminal outcome is noted on that unit.
 */
export async function revalidation(
  origin: CacheOrigin,
  model: string,
  operation: string,
  run: (failure: RevalidationFailure | undefined) => Promise<CacheOutcome>
): Promise<void> {
  const { context, driver } = origin;
  if (!observed(context)) {
    await run(undefined);
    return;
  }
  const failure: RevalidationFailure = { failed: false, error: undefined };
  const step: CacheStep = {
    read: { model, operation, driver: driver && readDriverIdentity(driver) },
    model: context.model,
    operation: context.operation,
  };
  await work(
    context,
    { kind: "cache", operation: "revalidate", note: { cache: step } },
    async (unit) => {
      const fact: CacheNote = { cacheOutcome: await run(failure) };
      note(unit, fact);
      if (failure.failed) throw failure.error;
    }
  );
}
