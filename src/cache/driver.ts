/**
 * Cache Driver
 *
 * Abstract base class for cache implementations.
 * Follows the same pattern as the database Driver class.
 * Handles both storage operations and cache orchestration (hit/miss/stale/SWR).
 */

import type { QueryExecutionContext } from "@drivers";
import { getExecutionInstrumentation } from "@drivers/execution-context";
import type { InstrumentationContext } from "@instrumentation/context";
import { runWithTracer } from "@instrumentation/run-with-tracer";
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
import type { Span } from "@instrumentation/tracer";
import { type Clock, systemClock } from "../clock";
import {
  REVALIDATING_SUFFIX,
  REVALIDATING_TTL_MS,
  scheduleBackground,
} from "./cache-background";
import type {
  CacheEntry,
  CacheExecutionOptions,
  CacheSetOptions,
} from "./cache-contract";
import {
  type CacheLogEvent,
  emitCacheLogEvent,
  getCacheOperationAttributes,
  getCacheTracer,
  setSpanAttribute,
} from "./cache-instrumentation";
import { CACHE_PREFIX, generateUnprefixedCacheKey } from "./key";
import type { CacheInvalidationOptions } from "./schema";

export type {
  CacheEntry,
  CacheExecutionOptions,
  CacheSetOptions,
} from "./cache-contract";

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
  protected instrumentation?: InstrumentationContext;
  protected version?: string | number;
  /**
   * Every freshness decision this class makes reads from here. Internal seam,
   * not public API: it exists so tests can advance time rather than sleep
   * through a TTL. Defaults to the host clock.
   */
  protected readonly clock: Clock;

  constructor(driverName: string, clock: Clock = systemClock) {
    this.driverName = driverName;
    this.clock = clock;
  }

  /**
   * Set cache version for key prefixing
   */
  setVersion(version: string | number | undefined): void {
    this.version = version;
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

  /**
   * Execute an operation with caching
   *
   * Handles the full cache flow:
   * - Cache key generation
   * - Hit/miss/stale detection
   * - SWR (stale-while-revalidate) pattern
   * - Background revalidation with thundering herd prevention
   * - Instrumentation (operation span + cache event logging)
   *
   * @param modelName - Model name for key generation and logging
   * @param operation - Operation name (findMany, findFirst, etc.)
   * @param args - Operation arguments for key generation
   * @param executor - Function to execute when cache miss
   * @param options - Cache options (ttl, swr, bypass, key, waitUntil, dbAttributes)
   */
  async _executeCached<T>(
    modelName: string,
    operation: string,
    args: unknown,
    executor: () => Promise<T>,
    options: CacheExecutionOptions
  ): Promise<T> {
    // Generate cache key (unprefixed - prefixKey() adds the prefix)
    const cacheKey =
      options.key ?? generateUnprefixedCacheKey(modelName, operation, args);

    // Core execution logic
    const executeCore = async (): Promise<T> => {
      // Bypass cache read if requested
      if (options.bypass) {
        const result = await executor();
        this.setInBackground(cacheKey, result, options);
        this.logExecutionCacheEvent(options, cacheKey, "bypass");
        return result;
      }

      // Try to get from cache
      const cached = await this._get<T>(cacheKey, options.executionContext);

      if (cached) {
        const age = this.clock.now() - cached.createdAt;
        const isStale = age > cached.ttl;

        if (!isStale) {
          // Fresh cache hit
          this.logExecutionCacheEvent(options, cacheKey, "hit");
          return cached.value;
        }

        if (options.swr !== false) {
          // Stale but SWR enabled - return stale and revalidate in background
          this.revalidateInBackground(
            modelName,
            operation,
            cacheKey,
            executor,
            options
          ).catch(() => undefined);
          this.logExecutionCacheEvent(options, cacheKey, "hit", "stale");
          return cached.value;
        }

        // Stale and no SWR - fall through to fetch fresh
      }

      // Cache miss or stale without SWR - execute query
      const result = await executor();
      this.setInBackground(cacheKey, result, options);
      this.logExecutionCacheEvent(options, cacheKey, "miss");
      return result;
    };

    return runWithTracer(
      getCacheTracer(
        getExecutionInstrumentation(options.executionContext) ??
          this.instrumentation
      ),
      {
        name: SPAN_OPERATION,
        attributes: getCacheOperationAttributes(
          modelName,
          operation,
          options.dbAttributes,
          options.executionContext
        ),
      },
      executeCore
    );
  }

  /**
   * Set cache value in background (non-blocking)
   */
  private setInBackground<T>(
    key: string,
    value: T,
    options: CacheExecutionOptions
  ): void {
    const cachePromise = this._set(
      key,
      value,
      {
        ttl: options.ttlMs,
        swrTtl: options.swr !== false ? options.swr : undefined,
      },
      options.executionContext
    ).catch((error) => {
      this.logExecutionCacheEvent(
        options,
        key,
        "miss",
        "cache-set-failed",
        error
      );
    });

    scheduleBackground(cachePromise, options.waitUntil);
  }

  /**
   * Revalidate cache entry in background (for SWR)
   * Uses _markRevalidating to prevent thundering herd (multiple concurrent revalidations)
   */
  private async revalidateInBackground<T>(
    modelName: string,
    operation: string,
    cacheKey: string,
    executor: () => Promise<T>,
    options: CacheExecutionOptions
  ): Promise<void> {
    // Check if another request is already revalidating this key
    let shouldRevalidate: boolean;
    try {
      shouldRevalidate = await this._markRevalidating(cacheKey);
    } catch {
      // If marking fails, skip revalidation to avoid request failure
      return;
    }
    if (!shouldRevalidate) {
      // Another request is handling revalidation, skip
      return;
    }

    const doRevalidate = async () => {
      try {
        this.logExecutionCacheEvent(options, cacheKey, "revalidate", "start");

        const result = await executor();
        await this._set(
          cacheKey,
          result,
          {
            ttl: options.ttlMs,
            swrTtl: options.swr !== false ? options.swr : undefined,
          },
          options.executionContext
        );

        this.logExecutionCacheEvent(options, cacheKey, "revalidate", "success");
      } catch (error) {
        // Log error but don't throw - this is background operation
        this.logExecutionCacheEvent(
          options,
          cacheKey,
          "revalidate",
          "error",
          error
        );
      } finally {
        await this._clearRevalidating(cacheKey).catch(() => undefined);
      }
    };

    // Wrap with operation span if tracer available
    // Use root: true to create a new trace (not child of current context)
    const revalidationPromise = runWithTracer(
      getCacheTracer(
        getExecutionInstrumentation(options.executionContext) ??
          this.instrumentation
      ),
      {
        name: SPAN_OPERATION,
        attributes: getCacheOperationAttributes(
          modelName,
          operation,
          options.dbAttributes,
          options.executionContext
        ),
        root: true,
      },
      doRevalidate
    );

    scheduleBackground(revalidationPromise, options.waitUntil);
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
    emitCacheLogEvent(
      getExecutionInstrumentation(options.executionContext) ??
        this.instrumentation,
      key,
      event,
      status,
      error,
      options.executionContext
    );
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
    _key: string,
    execute: (span?: Span) => Promise<T>,
    extraAttributes?: Record<string, string>,
    context?: QueryExecutionContext
  ): Promise<T> {
    return runWithTracer(
      getCacheTracer(
        getExecutionInstrumentation(context) ?? this.instrumentation
      ),
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

  /**
   * Get a value from cache
   * @param key - Cache key (will be prefixed automatically)
   */
  async _get<T>(
    key: string,
    context?: QueryExecutionContext
  ): Promise<CacheEntry<T> | null> {
    const prefixedKey = this.prefixKey(key);

    return this.withSpan(
      SPAN_CACHE_GET,
      key,
      async (span) => {
        const entry = await this.get<T>(prefixedKey);
        if (entry) {
          const isStale = this.clock.now() - entry.createdAt > entry.ttl;
          setSpanAttribute(span, ATTR_CACHE_RESULT, isStale ? "stale" : "hit");
        } else {
          setSpanAttribute(span, ATTR_CACHE_RESULT, "miss");
        }
        return entry;
      },
      undefined,
      context
    );
  }

  /**
   * Set a value in cache
   * @param key - Cache key (will be prefixed automatically)
   * @param value - Value to cache
   * @param options - Cache options including TTL
   */
  async _set<T>(
    key: string,
    value: T,
    options: CacheSetOptions,
    context?: QueryExecutionContext
  ): Promise<void> {
    const entry: CacheEntry<T> = {
      value,
      createdAt: this.clock.now(),
      ttl: options.ttl,
    };

    // Use SWR TTL if provided, otherwise just use regular TTL
    const storageTtl = options.swrTtl ?? options.ttl;

    return this.withSpan(
      SPAN_CACHE_SET,
      key,
      () => this.set(this.prefixKey(key), storageTtl, entry),
      { [ATTR_CACHE_TTL]: String(options.ttl) },
      context
    );
  }

  /**
   * Delete a specific key (and its revalidating key)
   * @param key - Cache key (will be prefixed automatically)
   */
  async _delete(key: string, context?: QueryExecutionContext): Promise<void> {
    const prefixedKey = this.prefixKey(key);
    const keys = [prefixedKey, `${prefixedKey}${REVALIDATING_SUFFIX}`];

    return this.withSpan(
      SPAN_CACHE_DELETE,
      key,
      () => this.delete(keys),
      undefined,
      context
    );
  }

  /**
   * Clear cache by prefix or all (within the active version namespace)
   * @param prefix - Optional prefix to clear (will be prefixed automatically)
   *
   * When cacheVersion is set, clearing without a prefix clears only the active
   * version namespace (e.g., viborm:v2:*), preserving other versions.
   */
  async _clear(
    prefix?: string,
    context?: QueryExecutionContext
  ): Promise<void> {
    // Use prefixKey("") to get the versioned base prefix (e.g., "viborm:v2")
    // This ensures we only clear within the active version namespace
    const prefixedPrefix = this.prefixKey(prefix ?? "");

    return this.withSpan(
      SPAN_CACHE_CLEAR,
      prefix ?? "*",
      () => this.clear(prefixedPrefix),
      undefined,
      context
    );
  }

  /**
   * Mark entry as revalidating (for SWR coordination)
   * Returns true if this caller should perform revalidation
   * @param key - Cache key (will be prefixed automatically)
   */
  async _markRevalidating(key: string): Promise<boolean> {
    const revalidatingKey = `${this.prefixKey(key)}${REVALIDATING_SUFFIX}`;

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
  async _clearRevalidating(key: string): Promise<void> {
    const revalidatingKey = `${this.prefixKey(key)}${REVALIDATING_SUFFIX}`;
    await this.delete([revalidatingKey]);
  }

  /**
   * Invalidate cache entries after a mutation
   * @param modelName - The model name for auto-invalidation
   * @param options - Cache invalidation options
   */
  async _invalidate(
    modelName: string,
    options?: CacheInvalidationOptions,
    context?: QueryExecutionContext
  ): Promise<void> {
    return this.withSpan(
      SPAN_CACHE_INVALIDATE,
      modelName,
      async () => {
        const promises: Promise<void>[] = [];

        // Auto-invalidate model cache if enabled
        if (options?.autoInvalidate) {
          // Use modelName directly as unprefixed prefix - _clear() will add the full prefix
          promises.push(this._clear(modelName, context));
        }

        // Custom invalidation - detect prefix (ends with *) vs specific key
        if (options?.invalidate) {
          for (const entry of options.invalidate) {
            if (entry.endsWith("*")) {
              // Prefix invalidation - strip the * and clear by prefix
              promises.push(this._clear(entry.slice(0, -1), context));
            } else {
              // Specific key invalidation (include revalidating key)
              promises.push(this._delete(entry, context));
            }
          }
        }

        await Promise.all(promises);
      },
      undefined,
      context
    );
  }

  /**
   * Set instrumentation context
   */
  setInstrumentation(ctx: InstrumentationContext | undefined): void {
    this.instrumentation = ctx;
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

  /**
   * Prefix a key with the cache prefix (including version if set)
   * Skips prefixing if the key is already prefixed (starts with CACHE_PREFIX)
   */
  private prefixKey(key: string): string {
    // Skip prefixing if already prefixed (e.g., from generateCacheKey for manual invalidation)
    if (key.startsWith(`${CACHE_PREFIX}:`)) {
      return key;
    }

    const base =
      this.version !== undefined
        ? `${CACHE_PREFIX}:v${this.version}`
        : CACHE_PREFIX;
    return key ? `${base}:${key}` : base;
  }
}

/**
 * Type alias for any cache driver
 */
export type AnyCacheDriver = CacheDriver;
