/**
 * An array transaction whose members are intercepted (a query handler, a
 * write-outcome registration, an observer), and a callback transaction that
 * collects write outcomes. Only a client with extensions runs either, so this
 * comes with what admits and runs extensions (`@extensions/host`).
 */
import { attachCommitCertainty } from "@drivers/driver-error-context";
import { bindExecutionTransactionPhases } from "@drivers/execution-context";
import type { AnyDriver, QueryExecutionContext } from "@drivers/exports";
import type {
  BatchTransactionOptions,
  TransactionOptions,
} from "@drivers/shared/transaction-options";
import {
  InvalidTransactionInputError,
  isVibORMError,
  retainWriteOutcomeFailure,
} from "@errors";
import {
  decomposeQueryCoordinationFailure,
  extensionHost,
  prewarmProtectedObservers,
} from "@extensions/host-slot";
import type { TransactionWriteOutcomes, WriteOutcome } from "@extensions/query";
import type { QueryEngine } from "@query-engine/query-engine";
import {
  type TransactionOperationCapability,
  transactionOperationOwner,
} from "@query-engine/transaction-operation";
import { combineArrayFailures } from "./array-transaction-failures";
import {
  executeInterceptedNativeArray,
  type NativeArraySlot,
} from "./array-transaction-native";
import { assertAtomicArraySupport } from "./array-transaction-native-batch";

type ArraySlot = NativeArraySlot;

export interface ArrayObservationState {
  certainty?: "committed" | "may-have-committed";
}

export async function executeInterceptedArray(
  operations: readonly TransactionOperationCapability[],
  engine: QueryEngine,
  options: TransactionOptions | BatchTransactionOptions | undefined,
  context: QueryExecutionContext,
  observation?: ArrayObservationState
): Promise<unknown[]> {
  const driver = engine.driver;
  assertAtomicArraySupport(driver);

  const observerReadiness = prewarmProtectedObservers(
    engine.extensionChain?.observe
  );
  if (observerReadiness !== undefined) await observerReadiness;
  const outcomes = new (extensionHost().TransactionWriteOutcomes)();
  const slots = operations.map(createArraySlot);
  startArrayOperationObservers(slots, engine);
  try {
    for (const slot of slots) {
      slot.owner.reserveWith(slot.operation, driver);
    }
    for (const slot of slots) {
      await slot.owner.observeBatchPhase(slot.operation, driver, () =>
        slot.owner.prepareAdmission(slot.operation)
      );
    }
    for (const slot of slots) {
      await slot.owner.observeBatchPhase(slot.operation, driver, () =>
        slot.owner.prepareAdmission(slot.operation, "plan")
      );
    }
  } catch (error) {
    closeArrayOperationObservers(slots, error);
    throw error;
  }
  for (const slot of slots) {
    slot.owner.stagePackageWriteOutcomes(slot.operation, outcomes);
  }
  const admissionFailures = await extensionHost().admitArrayQueries(
    slots,
    outcomes,
    (slot, child, control) =>
      slot.owner.startInterception(slot.operation, child, outcomes, control)
  );
  if (admissionFailures !== undefined) {
    throw combineArrayFailures(
      admissionFailures[0],
      admissionFailures.slice(1)
    );
  }

  if (!driver.supportsTransactions && driver.supportsBatch) {
    return executeInterceptedNativeArray(
      slots,
      outcomes,
      driver,
      options,
      context,
      (certainty) => {
        if (observation) observation.certainty = certainty;
      }
    );
  }
  return executeInterceptedFallback(
    slots,
    outcomes,
    engine,
    options,
    context,
    observation
  );
}

function createArraySlot(operation: TransactionOperationCapability): ArraySlot {
  return {
    operation,
    owner: transactionOperationOwner(operation),
    admitted: false,
    child: extensionHost().createArrayDeferred<unknown>(),
  };
}

function startArrayOperationObservers(
  slots: readonly ArraySlot[],
  engine: QueryEngine
): void {
  const observers = engine.extensionChain?.observe;
  if (observers === undefined || observers.length === 0) return;
  for (const slot of slots) {
    const observation = extensionHost().createArrayDeferred<unknown>();
    slot.observation = observation;
    if (!slot.owner.hasObservation(slot.operation))
      throw new InvalidTransactionInputError();
    slot.owner
      .observe(
        slot.operation,
        () => observation.promise,
        () =>
          slot.certainty === undefined
            ? undefined
            : { commitCertainty: slot.certainty }
      )
      .catch(() => undefined);
  }
}

