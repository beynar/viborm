import { TransactionError } from "@errors";
import type { TransactionPhaseNotifications } from "../execution-context";

export function nestedTransactionDispatchError(
  driverName: string
): TransactionError {
  return new TransactionError(
    `Driver "${driverName}" received nested provider state outside TransactionBoundDriver.`,
    { meta: { driver: driverName, method: "$transaction" } }
  );
}

export function unsupportedCallbackTransactionError(
  driverName: string
): TransactionError {
  return new TransactionError(
    `Driver "${driverName}" does not support callback transactions.`,
    { meta: { driver: driverName, method: "$transaction(callback)" } }
  );
}

type LifecycleStep = () => unknown | Promise<unknown>;

export interface TransactionLifecycle<T> {
  readonly begin: LifecycleStep;
  readonly callback: () => Promise<T>;
  readonly commit: LifecycleStep;
  readonly rollback: LifecycleStep;
  readonly close?: LifecycleStep;
  readonly phases?: TransactionPhaseNotifications;
}

export interface ProviderManagedTransaction<T, TTransaction> {
  readonly run: (
    callback: (tx: TTransaction) => Promise<T>
  ) => Promise<unknown>;
  readonly callback: (tx: TTransaction) => Promise<T>;
  readonly close: LifecycleStep;
  readonly phases?: TransactionPhaseNotifications;
}

type ProviderCallbackOutcome<T> =
  | { readonly status: "pending" }
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly error: unknown; readonly status: "rejected" };

/** Close provider-owned transaction state when its own cleanup/finalization fails. */
export async function runProviderManagedTransaction<T, TTransaction>(
  lifecycle: ProviderManagedTransaction<T, TTransaction>
): Promise<T> {
  let callbackCallCount = 0;
  let callbackOutcome: ProviderCallbackOutcome<T> = {
    status: "pending",
  };
  const readCallbackOutcome = (): ProviderCallbackOutcome<T> => callbackOutcome;
  let callbackPromise: Promise<T> | undefined;
  let closeAttempted = false;
  const capturedCloseFailures: unknown[] = [];
  const closeBeforeCallbackDrain = async () => {
    closeAttempted = true;
    try {
      await lifecycle.close();
    } catch (error) {
      capturedCloseFailures.push(error);
    }
  };
  try {
    await lifecycle.run((tx) => {
      callbackCallCount++;
      if (callbackCallCount > 1) {
        throw new TransactionError(
          "Transaction provider invoked the transaction callback more than once."
        );
      }
      callbackPromise = (async () => {
        try {
          const value = await lifecycle.callback(tx);
          lifecycle.phases?.readyToCommit();
          callbackOutcome = { status: "fulfilled", value };
          return value;
        } catch (error) {
          callbackOutcome = { status: "rejected", error };
          throw error;
        }
      })();
      callbackPromise.catch(() => undefined);
      return callbackPromise;
    });
  } catch (error) {
    const providerSettledBeforeCallback =
      callbackPromise !== undefined &&
      readCallbackOutcome().status === "pending";
    if (callbackPromise && providerSettledBeforeCallback) {
      await closeBeforeCallbackDrain();
      await callbackPromise.catch(() => undefined);
    }
    const settledOutcome = readCallbackOutcome();
    if (
      settledOutcome.status === "rejected" &&
      !providerSettledBeforeCallback &&
      error === settledOutcome.error
    ) {
      throw error;
    }
    const primaryFailure =
      settledOutcome.status === "rejected" ? settledOutcome.error : error;
    const cleanupFailures: unknown[] = [];
    if (providerSettledBeforeCallback) {
      cleanupFailures.push(
        new TransactionError(
          "Transaction provider settled before the transaction callback settled."
        )
      );
    }
    if (
      settledOutcome.status === "rejected" &&
      error !== settledOutcome.error
    ) {
      cleanupFailures.push(
        ...readTransactionCleanupFailures(error, settledOutcome.error)
      );
    }
    cleanupFailures.push(...capturedCloseFailures);
    const cleanupSteps = cleanupFailures.map(failureStep);
    if (!closeAttempted) cleanupSteps.push(lifecycle.close);
    return throwAfterCleanup(primaryFailure, cleanupSteps);
  }
  const providerSettledBeforeCallback =
    callbackPromise !== undefined && readCallbackOutcome().status === "pending";
  if (callbackPromise && providerSettledBeforeCallback) {
    await closeBeforeCallbackDrain();
    await callbackPromise.catch(() => undefined);
  }
  const settledOutcome = readCallbackOutcome();
  const contractFailures: TransactionError[] = [];
  if (callbackCallCount !== 1) {
    contractFailures.push(
      new TransactionError(
        callbackCallCount === 0
          ? "Transaction provider completed without invoking the transaction callback."
          : "Transaction provider invoked the transaction callback more than once."
      )
    );
  }
  if (providerSettledBeforeCallback) {
    contractFailures.push(
      new TransactionError(
        "Transaction provider completed before the transaction callback settled."
      )
    );
  }
  if (settledOutcome.status === "rejected") {
    contractFailures.push(
      new TransactionError(
        "Transaction provider resolved after the transaction callback rejected."
      )
    );
  }
  if (contractFailures.length > 0) {
    const primaryFailure =
      settledOutcome.status === "rejected"
        ? settledOutcome.error
        : contractFailures.shift();
    const cleanupSteps = [
      ...contractFailures.map(failureStep),
      ...capturedCloseFailures.map(failureStep),
    ];
    if (!closeAttempted) cleanupSteps.push(lifecycle.close);
    return throwAfterCleanup(primaryFailure, cleanupSteps);
  }
  if (settledOutcome.status !== "fulfilled") {
    return throwAfterCleanup(
      new TransactionError("Transaction callback outcome was not recorded."),
      [lifecycle.close]
    );
  }
  lifecycle.phases?.committed();
  return settledOutcome.value;
}

