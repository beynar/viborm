/**
 * Cached Client
 *
 * Provides a cached client proxy that wraps read operations with caching.
 */

import { CacheOperationNotCacheableError } from "@errors";
import type { InstrumentationContext } from "@instrumentation/context";
import type { CacheableOperations, CachedClient, Schema } from "@client/types";
import type { CacheDriver } from "./driver";
import { generateCacheKey } from "./key";
import { DEFAULT_CACHE_TTL } from "./schema";
import { parseTTL } from "./ttl";
import type { ParsedCacheOptions, WaitUntilFn, WithCacheOptions } from "./types";

/**
 * Set of cacheable operations
 */
const CACHEABLE_OPERATIONS: Set<string> = new Set([
  "findFirst",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "exist",
]);

/**
 * Check if an operation is cacheable
 */
function isCacheableOperation(
  operation: string
): operation is CacheableOperations {
  return CACHEABLE_OPERATIONS.has(operation);
}

/**
 * Executor function type for running operations
 */
type OperationExecutor<S extends Schema> = (opts: {
  modelName: keyof S;
  operation: CacheableOperations;
  args: unknown;
}) => Promise<unknown>;

/**
 * Cached client that wraps read operations with caching
 */
class CachedClientImpl<S extends Schema> {
  // biome-ignore lint: ok
  private readonly schema: S;
  private readonly executor: OperationExecutor<S>;
  private readonly cache: CacheDriver;
  private readonly options: ParsedCacheOptions;
  private readonly instrumentation?: InstrumentationContext;

  constructor(
    schema: S,
    executor: OperationExecutor<S>,
    cache: CacheDriver,
    options: WithCacheOptions,
    waitUntil?: WaitUntilFn,
    instrumentation?: InstrumentationContext
  ) {
    this.schema = schema;
    this.executor = executor;
    this.cache = cache;
    this.options = {
      ttlMs: options?.ttl ? parseTTL(options.ttl) : DEFAULT_CACHE_TTL,
      swr: options?.swr ?? false,
      key: options?.key,
      waitUntil,
    };
    this.instrumentation = instrumentation;
  }

  /**
   * Create the proxy for model operations
   */
  createProxy(): CachedClient<S> {
    return this.createModelProxy([]) as CachedClient<S>;
  }

  /**
   * Create recursive proxy for cached model operations
   */
  private createModelProxy(path: string[]): unknown {
    // biome-ignore lint: <proxy pattern>
    return new Proxy(() => {}, {
      get: (_target, key) => {
        if (typeof key !== "string") return undefined;
        // Prevent Promise-like behavior
        if (key === "then") return undefined;
        return this.createModelProxy([...path, key]);
      },

      apply: (_target, _thisArg, [args]) => {
        const modelName = path[0] as keyof S;
        const operation = path[1] as string;

        // Runtime check - only cacheable operations allowed
        if (!isCacheableOperation(operation)) {
          throw new CacheOperationNotCacheableError(
            operation,
            [...CACHEABLE_OPERATIONS]
          );
        }

        return this.execute(modelName, operation, args);
      },
    });
  }

  /**
   * Execute a cached operation
   */
  private async execute(
    modelName: keyof S,
    operation: CacheableOperations,
    args: unknown
  ): Promise<unknown> {
    // Generate or use custom cache key
    const cacheKey =
      this.options.key ?? generateCacheKey(String(modelName), operation, args);

    // Try to get from cache
    const cached = await this.cache._get(cacheKey);

    if (cached) {
      const age = Date.now() - cached.createdAt;
      const isStale = age > cached.ttl;

      if (!isStale) {
        // Fresh cache hit
        this.log(cacheKey, "hit", "fresh");
        return cached.value;
      }

      if (this.options.swr) {
        // Stale but SWR enabled - return stale and revalidate in background
        this.log(cacheKey, "hit", "stale");

        // Try to mark as revalidating (prevents thundering herd)
        const shouldRevalidate = await this.cache._markRevalidating(cacheKey);

        if (shouldRevalidate) {
          // Fire off background revalidation (don't await)
          const revalidationPromise = this.revalidateInBackground(
            modelName,
            operation,
            args,
            cacheKey
          );

          // Use waitUntil if provided (serverless environments)
          if (this.options.waitUntil) {
            this.options.waitUntil(revalidationPromise);
          }
        }

        return cached.value;
      }

      // Stale and no SWR - fall through to fetch fresh
    }

    // Cache miss or stale without SWR - execute query
    this.log(cacheKey, "miss");

    const result = await this.executor({ modelName, operation, args });

    // Store in cache
    await this.cache._set(cacheKey, result, { ttl: this.options.ttlMs });

    return result;
  }

  /**
   * Revalidate cache entry in background (for SWR)
   */
  private async revalidateInBackground(
    modelName: keyof S,
    operation: CacheableOperations,
    args: unknown,
    cacheKey: string
  ): Promise<void> {
    try {
      this.log(cacheKey, "revalidate", "start");

      const result = await this.executor({ modelName, operation, args });
      await this.cache._set(cacheKey, result, { ttl: this.options.ttlMs });

      this.log(cacheKey, "revalidate", "success");
    } catch (error) {
      // Log error but don't throw - this is background operation
      this.log(cacheKey, "revalidate", "error", error);
    } finally {
      await this.cache._clearRevalidating(cacheKey);
    }
  }

  /**
   * Log cache events
   */
  private log(
    key: string,
    event: "hit" | "miss" | "revalidate",
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
}

/**
 * Create a cached client proxy
 */
export function createCachedClientProxy<S extends Schema>(
  schema: S,
  executeOperation: OperationExecutor<S>,
  cacheDriver: CacheDriver,
  options: WithCacheOptions,
  waitUntil?: WaitUntilFn,
  instrumentation?: InstrumentationContext
): CachedClient<S> {
  const client = new CachedClientImpl(
    schema,
    executeOperation,
    cacheDriver,
    options,
    waitUntil,
    instrumentation
  );
  return client.createProxy();
}
