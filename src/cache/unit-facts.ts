/**
 * What the cache notes on the units it is part of, and the two readers an
 * observer uses: `cacheFacts` on a `cache` unit the cache emits (`work`),
 * `cacheOutcomes` on the `operation` unit of a cached call. This module does
 * not import the cache driver, so an extension that presents cache units
 * carries none of it.
 */
import type { DriverIdentity } from "@drivers/driver-identity";
import type { UnitContext } from "@extensions/contract";
import { notes } from "@extensions/unit-words";
import { isRecord } from "@validation/value-guards";

/** One cache decision of a logical execution. Never a key or a suffix. */
export interface CacheOutcome {
  readonly event: "bypass" | "hit" | "miss" | "revalidate";
  readonly status?: string | undefined;
  readonly at: number;
  readonly error?: unknown;
}

/** What a `cache` unit is about, noted as it starts. */
export interface CacheStep {
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
  readonly model?: string | undefined;
  readonly operation?: string | undefined;
}

/** One fact the cache notes. */
export type CacheNote =
  /** On a `cache` unit, as it starts. */
  | { readonly cache: CacheStep }
  /** On a `get` unit, once the backend answered. */
  | { readonly cacheResult: "hit" | "miss" | "stale" }
  /**
   * On a cached call's `operation` unit while it runs; else on the `set` or
   * `revalidate` unit it belongs to.
   */
  | { readonly cacheOutcome: CacheOutcome };

function isCacheNote(value: unknown): value is CacheNote {
  return (
    isRecord(value) &&
    ("cache" in value || "cacheResult" in value || "cacheOutcome" in value)
  );
}

/** What a `cache` unit is about and, once it settled, how it ended. */
export interface CacheFacts extends CacheStep {
  /** get: what the backend returned. */
  readonly result?: "hit" | "miss" | "stale";
  /** Outcomes this unit presents itself. */
  readonly outcomes: readonly CacheOutcome[];
}

/** The facts of a `cache` unit; `undefined` for any other unit. */
export function cacheFacts(unit: UnitContext): CacheFacts | undefined {
  let step: CacheStep | undefined;
  let result: CacheFacts["result"];
  const outcomes: CacheOutcome[] = [];
  for (const fact of notes(unit)) {
    if (!isCacheNote(fact)) continue;
    if ("cache" in fact) step = fact.cache;
    else if ("cacheResult" in fact) result = fact.cacheResult;
    else outcomes.push(fact.cacheOutcome);
  }
  if (step === undefined) return undefined;
  return { ...step, ...(result === undefined ? {} : { result }), outcomes };
}

/** The cache decisions noted on a cached call's `operation` unit, in order. */
export function cacheOutcomes(unit: UnitContext): readonly CacheOutcome[] {
  const outcomes: CacheOutcome[] = [];
  for (const fact of notes(unit))
    if (isCacheNote(fact) && "cacheOutcome" in fact)
      outcomes.push(fact.cacheOutcome);
  return outcomes;
}