/** Run a top-level provider transaction without losing cleanup failures. */
export async function runTransactionLifecycle<T>(
  lifecycle: TransactionLifecycle<T>
): Promise<T> {
  try {
    await lifecycle.begin();
  } catch (error) {
    return throwAfterCleanup(error, lifecycle.close ? [lifecycle.close] : []);
  }

  let result: T;
  try {
    result = await lifecycle.callback();
  } catch (error) {
    const cleanup = [lifecycle.rollback];
    if (lifecycle.close) cleanup.push(lifecycle.close);
    return throwAfterCleanup(error, cleanup);
  }

  lifecycle.phases?.readyToCommit();

  try {
    await lifecycle.commit();
  } catch (error) {
    const cleanup = [lifecycle.rollback];
    if (lifecycle.close) cleanup.push(lifecycle.close);
    return throwAfterCleanup(error, cleanup);
  }

  lifecycle.phases?.committed();

  if (lifecycle.close) await lifecycle.close();
  return result;
}

export const runSavepoint = async <T>(
  executeStatement: (statement: string) => unknown | Promise<unknown>,
  fn: () => Promise<T>
): Promise<T> => {
  const savepointName = `sp_${crypto.randomUUID().replace(/-/g, "")}`;
  await executeStatement(`SAVEPOINT ${savepointName}`);

  let result: T;
  try {
    result = await fn();
  } catch (error) {
    return throwAfterCleanup(error, [
      () => executeStatement(`ROLLBACK TO SAVEPOINT ${savepointName}`),
      () => executeStatement(`RELEASE SAVEPOINT ${savepointName}`),
    ]);
  }

  try {
    await executeStatement(`RELEASE SAVEPOINT ${savepointName}`);
  } catch (error) {
    return throwAfterCleanup(error, [
      () => executeStatement(`ROLLBACK TO SAVEPOINT ${savepointName}`),
      () => executeStatement(`RELEASE SAVEPOINT ${savepointName}`),
    ]);
  }
  return result;
};

export function createTransactionCleanupError(
  primaryFailure: unknown,
  cleanupFailures: readonly unknown[]
): AggregateError {
  return new AggregateError(
    [primaryFailure, ...cleanupFailures],
    readFailureMessage(primaryFailure),
    { cause: primaryFailure }
  );
}

export function readTransactionCleanupFailures(
  error: unknown,
  primaryFailure: unknown
): readonly unknown[] {
  try {
    if (!(error instanceof AggregateError) || error.cause !== primaryFailure) {
      return [error];
    }
    return error.errors[0] === primaryFailure ? error.errors.slice(1) : [error];
  } catch {
    return [error];
  }
}

async function throwAfterCleanup(
  primaryFailure: unknown,
  cleanupSteps: readonly LifecycleStep[]
): Promise<never> {
  const cleanupFailures: unknown[] = [];
  for (const cleanupStep of cleanupSteps) {
    try {
      await cleanupStep();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (cleanupFailures.length > 0) {
    throw createTransactionCleanupError(primaryFailure, cleanupFailures);
  }
  throw primaryFailure;
}

function failureStep(failure: unknown): LifecycleStep {
  return () => {
    throw failure;
  };
}

function readFailureMessage(error: unknown): string {
  try {
    return error instanceof Error && typeof error.message === "string"
      ? error.message
      : "Transaction failed";
  } catch {
    return "Transaction failed";
  }
}
