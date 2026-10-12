import type {
  AnyDriver,
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers/exports";
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

export interface NativeBatchMember {
  readonly operation: TransactionOperationCapability;
  readonly owner: TransactionOperationOwner<TransactionOperationCapability>;
}

export interface PreparedNativeBatch {
  readonly queries: BatchQuery[];
  readonly guards: PreparedBatchGuard[];
  readonly parsers: ((
    batchResults: QueryResult<unknown>[]
  ) => Promise<unknown>)[];
}

/** Prepare members in order into one native batch with per-member parsers. */
export async function prepareNativeBatch(
  members: readonly NativeBatchMember[],
  driver: AnyDriver
): Promise<PreparedNativeBatch> {
  const queries: BatchQuery[] = [];
  const guards: PreparedBatchGuard[] = [];
  const parsers: PreparedNativeBatch["parsers"] = [];
  for (const { operation, owner } of members) {
    const preparation = await owner.observeBatchPhase(
      operation,
      driver,
      async () => {
        const prepared = owner.prepare(operation, driver);
        if (prepared) return { kind: "single" as const, prepared };
        return {
          kind: "batch" as const,
          preparedBatch: await owner.prepareBatch(operation),
        };
      }
    );
    const start = queries.length;
    if (preparation.kind === "single") {
      queries.push(preparation.prepared);
      parsers.push((batchResults) =>
        owner.observeBatchPhase(operation, driver, () => {
          const result = batchResults[start];
          if (!result) throw missingOperationResult(driver, operation, owner);
          return owner.parseResult(operation, result);
        })
      );
      continue;
    }
    const { preparedBatch } = preparation;
    if (!preparedBatch) throw unbatchableArrayError(driver);
    const length = preparedBatch.queries.length;
    for (const query of preparedBatch.queries) queries.push(query);
    for (const guard of preparedBatch.guards ?? []) {
      guards.push({ ...guard, queryIndex: start + guard.queryIndex });
    }
    parsers.push((batchResults) =>
      owner.observeBatchPhase(operation, driver, () =>
        preparedBatch.parseResult(batchResults.slice(start, start + length))
      )
    );
  }
  return { queries, guards, parsers };
}

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
