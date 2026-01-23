/**
 * Cache Driver
 *
 * Abstract base class for cache implementations.
 * Follows the same pattern as the database Driver class.
 * Handles both storage operations and cache orchestration (hit/miss/stale/SWR).
 */

import type { WaitUntilFn } from "@client/types";
import type { InstrumentationContext } from "@instrumentation/context";
import {
  ATTR_CACHE_DRIVER,
  ATTR_CACHE_KEY,
  ATTR_CACHE_RESULT,
  ATTR_CACHE_TTL,
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  SPAN_CACHE_CLEAR,
  SPAN_CACHE_DELETE,
  SPAN_CACHE_GET,
  SPAN_CACHE_INVALIDATE,
  SPAN_CACHE_SET,
  SPAN_OPERATION,
  type VibORMSpanName,
} from "@instrumentation/spans";
import { CACHE_PREFIX, generateUnprefixedCacheKey } from "./key";
import type { CacheInvalidationOptions } from "./schema";

/**
 * Suffix for revalidating keys (used for SWR thundering herd prevention)
 */
const REVALIDATING_SUFFIX = ":reval";

/**
 * TTL for revalidating keys in milliseconds (30 seconds)
 * This is a safety net - keys are explicitly cleared after revalidation
 */
const REVALIDATING_TTL_MS = 30_000;

/**
 * Cache entry with metadata for SWR
 */
export interface CacheEntry<T = unknown> {
  value: T;
  createdAt: number;
  ttl: number;
}

/**
 * Cache options for set operations
 */
export interface CacheSetOptions {
  /** Time to live in milliseconds */
  ttl: number;
  /** SWR storage TTL in milliseconds (if provided, used as storage TTL instead of ttl) */
  swrTtl?: number;
}

/**
 * Options for cached execution (internal, after parsing)
 */
export interface CacheExecutionOptions {
  /** Time to live in milliseconds (freshness duration) */
  ttlMs: number;
  /** SWR storage TTL in ms (ttl + staleWindow), or false to disable SWR */
  swr: number | false;
  /** Bypass cache read and force fresh fetch */
  bypass: boolean;
  /** Custom cache key override */
  key?: string;
  /** Callback for background operations in serverless environments */
  waitUntil?: WaitUntilFn;
  /** DB attributes for operation span (collection name, etc.) */
  dbAttributes?: Record<string, string>;
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
  protected instrumentation?: InstrumentationContext;
  protected version?: string | number;

  constructor(driverName: string) {
    this.driverName = driverName;
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
        this.logCacheEvent(cacheKey, "bypass");
        return result;
      }

      // Try to get from cache
      const cached = await this._get<T>(cacheKey);

      if (cached) {
        const age = Date.now() - cached.createdAt;
        const isStale = age > cached.ttl;

        if (!isStale) {
          // Fresh cache hit
          this.logCacheEvent(cacheKey, "hit");
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
          );
          this.logCacheEvent(cacheKey, "hit", "stale");
          return cached.value;
        }

