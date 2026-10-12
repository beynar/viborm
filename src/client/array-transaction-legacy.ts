import { bindExecutionTransactionPhases } from "@drivers/execution-context";
import type {
  AnyDriver,
  QueryExecutionContext,
  QueryResult,
} from "@drivers/exports";
import type {
  BatchTransactionOptions,
  TransactionOptions,
} from "@drivers/shared/transaction-options";
import { InvalidTransactionInputError } from "@errors";
import { prewarmProtectedObservers } from "@extensions/observation";
import type { QueryEngine } from "@query-engine/query-engine";
import {
  type TransactionOperationCapability,
  transactionOperationOwner,
} from "@query-engine/transaction-operation";
import {
  assertAtomicArraySupport,
  assertNativeBatchResults,
  executeNativeBatch,
  type NativeBatchMember,
  type PreparedNativeBatch,
  prepareNativeBatch,
} from "./array-transaction-native-batch";

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
    const { queries, guards, parsers } = await prepareNativeBatch(
      batchMembers(operations),
      driver
    );
    const batchResults = await executeNativeBatch(
      driver,
      queries,
      guards,
      options,
      context
    );
    assertNativeBatchResults(driver, batchResults, queries.length);
    for (let index = 0; index < parsers.length; index += 1) {
      results[index] = await parsers[index]!(batchResults);
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
    runInOrder(operations, results),
    options as TransactionOptions | undefined,
    context
  );
}

function batchMembers(
  operations: readonly TransactionOperationCapability[]
): NativeBatchMember[] {
  return operations.map((operation) => ({
    operation,
    owner: transactionOperationOwner(operation),
  }));
}

function runInOrder(
  operations: readonly TransactionOperationCapability[],
  results: unknown[]
): (transactionDriver: AnyDriver) => Promise<unknown[]> {
  return async (transactionDriver) => {
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]!;
      results[index] = await transactionOperationOwner(operation).executeWith(
        operation,
        transactionDriver
      );
    }
    return results;
  };
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
  let batch: PreparedNativeBatch;
  try {
    for (const operation of operations) {
      transactionOperationOwner(operation).reserveWith(operation, driver);
    }
    batch = await prepareNativeBatch(batchMembers(operations), driver);
  } catch (error) {
    rejectObservedMembers(observations, error);
    throw error;
  }
  const { queries, guards, parsers } = batch;

  let batchResults: QueryResult<unknown>[];
  try {
    batchResults = await executeNativeBatch(
      driver,
      queries,
      guards,
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
    assertNativeBatchResults(driver, batchResults, queries.length);
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
      runInOrder(operations, results),
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
