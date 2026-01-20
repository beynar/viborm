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

import type { Sql } from "@sql";

/**
 * Result parser function type
 * Transforms raw database rows into typed application objects
 */
export type ResultParser<T> = (rows: unknown[]) => T;

/**
 * Query metadata for batch execution
 */
export interface QueryMetadata<T> {
  /** The compiled SQL query */
  sql: Sql;
  /** Function to parse raw results into typed objects */
  parseResult: ResultParser<T>;
  /** Whether this is a batch operation (returns rowCount instead of rows) */
  isBatchOperation?: boolean;
}

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
   * Get the query metadata for batch execution
   */
  getMetadata(): QueryMetadata<T> {
    return this.metadata;
  }

  /**
   * Get the SQL query for batch execution
   */
  getSql(): Sql {
    return this.metadata.sql;
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
   * Execute the operation immediately
   */
  execute(): Promise<T> {
    return this.executor();
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
