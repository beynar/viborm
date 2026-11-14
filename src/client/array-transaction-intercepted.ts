/**
 * An array transaction whose members are intercepted (a query handler, a
 * write-outcome registration, an observer), and a callback transaction that
 * collects write outcomes. Only a chain whose parts wrap a call's execution
 * runs either, so this comes with those parts (`@extensions/coordination`).
 */
import { attachCommitCertainty } from "@drivers/driver-error-context";
import { bindExecutionTransactionPhases } from "@drivers/execution-context";
import type { AnyDriver, QueryExecutionContext } from "@drivers/exports";
import type {
  BatchTransactionOptions,
  TransactionOptions,
} from "@drivers/shared/transaction-options";
import { isVibORMError, retainWriteOutcomeFailure } from "@errors";
import {
  admitArrayQueries,
  createArrayDeferred,
  readArrayQuery,
} from "@extensions/array-admission";
import { TransactionWriteOutcomes, type WriteOutcome } from "@extensions/query";
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

  const outcomes = new TransactionWriteOutcomes();
  const slots = operations.map(createArraySlot);
  const units = await startArrayOperationUnits(slots, engine);
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
  const admissionFailures = await admitArrayQueries(
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

  const values = await (!driver.supportsTransactions && driver.supportsBatch
    ? executeInterceptedNativeArray(
        slots,
        outcomes,
        driver,
        options,
        context,
        (certainty) => {
          if (observation) observation.certainty = certainty;
        }
      )
    : executeInterceptedFallback(
        slots,
        outcomes,
        engine,
        options,
        context,
        observation
      ));
  // What a member's unit handler threw, once its child succeeded, fails the
  // array: the host contains nothing a handler does.
  await units?.done;
  return values;
}

function createArraySlot(operation: TransactionOperationCapability): ArraySlot {
  return {
    operation,
    owner: transactionOperationOwner(operation),
    admitted: false,
    child: createArrayDeferred<unknown>(),
  };
}

/**
 * Each member's `operation` unit, started before any member is prepared, and
 * the array waits until every unit's child is reached: a handler that waits
 * first (for a tracer to load) does so before the array's work, which then
 * runs inside each member's unit.
 */
function startArrayOperationUnits(
  slots: readonly ArraySlot[],
  engine: QueryEngine
): Promise<{ readonly done: Promise<unknown> }> | undefined {
  return engine.extensionChain?.observation?.members(
    slots.map((slot) => {
      const child = createArrayDeferred<unknown>();
      slot.observation = child;
      return [
        { ...slot.owner.unit(slot.operation), certainty: () => slot.certainty },
        () => child.promise,
      ];
    })
  );
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
          values.push(await readArrayQuery(slot));
        } catch (childFailure) {
          for (let later = index + 1; later < slots.length; later += 1) {
            slots[later]!.child.reject(childFailure);
          }
          for (const outcome of await Promise.allSettled(
            slots.slice(index + 1).map(readArrayQuery)
          )) {
            if (
              outcome.status === "rejected" &&
              outcome.reason !== childFailure
            )
              suppressedPostWork.push(outcome.reason);
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