function closeArrayOperationObservers(
  slots: readonly ArraySlot[],
  failure: unknown
): void {
  for (const slot of slots) slot.observation?.reject(failure);
}

/**
 * Run one transaction whose write outcomes this scope collects. A root scope
 * tracks the commit phases, so a failure after COMMIT was sent still reports
 * its certainty and publishes what may have committed; a savepoint promotes
 * its outcomes into the parent collector, which owns that decision.
 */
export async function runOutcomeTransaction<T>(
  driver: AnyDriver,
  outcomes: TransactionWriteOutcomes,
  parentOutcomes: TransactionWriteOutcomes | undefined,
  options: TransactionOptions | undefined,
  context: QueryExecutionContext,
  body: (driver: AnyDriver) => Promise<T>,
  report?: (certainty: WriteOutcome["certainty"]) => void,
  mapFailure: (error: unknown) => unknown = (error) => error
): Promise<T> {
  let phase: "ready" | "committed" | undefined;
  let result: T;
  try {
    result = await driver.withTransaction(
      body,
      options,
      parentOutcomes
        ? context
        : bindExecutionTransactionPhases(context, {
            readyToCommit: () => {
              phase = "ready";
            },
            committed: () => {
              phase = "committed";
            },
          })
    );
  } catch (error) {
    const failure = mapFailure(error);
    if (phase === undefined) {
      outcomes.discardAll();
      throw failure;
    }
    const certainty = phase === "ready" ? "may-have-committed" : phase;
    report?.(certainty);
    const primary = isVibORMError(failure)
      ? attachCommitCertainty(failure, certainty)
      : failure;
    try {
      await outcomes.publish(certainty);
    } catch (outcomeFailure) {
      throw retainWriteOutcomeFailure(primary, outcomeFailure);
    }
    throw primary;
  }
  if (parentOutcomes) outcomes.promoteTo(parentOutcomes);
  else {
    report?.("committed");
    await outcomes.publishCommitted();
  }
  return result;
}

function executeInterceptedFallback(
  slots: readonly ArraySlot[],
  outcomes: TransactionWriteOutcomes,
  engine: QueryEngine,
  options: TransactionOptions | BatchTransactionOptions | undefined,
  context: QueryExecutionContext,
  observation: ArrayObservationState | undefined
): Promise<unknown[]> {
  const suppressedPostWork: unknown[] = [];
  return runOutcomeTransaction(
    engine.driver,
    outcomes,
    engine.transactionWriteOutcomes,
    options as TransactionOptions | undefined,
    context,
    async (transactionDriver) => {
      const values: unknown[] = [];
      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index]!;
        startFallbackCore(slot, transactionDriver);
        try {
          values.push(await extensionHost().readArrayQuery(slot));
        } catch (error) {
          const firstFailure = decomposeQueryCoordinationFailure(error);
          const childFailure =
            firstFailure === undefined ? error : firstFailure.child;
          if (firstFailure) {
            for (const postWork of firstFailure.postWork) {
              suppressedPostWork.push(postWork);
            }
          }
          for (let later = index + 1; later < slots.length; later += 1) {
            slots[later]!.child.reject(childFailure);
          }
          const laterOutcomes = await Promise.allSettled(
            slots.slice(index + 1).map(extensionHost().readArrayQuery)
          );
          for (const outcome of laterOutcomes) {
            if (outcome.status !== "rejected") continue;
            const laterFailure = decomposeQueryCoordinationFailure(
              outcome.reason
            );
            if (laterFailure) {
              if (laterFailure.child !== childFailure) {
                suppressedPostWork.push(laterFailure.child);
              }
              for (const postWork of laterFailure.postWork) {
                suppressedPostWork.push(postWork);
              }
            } else if (outcome.reason !== childFailure) {
              suppressedPostWork.push(outcome.reason);
            }
          }
          throw childFailure;
        }
      }
      return values;
    },
    observation &&
      ((certainty) => {
        observation.certainty = certainty;
      }),
    (error) => combineArrayFailures(error, suppressedPostWork)
  );
}

function startFallbackCore(slot: ArraySlot, driver: AnyDriver): void {
  let core: Promise<unknown>;
  try {
    core = slot.owner.executeCore(slot.operation, driver, slot.notifications);
  } catch (error) {
    slot.child.reject(error);
    return;
  }
  core.then(slot.child.resolve, slot.child.reject);
}