        // Stale and no SWR - fall through to fetch fresh
      }

      // Cache miss or stale without SWR - execute query
      const result = await executor();
      this.setInBackground(cacheKey, result, options);
      this.logCacheEvent(cacheKey, "miss");
      return result;
    };

    // Wrap with operation span if tracer available
    if (this.instrumentation?.tracer) {
      return this.instrumentation.tracer.startActiveSpan(
        {
          name: SPAN_OPERATION,
          attributes: {
            ...options.dbAttributes,
            [ATTR_DB_COLLECTION]: modelName,
            [ATTR_DB_OPERATION_NAME]: operation,
          },
        },
        executeCore
      );
    }

    return executeCore();
  }

  /**
   * Set cache value in background (non-blocking)
   */
  private setInBackground<T>(
    key: string,
    value: T,
    options: CacheExecutionOptions
  ): void {
    const cachePromise = this._set(key, value, {
      ttl: options.ttlMs,
      swrTtl: options.swr !== false ? options.swr : undefined,
    }).catch((error) => {
      this.logCacheEvent(key, "miss", "cache-set-failed", error);
    });

    if (options.waitUntil) {
      options.waitUntil(cachePromise);
    }
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
        this.logCacheEvent(cacheKey, "revalidate", "start");

        const result = await executor();
        await this._set(cacheKey, result, {
          ttl: options.ttlMs,
          swrTtl: options.swr !== false ? options.swr : undefined,
        });

        this.logCacheEvent(cacheKey, "revalidate", "success");
      } catch (error) {
        // Log error but don't throw - this is background operation
        this.logCacheEvent(cacheKey, "revalidate", "error", error);
      } finally {
        await this._clearRevalidating(cacheKey);
      }
    };

    // Wrap with operation span if tracer available
    // Use root: true to create a new trace (not child of current context)
    const revalidationPromise = this.instrumentation?.tracer
      ? this.instrumentation.tracer.startActiveSpan(
          {
            name: SPAN_OPERATION,
            attributes: {
              ...options.dbAttributes,
              [ATTR_DB_COLLECTION]: modelName,
              [ATTR_DB_OPERATION_NAME]: operation,
            },
            root: true,
          },
          doRevalidate
        )
      : doRevalidate();

    if (options.waitUntil) {
      options.waitUntil(revalidationPromise);
    }
  }

  /**
   * Log cache events
   */
  private logCacheEvent(
    key: string,
    event: "hit" | "miss" | "revalidate" | "bypass",
    status?: string,
    error?: unknown
  ): void {
    if (!this.instrumentation?.logger) return;

    this.instrumentation.logger.cache({
      timestamp: new Date(),
      error: error instanceof Error ? error : undefined,
      meta: { event, key, status },
    });
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
    key: string,
    execute: (span?: {
      setAttribute: (key: string, value: string) => void;
    }) => Promise<T>,
    extraAttributes?: Record<string, string>
  ): Promise<T> {
    if (!this.instrumentation?.tracer) {
      return execute();
    }

    return this.instrumentation.tracer.startActiveSpan(
      {
        name: spanName,
        attributes: {
          ...this.getBaseAttributes(),
          [ATTR_CACHE_KEY]: key,
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
  async _get<T>(key: string): Promise<CacheEntry<T> | null> {
    const prefixedKey = this.prefixKey(key);

    return this.withSpan(SPAN_CACHE_GET, key, async (span) => {
      const entry = await this.get<T>(prefixedKey);
      if (entry) {
        const isStale = Date.now() - entry.createdAt > entry.ttl;
        span?.setAttribute(ATTR_CACHE_RESULT, isStale ? "stale" : "hit");
      } else {
        span?.setAttribute(ATTR_CACHE_RESULT, "miss");
      }
      return entry;
    });
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
    options: CacheSetOptions
  ): Promise<void> {
    const entry: CacheEntry<T> = {
      value,
      createdAt: Date.now(),
      ttl: options.ttl,
    };

    // Use SWR TTL if provided, otherwise just use regular TTL
    const storageTtl = options.swrTtl ?? options.ttl;

    return this.withSpan(
      SPAN_CACHE_SET,
      key,
      () => this.set(this.prefixKey(key), storageTtl, entry),
      { [ATTR_CACHE_TTL]: String(options.ttl) }
    );
  }

  /**
   * Delete a specific key (and its revalidating key)
   * @param key - Cache key (will be prefixed automatically)
   */
  async _delete(key: string): Promise<void> {
    const prefixedKey = this.prefixKey(key);
    const keys = [prefixedKey, `${prefixedKey}${REVALIDATING_SUFFIX}`];

    return this.withSpan(SPAN_CACHE_DELETE, key, () => this.delete(keys));
  }

  /**
   * Clear cache by prefix or all
   * @param prefix - Optional prefix to clear (will be prefixed automatically)
   */
  async _clear(prefix?: string): Promise<void> {
    const prefixedPrefix = prefix ? this.prefixKey(prefix) : CACHE_PREFIX;

    return this.withSpan(SPAN_CACHE_CLEAR, prefix ?? "*", () =>
      this.clear(prefixedPrefix)
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
      createdAt: Date.now(),
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
    options?: CacheInvalidationOptions
  ): Promise<void> {
    return this.withSpan(SPAN_CACHE_INVALIDATE, modelName, async () => {
      const promises: Promise<void>[] = [];

      // Auto-invalidate model cache if enabled
      if (options?.autoInvalidate) {
        // Use modelName directly as unprefixed prefix - _clear() will add the full prefix
        promises.push(this._clear(modelName));
      }

      // Custom invalidation - detect prefix (ends with *) vs specific key
      if (options?.invalidate) {
        for (const entry of options.invalidate) {
          if (entry.endsWith("*")) {
            // Prefix invalidation - strip the * and clear by prefix
            promises.push(this._clear(entry.slice(0, -1)));
          } else {
            // Specific key invalidation (include revalidating key)
            promises.push(this._delete(entry));
          }
        }
      }

      await Promise.all(promises);
    });
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
