import type { AnyDriver, QueryExecutionContext, QueryResult } from "@drivers";
import type { PreparedBatchOperation, PreparedQuery } from "./types";

export const TRANSACTION_OPERATION_SYMBOL = Symbol.for(
  "viborm.transactionOperation"
);

/** The operation surface consumed by `$transaction([...])`. */
export interface TransactionOperation<T> extends PromiseLike<T> {
  readonly [TRANSACTION_OPERATION_SYMBOL]: true;
  /** Consume this lazy operation for one native shared-batch execution. */
  reserveWith(driver: AnyDriver): void;
  executeWith(driver: AnyDriver): Promise<T>;
  prepare(driver?: AnyDriver): PreparedQuery | undefined;
  prepareBatch?(
    driver?: AnyDriver
  ): Promise<PreparedBatchOperation<T> | undefined>;
  parseResult(raw: QueryResult<unknown>): T;
  observeBatchPhase<R>(
    driver: AnyDriver,
    execute: () => R | Promise<R>
  ): Promise<R>;
  getModel(): string;
  getOperation(): string;
  getExecutionContext(): QueryExecutionContext;
  getClientId(): symbol;
  getScopeId(): symbol;
}

export function isTransactionOperation<T = unknown>(
  value: unknown
): value is TransactionOperation<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    TRANSACTION_OPERATION_SYMBOL in value &&
    Reflect.get(value, TRANSACTION_OPERATION_SYMBOL) === true
  );
}
