/**
 * Cache Driver
 *
 * Abstract base class for cache implementations.
 * Follows the same pattern as the database Driver class.
 * Handles both storage operations and cache orchestration (hit/miss/stale/SWR).
 */

import type { QueryExecutionContext } from "@drivers";
import {
  getExecutionExtensionChain,
  getExecutionInstrumentation,
} from "@drivers/execution-context";
import { CacheInvalidKeyError } from "@errors";
import { runProtectedObservers } from "@extensions/observation";
import {
  ATTR_CACHE_DRIVER,
  ATTR_CACHE_RESULT,
  ATTR_CACHE_TTL,
  SPAN_CACHE_CLEAR,
  SPAN_CACHE_DELETE,
  SPAN_CACHE_GET,
  SPAN_CACHE_INVALIDATE,
  SPAN_CACHE_SET,
  SPAN_OPERATION,
  type VibORMSpanName,
} from "@instrumentation/spans";
import type { VibORMSpanOptions } from "@instrumentation/tracer";
import type { LogEvent } from "@instrumentation/types";
import { type Clock, systemClock } from "../clock";
import {
  REVALIDATING_SUFFIX,
  REVALIDATING_TTL_MS,
  scheduleBackground,
} from "./cache-background";
import {
  type CacheLogEvent,
  completeOfficialCacheSetFailure,
  createCacheInstrumentationLogEvent,
  createCacheLifecycleInstrumentationFacts,
  emitCacheLogEvent,
  getCacheOperationAttributes,
  hasOfficialCacheInstrumentation,
  hasOfficialCacheLogging,
} from "./cache-instrumentation";
import {
  CACHE_PREFIX,
  generateUnprefixedCacheKey,
  OFFICIAL_CACHE_NAMESPACE_ROOT,
} from "./key";
import {
  type CacheInvalidationOptions,
  hasCacheInvalidationWork,
} from "./schema";

/** Extend a request lifetime until background cache work settles. */
export type WaitUntilFn = (promise: Promise<unknown>) => void;

/** Cache entry with freshness metadata for stale-while-revalidate. */
export interface CacheEntry<T = unknown> {
  value: T;
  createdAt: number;
  ttl: number;
}

/** Storage options for a cache write. */
export interface CacheSetOptions {
  /** Time to live in milliseconds. */
  ttl: number;
  /** Storage TTL including the stale window, when SWR is enabled. */
  swrTtl?: number;
}

/** Parsed options for one cached ORM execution. */
export interface CacheExecutionOptions {
  ttlMs: number;
  swr: number | false;
  bypass: boolean;
  key?: string;
  waitUntil?: WaitUntilFn;
  dbAttributes?: Record<string, string>;
  executionContext?: QueryExecutionContext;
}

type ObservedCacheOperation = "get" | "set" | "revalidate" | "invalidate";

interface DetachedCacheResultCodec<T> {
  snapshot(value: T): unknown;
  materialize(snapshot: unknown): T;
}

interface ObservedCacheSpanCompletion {
  readonly readSpanAttributes?: () =>
    | NonNullable<VibORMSpanOptions["attributes"]>
    | undefined;
  readonly logSetFailure?: boolean;
}

interface RevalidationPresentationState {
  terminalLogEvent?: Omit<LogEvent, "level">;
}

interface ObservedRevalidationFailure {
  failed: boolean;
  error: unknown;
}

type ExecuteCachedWithResultCodec = <T>(
  cache: CacheDriver,
  modelName: string,
  operation: string,
  args: unknown,
  executor: () => Promise<T>,
  options: CacheExecutionOptions,
  codec: DetachedCacheResultCodec<T>,
  scope: object
) => Promise<T>;

let executeCachedWithResultCodecFriend: ExecuteCachedWithResultCodec;

type InvalidateOfficialCache = (
  cache: CacheDriver,
  modelName: string,
  options: CacheInvalidationOptions | undefined,
  context: QueryExecutionContext | undefined,
  scope: object
) => Promise<void>;

let invalidateOfficialCacheFriend: InvalidateOfficialCache;

