import type {
  AnyDriver,
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import { bindExecutionTransactionPhases } from "@drivers/execution-context";
import { assertNormalizedBatchResults } from "@drivers/normalized-result";
import type {
  BatchTransactionOptions,
  TransactionOptions,
} from "@drivers/shared/transaction-options";
import { InvalidTransactionInputError, TransactionError } from "@errors";
import { prewarmProtectedObservers } from "@extensions/observation";
import { attributeOperationBatchError } from "@query-engine/batch-error-attribution";
import type { QueryEngine } from "@query-engine/query-engine";
import {
  type TransactionOperationCapability,
  transactionOperationOwner,
} from "@query-engine/transaction-operation";
import type { PreparedBatchGuard } from "@query-engine/types";

interface LegacyNativeMember {
  parse(batchResults: QueryResult<unknown>[]): Promise<unknown>;
}

/** The allocation-compatible array path used when no query handler compiled. */
export async function executeLegacyArrayTransaction(
  operations: TransactionOperationCapability[],
  engine: QueryEngine,
  options: TransactionOptions | BatchTransactionOptions | undefined,
  context: QueryExecutionContext,
  observeArrayLifecycle = false,
  reportCertainty?: (certainty: "committed" | "may-have-committed") => void
): Promise<unknown[]> {
  const driver = engine.driver;
  const results: unknown[] = operations;
  if (!driver.supportsTransactions && driver.supportsBatch) {
    if (observeArrayLifecycle) {
      const observerReadiness = prewarmProtectedObservers(
        engine.extensionChain?.observe
      );
      if (observerReadiness !== undefined) await observerReadiness;
      return executeObservedNativeArray(
        operations,
        driver,
        options,
        context,
        reportCertainty
      );
    }
    for (const operation of operations) {
      transactionOperationOwner(operation).reserveWith(operation, driver);
    }
    const operationQueries: BatchQuery[] = [];
    const batchGuards: PreparedBatchGuard[] = [];
    const members: LegacyNativeMember[] = [];

    for (const operation of operations) {
      const owner = transactionOperationOwner(operation);
      const preparation = await owner.observeBatchPhase(
        operation,
        driver,
        async () => {
          const prepared = owner.prepare(operation, driver);
          if (prepared) return { kind: "single" as const, prepared };
          return {
            kind: "batch" as const,
            preparedBatch: await owner.prepareBatch(operation, driver),
          };
        }
      );
      if (preparation.kind === "single") {
        const start = operationQueries.length;
        operationQueries.push(preparation.prepared);
        members.push({
          parse: (batchResults) =>
            owner.observeBatchPhase(operation, driver, () => {
              const result = batchResults[start];
              if (!result) throw missingOperationResult(driver, operation);
              return owner.parseResult(operation, result);
            }),
        });
        continue;
      }

      const { preparedBatch } = preparation;
      if (!preparedBatch) break;
      const start = operationQueries.length;
      const length = preparedBatch.queries.length;
      for (const query of preparedBatch.queries) operationQueries.push(query);
      for (const guard of preparedBatch.guards ?? []) {
        batchGuards.push({ ...guard, queryIndex: start + guard.queryIndex });
      }
      members.push({
        parse: (batchResults) =>
          owner.observeBatchPhase(operation, driver, () =>
            preparedBatch.parseResult(batchResults.slice(start, start + length))
          ),
      });
    }

    if (members.length !== operations.length) {
      throw unbatchableArrayError(driver);
    }
    const batchResults = await executeNativeBatch(
      driver,
      operationQueries,
      batchGuards,
      options,
      context
    );
    assertNormalizedBatchResults(batchResults, operationQueries.length, {
      provider: driver.driverName,
      operation: "$transaction([...])",
    });
    for (let index = 0; index < members.length; index += 1) {
      results[index] = await members[index]!.parse(batchResults);
    }
    return results;
  }

  assertAtomicArraySupport(driver);
  if (observeArrayLifecycle) {
    return executeObservedFallbackArray(
      operations,
      engine,
      options,
      context,
      reportCertainty
    );
  }
  return driver.withTransaction(
    async (transactionDriver) => {
      for (let index = 0; index < operations.length; index += 1) {
        const operation = operations[index]!;
        const value = await transactionOperationOwner(operation).executeWith(
          operation,
          transactionDriver
        );
        results[index] = value;
      }
      return results;
    },
    options as TransactionOptions | undefined,
    context
  );
}

interface ObservedNativeMember {
  readonly application: Promise<unknown>;
  readonly rejectChild: (reason?: unknown) => void;
  readonly resolveChild: (value: unknown) => void;
  settled: boolean;
  certainty?: "committed" | "may-have-committed";
}

async function executeObservedNativeArray(
  operations: TransactionOperationCapability[],
  driver: AnyDriver,
  options: TransactionOptions | BatchTransactionOptions | undefined,
  context: QueryExecutionContext,
  reportCertainty:
    | ((certainty: "committed" | "may-have-committed") => void)
    | undefined
): Promise<unknown[]> {
  const results: unknown[] = operations;
  const observations: ObservedNativeMember[] = [];
  try {
    for (const operation of operations) {
      observations.push(startNativeObservation(operation));
    }
  } catch (error) {
    rejectObservedMembers(observations, error);
    throw error;
  }
  const operationQueries: BatchQuery[] = [];
  const batchGuards: PreparedBatchGuard[] = [];
  const parsers: ((
    batchResults: QueryResult<unknown>[]
  ) => Promise<unknown>)[] = [];

  try {
    for (const operation of operations) {
      transactionOperationOwner(operation).reserveWith(operation, driver);
    }
    for (const operation of operations) {
      const owner = transactionOperationOwner(operation);
      const preparation = await owner.observeBatchPhase(
        operation,
        driver,
        async () => {
          const prepared = owner.prepare(operation, driver);
          if (prepared) return { kind: "single" as const, prepared };
          return {
            kind: "batch" as const,
            preparedBatch: await owner.prepareBatch(operation, driver),
          };
        }
      );
      if (preparation.kind === "single") {
        const start = operationQueries.length;
        operationQueries.push(preparation.prepared);
        parsers.push((batchResults) =>
          owner.observeBatchPhase(operation, driver, () => {
            const result = batchResults[start];
            if (!result) throw missingOperationResult(driver, operation);
            return owner.parseResult(operation, result);
          })
        );
        continue;
      }
      const { preparedBatch } = preparation;
      if (!preparedBatch) throw unbatchableArrayError(driver);
      const start = operationQueries.length;
      const length = preparedBatch.queries.length;
      for (const query of preparedBatch.queries) operationQueries.push(query);
      for (const guard of preparedBatch.guards ?? []) {
        batchGuards.push({ ...guard, queryIndex: start + guard.queryIndex });
      }
      parsers.push((batchResults) =>
        owner.observeBatchPhase(operation, driver, () =>
          preparedBatch.parseResult(batchResults.slice(start, start + length))
        )
      );
    }
  } catch (error) {
    rejectObservedMembers(observations, error);
    throw error;
  }

  let batchResults: QueryResult<unknown>[];
  try {
    batchResults = await executeNativeBatch(
      driver,
      operationQueries,
      batchGuards,
      options,
      context
    );
  } catch (error) {
    setObservedCertainty(observations, "may-have-committed");
    reportCertainty?.("may-have-committed");
    rejectObservedMembers(observations, error);
    throw error;
  }

  setObservedCertainty(observations, "committed");
  reportCertainty?.("committed");
  try {
    assertNormalizedBatchResults(batchResults, operationQueries.length, {
      provider: driver.driverName,
      operation: "$transaction([...])",
    });
    for (let index = 0; index < parsers.length; index += 1) {
      const value = await parsers[index]!(batchResults);
      const observation = observations[index]!;
      resolveObservedMember(observation, value);
      results[index] = await observation.application;
    }
    return results;
  } catch (error) {
    rejectObservedMembers(observations, error);
    throw error;
  }
}

async function executeObservedFallbackArray(
  operations: TransactionOperationCapability[],
  engine: QueryEngine,
  options: TransactionOptions | BatchTransactionOptions | undefined,
  context: QueryExecutionContext,
  reportCertainty:
    | ((certainty: "committed" | "may-have-committed") => void)
    | undefined
): Promise<unknown[]> {
  const results: unknown[] = operations;
  const transactionState: { phase: "pending" | "ready" | "committed" } = {
    phase: "pending",
  };
  const isNested = engine.transactionWriteOutcomes !== undefined;
  const transactionContext = isNested
    ? context
    : bindExecutionTransactionPhases(context, {
        readyToCommit: () => {
          transactionState.phase = "ready";
        },
        committed: () => {
          transactionState.phase = "committed";
        },
      });
  try {
    const transactionResults = await engine.driver.withTransaction(
      async (transactionDriver) => {
        for (let index = 0; index < operations.length; index += 1) {
          const operation = operations[index]!;
          const value = await transactionOperationOwner(operation).executeWith(
            operation,
            transactionDriver
          );
          results[index] = value;
        }
        return results;
      },
      options as TransactionOptions | undefined,
      transactionContext
    );
    if (!isNested) reportCertainty?.("committed");
    return transactionResults;
  } catch (error) {
    if (!isNested && transactionState.phase === "committed") {
      reportCertainty?.("committed");
    } else if (!isNested && transactionState.phase === "ready") {
      reportCertainty?.("may-have-committed");
    }
    throw error;
  }
}

function startNativeObservation(
  operation: TransactionOperationCapability
): ObservedNativeMember {
  const owner = transactionOperationOwner(operation);
  if (!owner.hasObservation(operation))
    throw new InvalidTransactionInputError();
  let rejectChild: (reason?: unknown) => void = () => undefined;
  let resolveChild: (value: unknown) => void = () => undefined;
  const child = new Promise<unknown>((resolve, reject) => {
    resolveChild = resolve;
    rejectChild = reject;
  });
  let member: ObservedNativeMember;
  const application = owner.observe(
    operation,
    () => child,
    () =>
      member.certainty === undefined
        ? undefined
        : { commitCertainty: member.certainty }
  );
  member = {
    application,
    rejectChild,
    resolveChild,
    settled: false,
  };
  member.application.catch(() => undefined);
  return member;
}

function rejectObservedMember(
  member: ObservedNativeMember,
  failure: unknown
): void {
  if (member.settled) return;
  member.settled = true;
  member.rejectChild(failure);
}

function resolveObservedMember(
  member: ObservedNativeMember,
  value: unknown
): void {
  if (member.settled) return;
  member.settled = true;
  member.resolveChild(value);
}

function rejectObservedMembers(
  observations: readonly ObservedNativeMember[],
  failure: unknown
): void {
  for (const observation of observations) {
    rejectObservedMember(observation, failure);
  }
}

function setObservedCertainty(
  observations: readonly ObservedNativeMember[],
  certainty: "committed" | "may-have-committed"
): void {
  for (const observation of observations) observation.certainty = certainty;
}

async function executeNativeBatch(
  driver: AnyDriver,
  queries: BatchQuery[],
  guards: PreparedBatchGuard[],
  options: TransactionOptions | BatchTransactionOptions | undefined,
  context: QueryExecutionContext
): Promise<QueryResult<unknown>[]> {
  if (queries.length === 0) return [];
  try {
    return await driver._executeBatch(
      queries,
      options as BatchTransactionOptions | undefined,
      context
    );
  } catch (error) {
    throw await attributeOperationBatchError(error, guards, driver, queries);
  }
}

function assertAtomicArraySupport(driver: AnyDriver): void {
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

function unbatchableArrayError(driver: AnyDriver): TransactionError {
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

function missingOperationResult(
  driver: AnyDriver,
  operation: TransactionOperationCapability
): TransactionError {
  const operationName =
    transactionOperationOwner(operation).operation(operation);
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
