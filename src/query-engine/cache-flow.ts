import type { CacheDriver, CacheExecutionOptions } from "@cache/driver";
import {
  type DetachedCacheResultCodec,
  executeCachedWithResultCodec,
  invalidateOfficialCache,
  type WaitUntilFn,
} from "@cache/driver";
import {
  type CacheInvalidationOptions,
  cacheInvalidationSchema,
  type WithCacheOptions,
  withCacheSchema,
} from "@cache/schema";
import type { DriverIdentity } from "@drivers/driver-identity";
import type { QueryExecutionContext } from "@drivers/exports";
import {
  CacheConfigurationError,
  CacheOperationNotCacheableError,
} from "@errors";
import type { ResolvedExtensionChain } from "@extensions/chain";
import {
  type AdmittedControls,
  isStableControlValue,
} from "@extensions/controls";
import type { WriteOutcomeRegistration } from "@extensions/query";
import { parse } from "@validation";
import { readValidationFailureCause } from "@validation/parse-failure";
import { isRecord } from "@validation/value-guards";
import { isError } from "../errors/diagnostic-safety";
import { isWriteOperation } from "./routed-operations";

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

/** Every option object the cache's control admitted, for its typed read. */
const admittedMutationOptions = new WeakMap<object, CacheInvalidationOptions>();

/**
 * The cache's own parser, run by core's control admission (the declaration is
 * `officialCacheControls` in `@cache/capability`). `parse` returns a thrown
 * validator as issues, so every refusal here is one `CacheConfigurationError`.
 */
export function admitMutationCacheOptions(
  cache: unknown
): CacheInvalidationOptions {
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
  // Deeply frozen: admission keeps an immutable value as it is, so this
  // object stays the one the WeakMap below finds.
  if (invalidate) Object.freeze(invalidate);
  const options: CacheInvalidationOptions = Object.freeze({
    autoInvalidate: parsed.value.autoInvalidate,
    ...(invalidate === undefined ? {} : { invalidate }),
  });
  admittedMutationOptions.set(options, options);
  return options;
}

/** The mutation options a call's `cache` control admitted, if it gave one. */
export function readMutationCacheOptions(
  controls: AdmittedControls | undefined
): CacheInvalidationOptions | undefined {
  const admitted = controls?.cache;
  return isRecord(admitted) ? admittedMutationOptions.get(admitted) : undefined;
}

/**
 * What one cached read is keyed on. A read that admitted no control keeps
 * today's key, the prepared arguments byte for byte; otherwise the key is the
 * pair of those arguments and the admitted controls, which no base key can
 * spell (its arguments are always an object), and, on a chain with `rows`,
 * those declarations themselves, since the same control value selects
 * different rows under different declarations. A control value that is not
 * plain data has no canonical form: `undefined` bypasses the cache.
 */
export function cacheKeyOf(
  args: Record<string, unknown>,
  controls: AdmittedControls | undefined,
  rows: ResolvedExtensionChain["rows"]
): unknown {
  if (controls === undefined) return args;
  // Only values admission fixed key a cache entry: the rows the read's SQL
  // binds were bound from those same values (`snapshotControlValue` in controls.ts).
  if (!Object.values(controls).every(isStableControlValue)) return undefined;
  return rows === undefined ? [args, controls] : [args, controls, rows];
}

export { isCacheManagedExecution } from "@cache/capability";

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
