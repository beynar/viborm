import type {
  CacheDriver,
  CacheInvalidationOptions,
  WithCacheOptions,
} from "@cache";
import { type CacheExecutionOptions, withCacheSchema } from "@cache";
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import {
  CacheConfigurationError,
  CacheOperationNotCacheableError,
} from "@errors";
import { parse } from "@validation";
import type { PendingOperation } from "./pending-operation";
import type { TransactionOperation } from "./transaction-operation";
import type { PrepareOptions } from "./types";

type WaitUntilFn = (promise: Promise<unknown>) => void;

// The client-facing mutation families. `createMany` / `updateMany` cover both
// their `{ count }` and their row-returning (`select`) arms — implicit returning
// added no operation name to invalidate on.
const MUTATION_OPERATIONS: Set<string> = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
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

/**
 * The invalidation a wrapped mutation runs after it writes, keyed by the
 * operation the caller holds.
 *
 * The wrapper below installs it as a deferred executor, which fires only from
 * the EXECUTE path (`PendingOperation.runExecution`). A batch-only driver (D1,
 * Neon HTTP) takes the client's shared-batch branch of `$transaction([...])`,
 * which prepares every operation and parses the driver's batch results without
 * ever executing them — so that branch looks the operation up here and runs the
 * SAME closure once the batch has committed. One definition, two call paths:
 * which model, which per-operation options and which execution context are
 * invalidated cannot drift between them.
 */
const mutationInvalidations = new WeakMap<object, () => Promise<void>>();

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

  const invalidate = async () => {
    try {
      await cache._invalidate(
        modelName,
        cacheOptions,
        pendingOperation.getExecutionContext()
      );
    } catch (error) {
      throw new CacheConfigurationError(
        `Cache invalidation failed after mutation '${operation}' on model '${modelName}'.`,
        {
          cause: error instanceof Error ? error : undefined,
          meta: { method: "invalidate", model: modelName, operation },
        }
      );
    }
  };

  const wrapped = pendingOperation.wrapExecutor(async (execute) => {
    let receivedVisibleWrite = false;
    const writeMayBeVisible = async () => {
      receivedVisibleWrite = true;
      await invalidate();
    };
    const result = await execute(
      undefined,
      writeMayBeVisible,
      writeMayBeVisible
    );
    if (!receivedVisibleWrite) await invalidate();
    return result;
  });
  mutationInvalidations.set(wrapped, invalidate);
  return wrapped;
}

/**
 * Invalidate for every mutation in a batch that has COMMITTED without running
 * through the execute path — the shared-batch branch of `$transaction([...])`.
 *
 * Called once the driver's batch has committed, so it mirrors the execute path's
 * "write first, then invalidate" order. Operations that carry no invalidation (a
 * read, a mutation on a client with no cache driver) are skipped, and each
 * mutation is invalidated with its own options, exactly as when awaited directly.
 */
export async function invalidateCommittedBatch(
  operations: readonly TransactionOperation<unknown>[]
): Promise<void> {
  for (const operation of operations) {
    const invalidate = mutationInvalidations.get(operation);
    if (invalidate) {
      await invalidate();
    }
  }
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
  keys: string[],
  context?: QueryExecutionContext
): Promise<void> {
  if (!cache) {
    throw new CacheConfigurationError(
      "Cache driver not configured. Pass a cache driver in createClient options."
    );
  }

  await cache._invalidate("manual", { invalidate: keys }, context);
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
