/**
 * Pending Operation
 *
 * A deferred database operation that can be:
 * - Awaited directly (immediate execution)
 * - Passed to $transaction([...]) for batched execution
 *
 * This implements the Prisma-style "PrismaPromise" pattern where operations
 * like `client.user.findMany()` return immediately without executing,
 * allowing them to be collected and executed together in a batch or transaction.
 *
 * Validation and SQL building are DEFERRED to execution time.
 */

import type { AnyDriver } from "@drivers";
import type { PreparedQuery, QueryMetadata } from "@query-engine/types";

/**
 * Symbol to identify PendingOperation instances
 */
export const PENDING_OPERATION_SYMBOL = Symbol.for("viborm.pendingOperation");

/**
 * A pending database operation that implements PromiseLike for deferred execution.
 *
 * @example
 * // Direct await - executes immediately
 * const users = await client.user.findMany();
 *
 * @example
 * // Batch execution - deferred until $transaction is called
 * const [users, posts] = await client.$transaction([
 *   client.user.findMany(),
 *   client.post.findMany(),
 * ]);
 */
export class PendingOperation<T> implements PromiseLike<T> {
  /**
   * Symbol to identify this as a PendingOperation
   */
  readonly [PENDING_OPERATION_SYMBOL] = true;

  /**
   * Query metadata containing args, operation info, and executor
   */
  private readonly metadata: QueryMetadata<T>;

  /**
   * Cached promise for direct execution via then/catch/finally.
   * Ensures execute() is only called once even if multiple
   * PromiseLike methods are chained on the same instance.
   */
  private _promise: Promise<T> | null = null;

  constructor(metadata: QueryMetadata<T>) {
    this.metadata = metadata;
  }

  /**
   * Get or create the cached promise for direct execution.
   * This ensures the executor is only called once.
   */
  private getPromise(): Promise<T> {
    if (!this._promise) {
      this._promise = this.metadata.execute();
    }
    return this._promise;
  }

  /**
   * Check if this operation can be batched.
   * Operations with nested writes cannot be batched as they require
   * multiple queries with runtime-dependent values.
   */
  canBatch(): boolean {
    return !this.metadata.hasNestedWrites;
  }

  /**
   * Check if this is a batch operation (returns rowCount instead of rows)
   */
  isBatchOperation(): boolean {
    return this.metadata.isBatchOperation;
  }

  /**
   * Get raw args (not yet validated)
   */
  getArgs(): Record<string, unknown> {
    return this.metadata.args;
  }

  /**
   * Get model name for tracing
   */
  getModel(): string {
    return this.metadata.model;
  }

  /**
   * Get operation name for tracing
   */
  getOperation(): string {
    return this.metadata.operation;
  }

  /**
   * Execute the operation immediately
   */
  execute(): Promise<T> {
    return this.metadata.execute();
  }

  /**
   * Execute the operation with a specific driver.
   * Used for transaction-bound execution where we need to use the txDriver.
   *
   * Passes the driver to the executor so operations use the transaction
   * context (savepoints) instead of new transactions.
   */
  executeWith(driver: AnyDriver): Promise<T> {
    return this.metadata.execute(driver);
  }

  /**
   * Prepare the query for batch execution.
   * Validates and builds SQL without executing.
   *
   * Returns undefined if:
   * - The operation has nested writes (requires multiple queries)
   * - The prepare function is not available
   *
   * @param driver - Optional driver to use for SQL dialect
   * @returns PreparedQuery with sql and params, or undefined if not batchable
   */
  prepare(driver?: AnyDriver): PreparedQuery | undefined {
    if (!this.metadata.prepare) {
      return undefined;
    }
    return this.metadata.prepare(driver);
  }

  /**
   * Parse raw query result into typed result.
   * Used after batch execution to transform the raw result.
   *
   * @param raw - Raw query result from driver
   * @returns Typed result
   */
  parseResult(raw: { rows: unknown[]; rowCount: number }): T {
    if (!this.metadata.parseResult) {
      // Fallback: return rows as-is for queries, rowCount for batch operations
      if (this.metadata.isBatchOperation) {
        return { count: raw.rowCount } as T;
      }
      return raw.rows as T;
    }
    return this.metadata.parseResult(raw);
  }

  /**
   * Wrap the executor with post-processing.
   * Returns a new PendingOperation (immutable pattern).
   *
   * Used by the client to add cache invalidation after mutations.
   *
   * @example
   * ```ts
   * const wrapped = pendingOp.wrapExecutor(async (execute) => {
   *   const result = await execute();
   *   await cache.invalidate(modelName);
   *   return result;
   * });
   * ```
   */
  wrapExecutor(
    wrapper: (execute: (driver?: AnyDriver) => Promise<T>) => Promise<T>
  ): PendingOperation<T> {
    return new PendingOperation({
      ...this.metadata,
      execute: (driverOverride?: AnyDriver) =>
        wrapper((driver) => this.metadata.execute(driver ?? driverOverride)),
    });
  }

  /**
   * Implement PromiseLike.then() for direct await support
   * When awaited directly, the operation executes immediately
   */
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.getPromise().then(onfulfilled, onrejected);
  }

  /**
   * Implement catch() for error handling
   */
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T | TResult> {
    return this.getPromise().catch(onrejected);
  }

  /**
   * Implement finally() for cleanup
   */
  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.getPromise().finally(onfinally);
  }
}

/**
 * Type guard to check if a value is a PendingOperation
 */
export function isPendingOperation<T = unknown>(
  value: unknown
): value is PendingOperation<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    PENDING_OPERATION_SYMBOL in value &&
    (value as Record<symbol, unknown>)[PENDING_OPERATION_SYMBOL] === true
  );
}

/**
 * Utility type to extract the result type from a PendingOperation
 */
export type UnwrapPendingOperation<T> =
  T extends PendingOperation<infer U> ? U : T;

/**
 * Utility type to unwrap an array of PendingOperations
 */
export type UnwrapPendingOperations<
  T extends readonly PendingOperation<unknown>[],
> = {
  [K in keyof T]: UnwrapPendingOperation<T[K]>;
};
