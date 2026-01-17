/**
 * Cache Driver
 *
 * Abstract base class for cache implementations.
 * Follows the same pattern as the database Driver class.
 */

import type { InstrumentationContext } from "@instrumentation/context";
import {
  ATTR_CACHE_DRIVER,
  ATTR_CACHE_KEY,
  ATTR_CACHE_RESULT,
  ATTR_CACHE_TTL,
  SPAN_CACHE_CLEAR,
  SPAN_CACHE_DELETE,
  SPAN_CACHE_GET,
  SPAN_CACHE_INVALIDATE,
  SPAN_CACHE_SET,
} from "@instrumentation/spans";
import { CACHE_PREFIX, generateCachePrefix } from "./key";
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
}

/**
 * Abstract base class for cache drivers.
 *
 * Follows the same pattern as the database Driver class:
 * - Protected abstract methods for concrete implementations (non-underscored)
 * - Public underscored methods handle key prefixing, instrumentation, and delegation
 * - Instrumentation support
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
  // PUBLIC API - Called by cached-client and client
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
   * Get a value from cache
   * @param key - Cache key (will be prefixed automatically)
   */
  async _get<T>(key: string): Promise<CacheEntry<T> | null> {
    const prefixedKey = this.prefixKey(key);

    if (!this.instrumentation?.tracer) {
      return this.get<T>(prefixedKey);
    }

    return this.instrumentation.tracer.startActiveSpan(
      {
        name: SPAN_CACHE_GET,
        attributes: {
          ...this.getBaseAttributes(),
          [ATTR_CACHE_KEY]: key,
        },
      },
      async (span) => {
        const entry = await this.get<T>(prefixedKey);
        if (entry) {
          const age = Date.now() - entry.createdAt;
          const isStale = age > entry.ttl;
          span?.setAttribute(ATTR_CACHE_RESULT, isStale ? "stale" : "hit");
        } else {
          span?.setAttribute(ATTR_CACHE_RESULT, "miss");
        }
        return entry;
      }
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
    options: CacheSetOptions
  ): Promise<void> {
    const entry: CacheEntry<T> = {
      value,
      createdAt: Date.now(),
      ttl: options.ttl,
    };

    // Double TTL for storage to allow SWR to serve stale content
    const storageTtl = options.ttl * 2;

    const execute = () => this.set(this.prefixKey(key), storageTtl, entry);

    if (!this.instrumentation?.tracer) {
      return execute();
    }

    return this.instrumentation.tracer.startActiveSpan(
      {
        name: SPAN_CACHE_SET,
        attributes: {
          ...this.getBaseAttributes(),
          [ATTR_CACHE_KEY]: key,
          [ATTR_CACHE_TTL]: String(options.ttl),
        },
      },
      execute
    );
  }

  /**
   * Delete a specific key (and its revalidating key)
   * @param key - Cache key (will be prefixed automatically)
   */
  async _delete(key: string): Promise<void> {
    const prefixedKey = this.prefixKey(key);
    const keys = [prefixedKey, `${prefixedKey}${REVALIDATING_SUFFIX}`];

    const execute = () => this.delete(keys);

    if (!this.instrumentation?.tracer) {
      return execute();
    }

    return this.instrumentation.tracer.startActiveSpan(
      {
        name: SPAN_CACHE_DELETE,
        attributes: {
          ...this.getBaseAttributes(),
          [ATTR_CACHE_KEY]: key,
        },
      },
      execute
    );
  }

  /**
   * Clear cache by prefix or all
   * @param prefix - Optional prefix to clear (will be prefixed automatically)
   */
  async _clear(prefix?: string): Promise<void> {
    const prefixedPrefix = prefix ? this.prefixKey(prefix) : CACHE_PREFIX;

    const execute = () => this.clear(prefixedPrefix);

    if (!this.instrumentation?.tracer) {
      return execute();
    }

    return this.instrumentation.tracer.startActiveSpan(
      {
        name: SPAN_CACHE_CLEAR,
        attributes: {
          ...this.getBaseAttributes(),
          [ATTR_CACHE_KEY]: prefix ?? "*",
        },
      },
      execute
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
    const execute = async () => {
      const promises: Promise<void>[] = [];

      // Auto-invalidate model cache if enabled (uses driver's version)
      if (options?.autoInvalidate) {
        const prefix = generateCachePrefix(modelName, this.version);
        promises.push(this.clear(this.prefixKey(prefix)));
      }

      // Custom invalidation - detect prefix (ends with *) vs specific key
      if (options?.invalidate) {
        for (const entry of options.invalidate) {
          if (entry.endsWith("*")) {
            // Prefix invalidation - strip the * and clear by prefix
            const prefix = entry.slice(0, -1);
            promises.push(this.clear(this.prefixKey(prefix)));
          } else {
            // Specific key invalidation (include revalidating key)
            const prefixedKey = this.prefixKey(entry);
            promises.push(
              this.delete([prefixedKey, `${prefixedKey}${REVALIDATING_SUFFIX}`])
            );
          }
        }
      }

      await Promise.all(promises);
    };

    if (!this.instrumentation?.tracer) {
      return execute();
    }

    return this.instrumentation.tracer.startActiveSpan(
      {
        name: SPAN_CACHE_INVALIDATE,
        attributes: {
          ...this.getBaseAttributes(),
          [ATTR_CACHE_KEY]: modelName,
        },
      },
      execute
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
   */
  private prefixKey(key: string): string {
    const prefix = generateCachePrefix(undefined, this.version);
    // If already prefixed, don't double-prefix
    if (key.startsWith(prefix) || key.startsWith(CACHE_PREFIX)) {
      return key;
    }
    return `${prefix}:${key}`;
  }
}

/**
 * Type alias for any cache driver
 */
export type AnyCacheDriver = CacheDriver;
