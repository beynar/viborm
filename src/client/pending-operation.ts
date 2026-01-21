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
 */

import type { AnyDriver } from "@drivers";
import type { QueryMetadata, ResultParser } from "@query-engine/types";

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
   * The executor function that performs the actual database operation
   */
  private readonly executor: () => Promise<T>;

  /**
   * Query metadata for batch execution
   */
  private readonly metadata: QueryMetadata<T>;

  constructor(executor: () => Promise<T>, metadata: QueryMetadata<T>) {
    this.executor = executor;
    this.metadata = metadata;
  }

  /**
   * Check if this operation can be batched (has precomputed SQL)
   * Operations with nested writes cannot be batched as they require
   * multiple queries with runtime-dependent values.
   */
  canBatch(): boolean {
    return this.metadata.sql !== null;
  }

  /**
   * Get SQL string for batch execution with driver-specific placeholders
   * @param placeholderType - "?" for SQLite/MySQL, "$n" for PostgreSQL
   */
  getSqlString(placeholderType: "?" | "$n"): string | null {
    return this.metadata.sql?.toStatement(placeholderType) ?? null;
  }

  /**
   * Get query parameters for batch execution
   */
  getParams(): unknown[] {
    return this.metadata.sql?.values ?? [];
  }

  /**
   * Get the result parser for batch execution
   */
  getResultParser(): ResultParser<T> {
    return this.metadata.parseResult;
  }

  /**
   * Check if this is a batch operation (returns rowCount)
   */
  isBatchOperation(): boolean {
    return this.metadata.isBatchOperation ?? false;
  }

  /**
   * Get pre-validated args from prepareMetadata
   */
  getValidatedArgs(): Record<string, unknown> {
    return this.metadata.validatedArgs;
  }

  /**
   * Execute the operation immediately
   */
  execute(): Promise<T> {
    return this.executor();
  }

  /**
   * Execute the operation with a specific driver.
   * Used for transaction-bound execution where we need to use the txDriver.
   *
   * For batchable operations (with precomputed SQL), executes directly on the driver.
   * For non-batchable operations (nested writes), falls back to the default executor
   * since the executor already handles transaction context via the driver's clone.
   */
  async executeWith(driver: AnyDriver): Promise<T> {
    // For batchable operations, we can execute directly on the provided driver
    if (this.metadata.sql) {
      const result = await driver._execute<Record<string, unknown>>(
        this.metadata.sql
      );
      // Use the result parser to transform the result
      const input = this.metadata.isBatchOperation
        ? { rowCount: result.rowCount }
        : result.rows;
      return this.metadata.parseResult(input);
    }

    // For non-batchable operations (nested writes), fall back to default executor
    // The executor handles transactions internally via withTransactionIfSupported
    return this.executor();
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
  wrapExecutor<U>(
    wrapper: (execute: () => Promise<T>) => Promise<U>
  ): PendingOperation<U> {
    const originalExecutor = this.executor;
    return new PendingOperation(
      () => wrapper(originalExecutor),
      this.metadata as unknown as QueryMetadata<U>
    );
  }

  /**
   * Implement PromiseLike.then() for direct await support
   * When awaited directly, the operation executes immediately
   */
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.executor().then(onfulfilled, onrejected);
  }

  /**
   * Implement catch() for error handling
   */
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T | TResult> {
    return this.executor().catch(onrejected);
  }

  /**
   * Implement finally() for cleanup
   */
  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.executor().finally(onfinally);
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
export type UnwrapPendingOperations<T extends readonly PendingOperation<unknown>[]> = {
  [K in keyof T]: UnwrapPendingOperation<T[K]>;
};
