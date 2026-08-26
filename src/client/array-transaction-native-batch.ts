import type {
  AnyDriver,
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import { assertNormalizedBatchResults } from "@drivers/normalized-result";
import type {
  BatchTransactionOptions,
  TransactionOptions,
} from "@drivers/shared/transaction-options";
import { TransactionError } from "@errors";
import { attributeOperationBatchError } from "@query-engine/batch-error-attribution";
import type {
  TransactionOperationCapability,
  TransactionOperationOwner,
} from "@query-engine/transaction-operation";
import type { PreparedBatchGuard } from "@query-engine/types";

export async function executeNativeBatch(
  driver: AnyDriver,
  queries: BatchQuery[],
  guards: PreparedBatchGuard[],
  options: TransactionOptions | BatchTransactionOptions | undefined,
  context: QueryExecutionContext,
  committed?: () => Promise<void>
): Promise<QueryResult<unknown>[]> {
  if (queries.length === 0) return [];
  try {
    return await driver._executeBatch(
      queries,
      options as BatchTransactionOptions | undefined,
      context,
      committed
    );
  } catch (error) {
    throw await attributeOperationBatchError(error, guards, driver, queries);
  }
}

export function assertNativeBatchResults(
  driver: AnyDriver,
  results: QueryResult<unknown>[],
  queryCount: number
): void {
  assertNormalizedBatchResults(results, queryCount, {
    provider: driver.driverName,
    operation: "$transaction([...])",
  });
}

export function assertAtomicArraySupport(driver: AnyDriver): void {
  if (driver.supportsTransactions || driver.supportsBatch) return;
  throw new TransactionError(
    `Driver "${driver.driverName}" supports neither transactions nor atomic batch execution.`,
    {
      meta: {
        driver: driver.driverName,
        method: "$transaction([...])",
      },
    }
  );
}

export function unbatchableArrayError(driver: AnyDriver): TransactionError {
  return new TransactionError(
    `Driver "${driver.driverName}" does not support callback transactions and this transaction contains operations that cannot be batched atomically.`,
    {
      meta: {
        driver: driver.driverName,
        method: "$transaction([...])",
      },
    }
  );
}

export function missingOperationResult(
  driver: AnyDriver,
  operation: TransactionOperationCapability,
  owner: TransactionOperationOwner<TransactionOperationCapability>
): TransactionError {
  const operationName = owner.operation(operation);
  return new TransactionError(
    `Driver "${driver.driverName}" omitted the result for operation "${operationName}".`,
    {
      meta: {
        driver: driver.driverName,
        operation: operationName,
      },
    }
  );
}