const officialCacheNamespaces = new WeakMap<object, string>();

/** Create one opaque scope recognized only by this module's private namespace map. */
export function createOfficialCacheScope(namespace: string): object {
  const scope = Object.freeze({});
  officialCacheNamespaces.set(scope, namespace);
  return scope;
}

function readOfficialCacheNamespace(scope: object): string {
  const namespace = officialCacheNamespaces.get(scope);
  if (namespace === undefined) {
    throw new CacheInvalidKeyError(
      "Official cache scope is not authentic for this cache execution."
    );
  }
  return namespace;
}

function refuseExternalScope(scope: unknown): void {
  if (scope === undefined) return;
  throw new CacheInvalidKeyError(
    "Cache driver methods do not accept an external cache scope."
  );
}

interface PreparedInvalidationTarget {
  readonly kind: "clear" | "delete";
  readonly prefixedKey: string;
}

/**
 * Abstract base class for cache drivers.
 *
 * Follows the same pattern as the database Driver class:
 * - Protected abstract methods for concrete implementations (non-underscored)
 * - Public underscored methods handle key prefixing, instrumentation, and delegation
 * - Instrumentation support
 * - Cache orchestration (hit/miss/stale/SWR logic)
 */
export abstract class CacheDriver {
  readonly driverName: string;
  /**
   * Every freshness decision this class makes reads from here. Internal seam,
   * not public API: it exists so tests can advance time rather than sleep
   * through a TTL. Defaults to the host clock.
   */
  protected readonly clock: Clock;

