import type {
  CacheDriver,
  CacheInvalidationOptions,
  WithCacheOptions,
} from "@cache";
import { type CacheExecutionOptions, withCacheSchema } from "@cache";
import {
  type DetachedCacheResultCodec,
  executeCachedWithResultCodec,
  invalidateOfficialCache,
  type WaitUntilFn,
} from "@cache/driver";
import type { QueryExecutionContext } from "@drivers";
import type { DriverIdentity } from "@drivers/driver-identity";
import {
  CacheConfigurationError,
  CacheOperationNotCacheableError,
} from "@errors";
import type { WriteOutcomeRegistration } from "@extensions/query";
import { parse } from "@validation";
import { readValidationFailureCause } from "@validation/parse-failure";
import { isError } from "../errors/diagnostic-safety";
import { isWriteOperation } from "./routed-operations";
import type { PrepareOptions } from "./types";

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

/** Prepare the cache listener consumed by the shared write-outcome rail. */
export function prepareMutationCacheWriteOutcome(
  cache: CacheDriver,
  modelName: string,
  operation: string,
  options: CacheInvalidationOptions | undefined,
  context: QueryExecutionContext,
  officialScope: object
): WriteOutcomeRegistration | undefined {
  if (!isWriteOperation(operation)) return undefined;

  return Object.freeze({
    extension: "viborm.cache",
    failurePolicy: "boundary-owned",
    listener: async (outcome) => {
      try {
        await invalidateOfficialCache(
          cache,
          modelName,
          options,
          context,
          officialScope
        );
      } catch (error) {
        throw new CacheConfigurationError(
          `Cache invalidation failed after mutation '${operation}' on model '${modelName}'.`,
          {
            cause: isError(error)
              ? error
              : new Error("A non-Error value was thrown.", { cause: error }),
            meta: {
              method: "invalidate",
              model: modelName,
              operation,
              commitCertainty: outcome.certainty,
            },
          }
        );
      }
    },
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
  driverIdentity: DriverIdentity | undefined
): CacheExecutionOptions {
  const parsed = parse(withCacheSchema, config);
  if (parsed.issues) {
    throw new CacheConfigurationError(
      `Invalid cache options: ${parsed.issues.map((issue) => issue.message).join(", ")}`,
      { cause: readValidationFailureCause(parsed) }
    );
  }

  const { bypass, key, ttl, swr } = parsed.value;

  return {
    ttlMs: ttl,
    swr: resolveSwr(swr, ttl),
    bypass,
    key,
    waitUntil,
    driverIdentity,
  };
}

/**
 * The detached cache representation of one read result: the cache driver's
 * own contract, read here at the boundary that hands the Raptor 3 route's
 * `cacheCodec` to it.
 */
export type CacheResultCodec = DetachedCacheResultCodec<unknown>;

/** Execute an official read through the detached result representation. */
export function executeCachedResultOperation(
  cache: CacheDriver,
  modelName: string,
  operation: string,
  args: unknown,
  executor: () => Promise<unknown>,
  options: CacheExecutionOptions,
  codec: CacheResultCodec,
  officialScope: object
): Promise<unknown> {
  return executeCachedWithResultCodec(
    cache,
    modelName,
    operation,
    args,
    executor,
    options,
    codec,
    officialScope
  );
}

export async function invalidateManualCache(
  cache: CacheDriver,
  keys: string[],
  context: QueryExecutionContext | undefined,
  officialScope: object
): Promise<void> {
  const invalidate = [...keys];
  const options = Object.freeze({ invalidate });
  await invalidateOfficialCache(
    cache,
    "manual",
    options,
    context,
    officialScope
  );
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
