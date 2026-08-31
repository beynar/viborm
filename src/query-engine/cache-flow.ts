import type {
  CacheDriver,
  CacheInvalidationOptions,
  WithCacheOptions,
} from "@cache";
import {
  type CacheExecutionOptions,
  cacheInvalidationSchema,
  withCacheSchema,
} from "@cache";
import {
  executeCachedWithResultCodec,
  invalidateOfficialCache,
  type WaitUntilFn,
} from "@cache/driver";
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import {
  CacheConfigurationError,
  CacheOperationNotCacheableError,
} from "@errors";
import type { WriteOutcomeRegistration } from "@extensions/query";
import { parse } from "@validation";
import { readValidationFailureCause } from "@validation/parse-failure";
import { isError } from "../errors/diagnostic-safety";
import type { CacheResultCodec } from "./result/cache-result-codec";
import type { PrepareOptions } from "./types";
import { isWriteOperation } from "./write-engine/routing";

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

export interface PreparedMutationCacheInput {
  readonly args: Record<string, unknown>;
  readonly options: CacheInvalidationOptions | undefined;
}

type MutationInputDescriptors = Map<PropertyKey, PropertyDescriptor>;

/**
 * Remove and validate the client-owned mutation cache option before the core
 * operation schema sees the payload. The absent-key arm preserves identity.
 */
export function prepareMutationCacheInput(
  operation: string,
  input: Record<string, unknown>
): PreparedMutationCacheInput {
  if (!isWriteOperation(operation)) {
    return { args: input, options: undefined };
  }

  let descriptors: MutationInputDescriptors;
  try {
    descriptors = new Map();
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor) descriptors.set(key, descriptor);
    }
  } catch (cause) {
    throw mutationCacheInputError(
      `Mutation cache options for '${operation}' could not be inspected.`,
      cause
    );
  }
  const cacheDescriptor = descriptors.get("cache");
  if (cacheDescriptor === undefined) {
    return { args: input, options: undefined };
  }

  let cache: unknown;
  try {
    cache =
      "value" in cacheDescriptor
        ? cacheDescriptor.value
        : cacheDescriptor.get?.call(input);
  } catch (cause) {
    throw mutationCacheInputError(
      `Mutation cache options for '${operation}' could not be read.`,
      cause
    );
  }

  const args: Record<string, unknown> = {};
  for (const [key, descriptor] of descriptors) {
    if (key === "cache") continue;
    // `getOwnPropertyDescriptor` has already normalized and validated every
    // descriptor. Defining that descriptor on a fresh ordinary object cannot
    // fail, so a catch here only advertised a recovery path that JavaScript
    // cannot reach.
    Object.defineProperty(args, key, descriptor);
  }
  const options =
    cache === undefined
      ? undefined
      : parseMutationCacheOptions(operation, cache);
  return { args, options };
}

function parseMutationCacheOptions(
  operation: string,
  cache: unknown
): CacheInvalidationOptions {
  try {
    const parsed = parse(cacheInvalidationSchema, cache);
    if (parsed.issues) {
      throw new CacheConfigurationError(
        `Invalid mutation cache options: ${parsed.issues.map((issue) => issue.message).join(", ")}`,
        { cause: readValidationFailureCause(parsed) }
      );
    }
    const invalidate =
      parsed.value.invalidate === undefined
        ? undefined
        : [...parsed.value.invalidate];
    return Object.freeze({
      autoInvalidate: parsed.value.autoInvalidate,
      ...(invalidate === undefined ? {} : { invalidate }),
    });
  } catch (cause) {
    if (isCacheConfigurationError(cause)) throw cause;
    throw mutationCacheInputError(
      `Mutation cache options for '${operation}' could not be validated.`,
      cause
    );
  }
}

function mutationCacheInputError(
  message: string,
  cause: unknown
): CacheConfigurationError {
  return new CacheConfigurationError(message, {
    cause: isError(cause)
      ? cause
      : new Error("A non-Error value was thrown.", { cause }),
  });
}

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
  readCacheOptions: () => CacheInvalidationOptions | undefined,
  context: QueryExecutionContext,
  officialScope: object
): WriteOutcomeRegistration | undefined {
  if (!isWriteOperation(operation)) return undefined;
  const options = readCacheOptions();

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

function isCacheConfigurationError(
  value: unknown
): value is CacheConfigurationError {
  return value instanceof CacheConfigurationError;
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
    dbAttributes,
  };
}

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