  static {
    executeCachedWithResultCodecFriend = (
      cache,
      modelName,
      operation,
      args,
      executor,
      options,
      codec,
      scope
    ) => {
      const namespace = readOfficialCacheNamespace(scope);
      return cache.#executeCached(
        modelName,
        operation,
        args,
        executor,
        options,
        codec,
        namespace
      );
    };
    invalidateOfficialCacheFriend = (
      cache,
      modelName,
      options,
      context,
      scope
    ) =>
      cache.invalidateScoped(
        modelName,
        options,
        context,
        readOfficialCacheNamespace(scope)
      );
  }

  constructor(driverName: string, clock: Clock = systemClock) {
    this.driverName = driverName;
    this.clock = clock;
  }

  // ============================================================
  // ABSTRACT METHODS - Concrete drivers implement these
  // ============================================================

  /**
   * Get a value from cache
   */
  protected abstract get<T>(key: string): Promise<CacheEntry<T> | null>;

  /**
   * Set a value in cache
   * @param key - The cache key
   * @param storageTtl - TTL for the backing store (already SWR-compliant)
   * @param entry - Cache entry with user's original TTL for staleness checks
   */
  protected abstract set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void>;

  /**
   * Delete keys from cache
   * @param keys - Array of keys to delete
   */
  protected abstract delete(keys: string[]): Promise<void>;

  /**
   * Clear cache by prefix
   * @param prefix - Always provided (at minimum CACHE_PREFIX to avoid clearing unrelated data)
   */
  protected abstract clear(prefix: string): Promise<void>;

  // ============================================================
  // CACHE ORCHESTRATION - Hit/Miss/Stale/SWR logic
  // ============================================================

  async #executeCached<T>(
    modelName: string,
    operation: string,
    args: unknown,
    executor: () => Promise<T>,
    options: CacheExecutionOptions,
    codec: DetachedCacheResultCodec<T>,
    namespace: string
  ): Promise<T> {
    const cacheKey = `${generateUnprefixedCacheKey(
      modelName,
      operation,
      args
    )}${options.key === undefined ? "" : `:${options.key}`}`;

    // Core execution logic
    const executeCore = async (): Promise<T> => {
      // Bypass cache read if requested
      if (options.bypass) {
        const result = await executor();
        this.setResultInBackground(cacheKey, result, options, codec, namespace);
        this.logExecutionCacheEvent(options, cacheKey, "bypass");
        return result;
      }

      // Try to get from cache
      const cached = await this.getCachedResult<T>(
        cacheKey,
        options.executionContext,
        namespace,
        codec
      );

      if (cached) {
        const age = this.clock.now() - cached.createdAt;
        const isStale = age > cached.ttl;

        if (!isStale) {
          // Fresh cache hit
          this.logExecutionCacheEvent(options, cacheKey, "hit");
          return cached.value;
        }

        const swrTtl = options.swr;
        if (swrTtl !== false) {
          // Stale but SWR enabled - return stale and revalidate in background
          scheduleBackground(
            this.revalidateInBackground(
              modelName,
              operation,
              cacheKey,
              executor,
              options,
              swrTtl,
              codec,
              namespace
            ),
            options.waitUntil
          );
          this.logExecutionCacheEvent(options, cacheKey, "hit", "stale");
          return cached.value;
        }

        // Stale and no SWR - fall through to fetch fresh
      }

      // Cache miss or stale without SWR - execute query
      const result = await executor();
      this.setResultInBackground(cacheKey, result, options, codec, namespace);
      this.logExecutionCacheEvent(options, cacheKey, "miss");
      return result;
    };

    return executeCore();
  }

  private async getCachedResult<T>(
    key: string,
    context: QueryExecutionContext | undefined,
    namespace: string,
    codec: DetachedCacheResultCodec<T>
  ): Promise<CacheEntry<T> | null> {
    const cached = await this.getScoped<unknown>(key, context, namespace);
    return cached === null
      ? null
      : {
          createdAt: cached.createdAt,
          ttl: cached.ttl,
          value: codec.materialize(cached.value),
        };
  }

  private setResultInBackground<T>(
    key: string,
    value: T,
    options: CacheExecutionOptions,
    codec: DetachedCacheResultCodec<T>,
    namespace: string
  ): void {
    let stored: unknown;
    try {
      stored = codec.snapshot(value);
    } catch (error) {
      this.logExecutionCacheEvent(
        options,
        key,
        "miss",
        "cache-set-failed",
        error
      );
      return;
    }
    this.setInBackground(key, stored, options, namespace);
  }

  /**
   * Set cache value in background (non-blocking)
   */
  private setInBackground<T>(
    key: string,
    value: T,
    options: CacheExecutionOptions,
    namespace: string
  ): void {
    const cachePromise = this.setScoped(
      key,
      value,
      {
        ttl: options.ttlMs,
        swrTtl: options.swr !== false ? options.swr : undefined,
      },
      options.executionContext,
      namespace,
      true
    ).catch((error) => {
      if (!hasOfficialCacheInstrumentation(options.executionContext)) {
        this.logExecutionCacheEvent(
          options,
          key,
          "miss",
          "cache-set-failed",
          error
        );
      }
    });

    scheduleBackground(cachePromise, options.waitUntil);
  }

  /**
   * Revalidate cache entry in background (for SWR)
   * Uses the backing cache marker for best-effort duplicate suppression.
   */
  private async revalidateInBackground<T>(
    modelName: string,
    operation: string,
    cacheKey: string,
    executor: () => Promise<T>,
    options: CacheExecutionOptions,
    swrTtl: number,
    codec: DetachedCacheResultCodec<T>,
    namespace: string
  ): Promise<void> {
    // Check whether another request has already published this marker.
    let shouldRevalidate: boolean;
    try {
      shouldRevalidate = await this.markRevalidatingScoped(cacheKey, namespace);
    } catch {
      // If marking fails, skip revalidation to avoid request failure
      return;
    }
    if (!shouldRevalidate) {
      // Another request is handling revalidation, skip
      return;
    }

    const observers = getExecutionExtensionChain(
      options.executionContext
    )?.observe;
    const observedFailure: ObservedRevalidationFailure | undefined =
      observers === undefined || observers.length === 0
        ? undefined
        : { failed: false, error: undefined };
    const officialPresentation = hasOfficialCacheInstrumentation(
      options.executionContext
    );
    const officialCacheLogging = hasOfficialCacheLogging(
      options.executionContext
    );
    const presentationState: RevalidationPresentationState = {};

    const doRevalidate = async () => {
      try {
        const result = await executor();
        const stored = codec.snapshot(result);
        await this.setScoped(
          cacheKey,
          stored,
          {
            ttl: options.ttlMs,
            swrTtl,
          },
          options.executionContext,
          namespace
        );

        if (officialPresentation) {
          if (officialCacheLogging) {
            presentationState.terminalLogEvent =
              createCacheInstrumentationLogEvent(
                options.executionContext,
                "revalidate",
                "success"
              );
          }
        } else {
          this.logExecutionCacheEvent(
            options,
            cacheKey,
            "revalidate",
            "success"
          );
        }
      } catch (error) {
        // Log error but don't throw - this is background operation
        if (observedFailure !== undefined) {
          observedFailure.failed = true;
          observedFailure.error = error;
        }
        if (officialPresentation) {
          if (officialCacheLogging) {
            presentationState.terminalLogEvent =
              createCacheInstrumentationLogEvent(
                options.executionContext,
                "revalidate",
                "error",
                error
              );
          }
        } else {
          this.logExecutionCacheEvent(
            options,
            cacheKey,
            "revalidate",
            "error",
            error
          );
        }
      } finally {
        if (observedFailure === undefined) {
          await this.clearRevalidatingScoped(cacheKey, namespace).catch(
            () => undefined
          );
        } else {
          try {
            await this.clearRevalidatingScoped(cacheKey, namespace);
          } catch (cleanupFailure) {
            if (observedFailure.failed) {
              const workerFailure = observedFailure.error;
              observedFailure.error = new AggregateError(
                [workerFailure, cleanupFailure],
                "Cache revalidation work and cleanup both failed.",
                { cause: workerFailure }
              );
            } else {
              observedFailure.failed = true;
              observedFailure.error = cleanupFailure;
            }
          }
        }
      }
    };

    const instrumentationFacts = officialPresentation
      ? createCacheLifecycleInstrumentationFacts({
          context: options.executionContext,
          spanName: SPAN_OPERATION,
          spanAttributes: getCacheOperationAttributes(
            modelName,
            operation,
            options.dbAttributes
          ),
          rootSpan: true,
          readStartLogEvents: () => [
            createCacheInstrumentationLogEvent(
              options.executionContext,
              "revalidate",
              "start"
            ),
          ],
          readCompletionLogEvents: () =>
            presentationState.terminalLogEvent === undefined
              ? undefined
              : [presentationState.terminalLogEvent],
        })
      : undefined;
    const revalidationPromise =
      observedFailure === undefined
        ? doRevalidate()
        : runProtectedObservers(
            { kind: "cache", operation: "revalidate" },
            observers,
            async () => {
              await doRevalidate();
              if (observedFailure.failed) throw observedFailure.error;
            },
            undefined,
            instrumentationFacts
          );

    await revalidationPromise;
  }

  /**
   * Log cache events
   */
  private logExecutionCacheEvent(
    options: CacheExecutionOptions,
    key: string,
    event: CacheLogEvent,
    status?: string,
    error?: unknown
  ): void {
    emitCacheLogEvent(key, event, status, error, options.executionContext);
  }

  // ============================================================
  // PUBLIC API - Storage operations
  // ============================================================

  /**
   * Get base attributes for tracing
   */
  getBaseAttributes(): Record<string, string> {
    return {
      [ATTR_CACHE_DRIVER]: this.driverName,
    };
  }

  /**
   * Wrap an operation with a cache span if tracer is available
   */
  private withSpan<T>(
    spanName: VibORMSpanName,
    execute: () => Promise<T>,
    extraAttributes?: Record<string, string>,
    context?: QueryExecutionContext,
    observedOperation?: ObservedCacheOperation,
    completion?: ObservedCacheSpanCompletion
  ): Promise<T> {
    if (observedOperation === undefined) {
      const tracer = getExecutionInstrumentation(context)?.tracer;
      return tracer === undefined
        ? execute()
        : tracer.startActiveSpan(
            {
              name: spanName,
              attributes: {
                ...this.getBaseAttributes(),
                ...extraAttributes,
              },
            },
            execute
          );
    }
    const observers = getExecutionExtensionChain(context)?.observe;
    if (observers === undefined || observers.length === 0) {
      return execute();
    }
    if (hasOfficialCacheInstrumentation(context)) {
      const instrumentationFacts = createCacheLifecycleInstrumentationFacts({
        context,
        driverName: this.driverName,
        spanName,
        spanAttributes: extraAttributes,
        readSpanAttributes: completion?.readSpanAttributes,
        readCompletionLogEvents:
          completion?.logSetFailure === true
            ? (outcome) =>
                outcome.status === "failure"
                  ? completeOfficialCacheSetFailure(context, outcome.failure)
                  : undefined
            : undefined,
      });
      return runProtectedObservers(
        { kind: "cache", operation: observedOperation },
        observers,
        () => execute(),
        undefined,
        instrumentationFacts
      );
    }
    return runProtectedObservers(
      { kind: "cache", operation: observedOperation },
      observers,
      execute
    );
  }

  /**
   * Get a value from cache
   * @param key - Cache key (will be prefixed automatically)
   */
  _get<T>(
    key: string,
    context?: QueryExecutionContext
  ): Promise<CacheEntry<T> | null>;
  async _get<T>(
    key: string,
    context?: QueryExecutionContext,
    externalScope?: unknown
  ): Promise<CacheEntry<T> | null> {
    refuseExternalScope(externalScope);
    return this.getScoped<T>(key, context);
  }

  private async getScoped<T>(
    key: string,
    context?: QueryExecutionContext,
    namespace?: string
  ): Promise<CacheEntry<T> | null> {
    const prefixedKey = this.prefixKey(key, namespace);
    let cacheResult: "hit" | "miss" | "stale" | undefined;

    return this.withSpan(
      SPAN_CACHE_GET,
      async () => {
        const entry = await this.get<T>(prefixedKey);
        if (entry) {
          const isStale = this.clock.now() - entry.createdAt > entry.ttl;
          cacheResult = isStale ? "stale" : "hit";
        } else {
          cacheResult = "miss";
        }
        return entry;
      },
      undefined,
      context,
      "get",
      {
        readSpanAttributes: () =>
          cacheResult === undefined
            ? undefined
            : { [ATTR_CACHE_RESULT]: cacheResult },
      }
    );
  }

  /**
   * Set a value in cache
   * @param key - Cache key (will be prefixed automatically)
   * @param value - Value to cache
   * @param options - Cache options including TTL
   */
  _set<T>(
    key: string,
    value: T,
    options: CacheSetOptions,
    context?: QueryExecutionContext
  ): Promise<void>;
  async _set<T>(
    key: string,
    value: T,
    options: CacheSetOptions,
    context?: QueryExecutionContext,
    externalScope?: unknown
  ): Promise<void> {
    refuseExternalScope(externalScope);
    return this.setScoped(key, value, options, context);
  }

  private async setScoped<T>(
    key: string,
    value: T,
    options: CacheSetOptions,
    context?: QueryExecutionContext,
    namespace?: string,
    logSetFailure = false
  ): Promise<void> {
    const prefixedKey = this.prefixKey(key, namespace);
    const entry: CacheEntry<T> = {
      value,
      createdAt: this.clock.now(),
      ttl: options.ttl,
    };

    // Use SWR TTL if provided, otherwise just use regular TTL
    const storageTtl = options.swrTtl ?? options.ttl;

    return this.withSpan(
      SPAN_CACHE_SET,
      () => this.set(prefixedKey, storageTtl, entry),
      { [ATTR_CACHE_TTL]: String(options.ttl) },
      context,
      "set",
      logSetFailure ? { logSetFailure: true } : undefined
    );
  }

  /**
   * Delete a specific key (and its revalidating key)
   * @param key - Cache key (will be prefixed automatically)
   */
  _delete(key: string, context?: QueryExecutionContext): Promise<void>;
  async _delete(
    key: string,
    context?: QueryExecutionContext,
    externalScope?: unknown
  ): Promise<void> {
    refuseExternalScope(externalScope);
    const prefixedKey = this.prefixKey(key);
    return this.deletePrefixed(prefixedKey, context);
  }

  /**
   * Clear cache by prefix or all within the public unscoped namespace.
   * @param prefix - Optional prefix to clear (will be prefixed automatically)
   */
  _clear(prefix?: string, context?: QueryExecutionContext): Promise<void>;
  async _clear(
    prefix?: string,
    context?: QueryExecutionContext,
    externalScope?: unknown
  ): Promise<void> {
    refuseExternalScope(externalScope);
    const prefixedPrefix = this.prefixKey(prefix ?? "");
    return this.clearPrefixed(prefixedPrefix, context);
  }

  /**
   * Mark entry as revalidating (for SWR coordination)
   * Returns true if this caller should perform revalidation
   * @param key - Cache key (will be prefixed automatically)
   */
  _markRevalidating(key: string): Promise<boolean>;
  async _markRevalidating(
    key: string,
    externalScope?: unknown
  ): Promise<boolean> {
    refuseExternalScope(externalScope);
    return this.markRevalidatingScoped(key);
  }

  private async markRevalidatingScoped(
    key: string,
    namespace?: string
  ): Promise<boolean> {
    const revalidatingKey = `${this.prefixKey(key, namespace)}${REVALIDATING_SUFFIX}`;

    // Check if already revalidating
    const existing = await this.get(revalidatingKey);
    if (existing) return false;

    // Set revalidating flag with short TTL
    const entry: CacheEntry<boolean> = {
      value: true,
      createdAt: this.clock.now(),
      ttl: REVALIDATING_TTL_MS,
    };
    await this.set(revalidatingKey, REVALIDATING_TTL_MS, entry);

    return true;
  }

  /**
   * Clear revalidating flag
   * @param key - Cache key (will be prefixed automatically)
   */
  _clearRevalidating(key: string): Promise<void>;
  async _clearRevalidating(
    key: string,
    externalScope?: unknown
  ): Promise<void> {
    refuseExternalScope(externalScope);
    return this.clearRevalidatingScoped(key);
  }

  private async clearRevalidatingScoped(
    key: string,
    namespace?: string
  ): Promise<void> {
    const revalidatingKey = `${this.prefixKey(key, namespace)}${REVALIDATING_SUFFIX}`;
    await this.delete([revalidatingKey]);
  }

  /**
   * Invalidate cache entries after a mutation
   * @param modelName - The model name for auto-invalidation
   * @param options - Cache invalidation options
   */
  _invalidate(
    modelName: string,
    options?: CacheInvalidationOptions,
    context?: QueryExecutionContext
  ): Promise<void>;
  async _invalidate(
    modelName: string,
    options?: CacheInvalidationOptions,
    context?: QueryExecutionContext,
    externalScope?: unknown
  ): Promise<void> {
    refuseExternalScope(externalScope);
    return this.invalidateScoped(modelName, options, context);
  }

  private async invalidateScoped(
    modelName: string,
    options?: CacheInvalidationOptions,
    context?: QueryExecutionContext,
    namespace?: string
  ): Promise<void> {
    if (!hasCacheInvalidationWork(options)) return;
    const targets: PreparedInvalidationTarget[] = [];
    if (options?.autoInvalidate) {
      targets.push({
        kind: "clear",
        prefixedKey: this.prefixKey(`${modelName}:`, namespace),
      });
    }
    if (options?.invalidate) {
      for (const entry of options.invalidate) {
        const isPrefix = entry.endsWith("*");
        const key = isPrefix ? entry.slice(0, -1) : entry;
        targets.push({
          kind: isPrefix ? "clear" : "delete",
          prefixedKey: this.prefixKey(key, namespace),
        });
      }
    }
    return this.withSpan(
      SPAN_CACHE_INVALIDATE,
      async () => {
        const promises: Promise<void>[] = [];
        for (const target of targets) {
          promises.push(
            target.kind === "clear"
              ? this.clearPrefixed(target.prefixedKey, context)
              : this.deletePrefixed(target.prefixedKey, context)
          );
        }
        await Promise.all(promises);
      },
      undefined,
      context,
      "invalidate"
    );
  }

  /**
   * Optional: connect to cache backend
   */
  connect?(): Promise<void>;

  /**
   * Optional: disconnect from cache backend
   */
  disconnect?(): Promise<void>;

  // ============================================================
  // INTERNAL HELPERS
  // ============================================================

  private deletePrefixed(
    prefixedKey: string,
    context?: QueryExecutionContext
  ): Promise<void> {
    const keys = [prefixedKey, `${prefixedKey}${REVALIDATING_SUFFIX}`];
    return this.withSpan(
      SPAN_CACHE_DELETE,
      () => this.delete(keys),
      undefined,
      context
    );
  }

  private clearPrefixed(
    prefixedKey: string,
    context?: QueryExecutionContext
  ): Promise<void> {
    return this.withSpan(
      SPAN_CACHE_CLEAR,
      () => this.clear(prefixedKey),
      undefined,
      context
    );
  }

  /**
   * Prefix a public storage key, or rebase an official relative key into its
   * authenticated extension namespace.
   *
   * An EMPTY relative key is the whole scope — `$invalidate("*")` — and it
   * rebases to `<scope>:`, WITH the separator, because the storage backends
   * clear by `startsWith`. A bare `<scope>` would also match every sibling scope
   * whose namespace string merely extends this one, and one axis of the scope
   * grammar can do that: the cache `version` is the last component and its `s:`
   * body is variable-length, so `version: "a"` is a strict prefix of
   * `version: "ab"` at the same dialect and namespace. That axis is exactly what
   * §7.1 leaves users to partition SQLite and unbound MySQL databases with, so a
   * clear-all crossing it would empty a physically different database's entries.
   *
   * Adding the separator loses nothing: every key this scope can hold is written
   * through `#executeCached`, whose relative key is always
   * `<model>:<operation>:<hash>`, so no stored key is ever equal to the bare
   * scope. The unscoped arm below deliberately keeps its bare `viborm` root — a
   * public caller CAN store at exactly that key, there is only one such root,
   * and no sibling exists for a clear to cross into.
   */
  private prefixKey(key: string, namespace?: string): string {
    if (namespace !== undefined) {
      if (key.startsWith(`${CACHE_PREFIX}:`)) {
        throw new CacheInvalidKeyError(
          "Official cache keys and prefixes must be relative and cannot begin with 'viborm:'."
        );
      }
      return `${namespace}:${key}`;
    }

    const prefixedKey = key.startsWith(`${CACHE_PREFIX}:`)
      ? key
      : key
        ? `${CACHE_PREFIX}:${key}`
        : CACHE_PREFIX;
    if (
      prefixedKey === OFFICIAL_CACHE_NAMESPACE_ROOT ||
      prefixedKey.startsWith(`${OFFICIAL_CACHE_NAMESPACE_ROOT}:`)
    ) {
      throw new CacheInvalidKeyError(
        "The official cache namespace requires an authenticated cache extension."
      );
    }
    return prefixedKey;
  }
}

/** Internal cache-result seam; absent from the package cache barrel. */
export function executeCachedWithResultCodec<T>(
  cache: CacheDriver,
  modelName: string,
  operation: string,
  args: unknown,
  executor: () => Promise<T>,
  options: CacheExecutionOptions,
  codec: DetachedCacheResultCodec<T>,
  scope: object
): Promise<T> {
  return executeCachedWithResultCodecFriend(
    cache,
    modelName,
    operation,
    args,
    executor,
    options,
    codec,
    scope
  );
}

/** Internal official invalidation seam; absent from the package cache barrel. */
export function invalidateOfficialCache(
  cache: CacheDriver,
  modelName: string,
  options: CacheInvalidationOptions | undefined,
  context: QueryExecutionContext | undefined,
  scope: object
): Promise<void> {
  return invalidateOfficialCacheFriend(
    cache,
    modelName,
    options,
    context,
    scope
  );
}
