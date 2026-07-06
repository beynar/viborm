import type {
  CacheDriver,
  CacheInvalidationOptions,
  WithCacheOptions,
} from "@cache";
import { type CacheExecutionOptions, withCacheSchema } from "@cache";
import type { PendingOperation } from "@client/pending-operation";
import type { AnyDriver } from "@drivers";
import {
  CacheConfigurationError,
  CacheOperationNotCacheableError,
} from "@errors";
import { parse } from "@validation";
import type { PrepareOptions } from "./types";

type WaitUntilFn = (promise: Promise<unknown>) => void;

const MUTATION_OPERATIONS: Set<string> = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "upsert",
]);

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

export function isCacheManagedExecution(
  options: PrepareOptions | undefined
): boolean {
  return options?.skipSpan === true;
}

export function withMutationCacheInvalidation<T>(
  pendingOperation: PendingOperation<T>,
  cache: CacheDriver,
  modelName: string,
  operation: string,
  cacheOptions: CacheInvalidationOptions | undefined
): PendingOperation<T> {
  if (!MUTATION_OPERATIONS.has(operation)) {
    return pendingOperation;
  }

  return pendingOperation.wrapExecutor(async (execute) => {
    const result = await execute();
    await cache._invalidate(modelName, cacheOptions);
    return result;
  });
}

export function validateCacheableOperation(operation: string): void {
  if (CACHEABLE_OPERATIONS.has(operation)) {
    return;
  }

  throw new CacheOperationNotCacheableError(operation, [
    ...CACHEABLE_OPERATIONS,
  ]);
}

export function createCacheExecutionOptions(
  config: WithCacheOptions | undefined,
  waitUntil: WaitUntilFn | undefined,
  dbAttributes: ReturnType<AnyDriver["getBaseAttributes"]>
): CacheExecutionOptions {
  const parsed = parse(withCacheSchema, config);
  if (parsed.issues) {
    throw new CacheConfigurationError(
      `Invalid cache options: ${parsed.issues.map((issue) => issue.message).join(", ")}`
    );
  }

  const { bypass, key, ttl, swr } = parsed.value;

  return {
    ttlMs: ttl,
    swr: resolveSwr(swr, ttl),
    bypass,
    key,
    waitUntil,
    dbAttributes,
  };
}

export function executeCachedOperation<T>(
  cache: CacheDriver,
  modelName: string,
  operation: string,
  args: unknown,
  executor: () => Promise<T>,
  options: CacheExecutionOptions
): Promise<T> {
  return cache._executeCached(modelName, operation, args, executor, options);
}

export async function invalidateManualCache(
  cache: CacheDriver | undefined,
  keys: string[]
): Promise<void> {
  if (!cache) {
    throw new CacheConfigurationError(
      "Cache driver not configured. Pass a cache driver in createClient options."
    );
  }

  await cache._invalidate("manual", { invalidate: keys });
}

function resolveSwr(
  swr: boolean | number | undefined,
  ttlMs: number
): number | false {
  if (swr === undefined || swr === false) {
    return false;
  }
  if (swr === true) {
    return ttlMs * 2;
  }
  return ttlMs + swr;
}
