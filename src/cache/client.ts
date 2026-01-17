/**
 * Cached Client
 *
 * Provides a cached client proxy that wraps read operations with caching.
 */

import type { CacheableOperations, CachedClient, Schema } from "@client/types";
import { CacheOperationNotCacheableError } from "@errors";
import type { InstrumentationContext } from "@instrumentation/context";
import type { CacheDriver } from "./driver";
import { generateCacheKey } from "./key";
import { DEFAULT_CACHE_TTL } from "./schema";
import { parseTTL } from "./ttl";
import type {
  ParsedCacheOptions,
  WaitUntilFn,
  WithCacheOptions,
} from "./types";

/**
 * Function to wrap an operation with a span
 */
export type OperationSpanWrapper = <T>(
  modelName: string,
  operation: string,
  fn: () => Promise<T>,
  options?: { root?: boolean }
) => Promise<T>;

/**
 * Cache result types for spans
 */
type CacheResult = "hit" | "stale" | "miss" | "bypass";

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
  private readonly version?: string | number;
  private readonly instrumentation?: InstrumentationContext;
  private readonly spanWrapper?: OperationSpanWrapper;

  constructor(
    schema: S,
    executor: OperationExecutor<S>,
    cache: CacheDriver,
    options: WithCacheOptions,
    waitUntil?: WaitUntilFn,
    version?: string | number,
    instrumentation?: InstrumentationContext,
    spanWrapper?: OperationSpanWrapper
  ) {
    this.schema = schema;
    this.executor = executor;
    this.cache = cache;
    this.options = {
      ttlMs: options?.ttl ? parseTTL(options.ttl) : DEFAULT_CACHE_TTL,
      swr: options?.swr ?? false,
      bypass: options?.bypass ?? false,
      key: options?.key,
      waitUntil,
    };
    this.version = version;
    this.instrumentation = instrumentation;
    this.spanWrapper = spanWrapper;
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
          throw new CacheOperationNotCacheableError(operation, [
            ...CACHEABLE_OPERATIONS,
          ]);
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
    // Wrap with operation span if wrapper available, otherwise execute directly
    if (this.spanWrapper) {
      return this.spanWrapper(String(modelName), operation, () =>
        this.executeCore(modelName, operation, args)
      );
    }
    return this.executeCore(modelName, operation, args);
  }

  /**
   * Core execution logic for cached operations
   */
  private async executeCore(
    modelName: keyof S,
    operation: CacheableOperations,
    args: unknown
  ): Promise<unknown> {
    // Generate or use custom cache key
    const cacheKey =
      this.options.key ??
      generateCacheKey(String(modelName), operation, args, this.version);

    const executeWithResult = async (): Promise<{
      result: unknown;
      cacheResult: CacheResult;
    }> => {
      // Bypass cache read if requested
      if (this.options.bypass) {
        const result = await this.executor({ modelName, operation, args });
        await this.cache._set(cacheKey, result, { ttl: this.options.ttlMs });
        return { result, cacheResult: "bypass" };
      }

      // Try to get from cache
      const cached = await this.cache._get(cacheKey);

      if (cached) {
        const age = Date.now() - cached.createdAt;
        const isStale = age > cached.ttl;

        if (!isStale) {
          // Fresh cache hit
          return { result: cached.value, cacheResult: "hit" };
        }

        if (this.options.swr) {
          // Stale but SWR enabled - return stale and revalidate in background
          // Fire off revalidation without blocking the response
          const revalidationPromise = this.revalidateInBackground(
            modelName,
            operation,
            args,
            cacheKey
          );

          if (this.options.waitUntil) {
            this.options.waitUntil(revalidationPromise);
          }

          return { result: cached.value, cacheResult: "stale" };
        }

        // Stale and no SWR - fall through to fetch fresh
      }

      // Cache miss or stale without SWR - execute query
      const result = await this.executor({ modelName, operation, args });

      const cachePromise = this.cache
        ._set(cacheKey, result, { ttl: this.options.ttlMs })
        .catch((error) => {
          this.log(cacheKey, "miss", "cache-set-failed", error);
        });
      if (this.options.waitUntil) {
        this.options.waitUntil(cachePromise);
      }
      return { result, cacheResult: "miss" };
    };

    const { result, cacheResult } = await executeWithResult();
    this.log(
      cacheKey,
      cacheResult === "stale" ? "hit" : cacheResult,
      cacheResult === "stale" ? "stale" : undefined
    );
    return result;
  }

  /**
   * Revalidate cache entry in background (for SWR)
   * Returns a promise that resolves when revalidation completes (for waitUntil)
   * Uses _markRevalidating to prevent thundering herd (multiple concurrent revalidations)
   */
  private async revalidateInBackground(
    modelName: keyof S,
    operation: CacheableOperations,
    args: unknown,
    cacheKey: string
  ): Promise<void> {
    // Check if another request is already revalidating this key
    // Do this before creating a span to avoid empty traces
    const shouldRevalidate = await this.cache._markRevalidating(cacheKey);
    if (!shouldRevalidate) {
      // Another request is handling revalidation, skip
      return;
    }

    const doRevalidate = async () => {
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
    };

    // Wrap with operation span if wrapper available
    // Use root: true to create a new trace (not child of current context)
    if (this.spanWrapper) {
      return this.spanWrapper(String(modelName), operation, doRevalidate, {
        root: true,
      });
    }
    return doRevalidate();
  }

  /**
   * Log cache events
   */
  private log(
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
  version?: string | number,
  instrumentation?: InstrumentationContext,
  spanWrapper?: OperationSpanWrapper
): CachedClient<S> {
  const client = new CachedClientImpl(
    schema,
    executeOperation,
    cacheDriver,
    options,
    waitUntil,
    version,
    instrumentation,
    spanWrapper
  );
  return client.createProxy();
}
