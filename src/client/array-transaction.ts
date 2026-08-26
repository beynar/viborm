import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { attachCommitCertainty } from "@drivers/driver-error-context";
import { bindExecutionTransactionPhases } from "@drivers/execution-context";
import type {
  BatchTransactionOptions,
  TransactionOptions,
} from "@drivers/shared/transaction-options";
import {
  InvalidTransactionInputError,
  isVibORMError,
  PendingOperationError,
} from "@errors";
import {
  admitArrayQueries,
  createArrayDeferred,
  readArrayQuery,
} from "@extensions/array-admission";
import {
  prewarmProtectedObservers,
  runProtectedObservers,
} from "@extensions/observation";
import {
  decomposeQueryCoordinationFailure,
  retainWriteOutcomeFailure,
  TransactionWriteOutcomes,
} from "@extensions/query";
import type { QueryEngine } from "@query-engine/query-engine";
import {
  readTransactionOperation,
  type TransactionOperationCapability,
  transactionOperationOwner,
} from "@query-engine/transaction-operation";
import { combineArrayFailures } from "./array-transaction-failures";
import { executeLegacyArrayTransaction } from "./array-transaction-legacy";
import {
  executeInterceptedNativeArray,
  type NativeArraySlot,
} from "./array-transaction-native";
import { assertAtomicArraySupport } from "./array-transaction-native-batch";

type ArraySlot = NativeArraySlot;

interface ArrayObservationState {
  certainty?: "committed" | "may-have-committed";
}

/**
 * Execute one root or nested array transaction. The first arm is the extracted
 * legacy path: synchronous request preparation settles for the complete array
 * before selection; when no member then needs query or write-outcome
 * coordination, execution allocates no slot, deferred result, outcome
 * collector, or admission callback.
 */
export function executeArrayTransaction(
  candidates: readonly unknown[],
  engine: QueryEngine,
  options: TransactionOptions | BatchTransactionOptions | undefined,
  context: QueryExecutionContext
): Promise<unknown[]> {
  let operations: unknown[] | undefined;
  let snapshotFailure: unknown;
  try {
    const length = candidates.length;
    if (
      typeof length !== "number" ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > 0xff_ff_ff_ff
    ) {
      throw new InvalidTransactionInputError();
    }
    operations = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      operations[index] = candidates[index];
    }
  } catch (error) {
    operations = undefined;
    snapshotFailure = error;
  }

  const observers = engine.extensionChain?.observe;
  if (operations === undefined) {
    if (observers === undefined || observers.length === 0) {
      throw snapshotFailure;
    }
    return runProtectedObservers(
      { kind: "batch", operation: "$transaction([...])" },
      observers,
      () => {
        throw snapshotFailure;
      }
    );
  }
  if (observers === undefined || observers.length === 0) {
    assertOwnedOperations(operations, engine);
    if (operations.length === 0) return Promise.resolve(operations);
    prepareRequestAdmissions(operations, engine);
    return canRequireInterceptedArray(engine) &&
      requiresInterceptedArray(operations)
      ? executeInterceptedArray(operations, engine, options, context)
      : executeLegacyArrayTransaction(operations, engine, options, context);
  }
  const observation: ArrayObservationState = {};
  return runProtectedObservers(
    { kind: "batch", operation: "$transaction([...])" },
    observers,
    () => {
      assertOwnedOperations(operations, engine);
      if (operations.length === 0) return Promise.resolve(operations);
      return canRequireInterceptedArray(engine) &&
        requiresInterceptedArray(operations)
        ? executeInterceptedArray(
            operations,
            engine,
            options,
            context,
            observation
          )
        : executeLegacyArrayTransaction(
            operations,
            engine,
            options,
            context,
            true,
            (certainty) => {
              observation.certainty = certainty;
            }
          );
    },
    () =>
      observation.certainty === undefined
        ? undefined
        : { commitCertainty: observation.certainty }
  );
}

/** Settle synchronous request work for every member before any provider effect. */
function prepareRequestAdmissions(
  operations: readonly TransactionOperationCapability[],
  engine: QueryEngine
): void {
  if (engine.extensionChain?.hasRequestHandlers !== true) return;
  for (const operation of operations) {
    transactionOperationOwner(operation).prepareAdmission(operation);
  }
}

function requiresInterceptedArray(
  operations: readonly TransactionOperationCapability[]
): boolean {
  for (const operation of operations) {
    const owner = transactionOperationOwner(operation);
    if (owner.requiresInterception(operation)) return true;
  }
  return false;
}

function canRequireInterceptedArray(engine: QueryEngine): boolean {
  const chain = engine.extensionChain;
  return (
    chain !== undefined &&
    (chain.hasRequestHandlers || chain.hasQueryHandlers || chain.hasCache)
  );
}

function assertOwnedOperations(
  candidates: unknown[],
  engine: QueryEngine
): asserts candidates is TransactionOperationCapability[] {
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") {
      throw new InvalidTransactionInputError();
    }
    const owner = readTransactionOperation(candidate);
    if (owner === undefined) throw new InvalidTransactionInputError();
    if (owner.clientId(candidate) !== engine.clientId) {
      throw PendingOperationError.clientMismatch(
        owner.model(candidate),
        owner.operation(candidate)
      );
    }
    if (owner.scopeId(candidate) !== engine.scopeId) {
      throw PendingOperationError.scopeMismatch(
        owner.model(candidate),
        owner.operation(candidate)
      );
    }
  }
}

async function executeInterceptedArray(
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
  const outcomes = new TransactionWriteOutcomes();
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
    child: createArrayDeferred<unknown>(),
  };
}

function startArrayOperationObservers(
  slots: readonly ArraySlot[],
  engine: QueryEngine
): void {
  const observers = engine.extensionChain?.observe;
  if (observers === undefined || observers.length === 0) return;
  for (const slot of slots) {
    const observation = createArrayDeferred<unknown>();
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

async function executeInterceptedFallback(
  slots: readonly ArraySlot[],
  outcomes: TransactionWriteOutcomes,
  engine: QueryEngine,
  options: TransactionOptions | BatchTransactionOptions | undefined,
  context: QueryExecutionContext,
  observation: ArrayObservationState | undefined
): Promise<unknown[]> {
  const parentOutcomes = engine.transactionWriteOutcomes;
  const transactionState: {
    phase: "pending" | "ready" | "committed";
  } = { phase: "pending" };
  const transactionContext = parentOutcomes
    ? context
    : bindExecutionTransactionPhases(context ?? {}, {
        readyToCommit: () => {
          transactionState.phase = "ready";
        },
        committed: () => {
          transactionState.phase = "committed";
        },
      });
  const suppressedPostWork: unknown[] = [];
  let results: unknown[];
  try {
    results = await engine.driver.withTransaction(
      async (transactionDriver) => {
        const values: unknown[] = [];
        for (let index = 0; index < slots.length; index += 1) {
          const slot = slots[index]!;
          startFallbackCore(slot, transactionDriver);
          try {
            values.push(await readArrayQuery(slot));
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
              slots.slice(index + 1).map(readArrayQuery)
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
      options as TransactionOptions | undefined,
      transactionContext
    );
  } catch (error) {
    const coordinatedFailure = combineArrayFailures(error, suppressedPostWork);
    const certainty =
      parentOutcomes === undefined && transactionState.phase === "committed"
        ? "committed"
        : parentOutcomes === undefined && transactionState.phase === "ready"
          ? "may-have-committed"
          : undefined;
    if (certainty) {
      if (observation) observation.certainty = certainty;
      const primary = isVibORMError(coordinatedFailure)
        ? attachCommitCertainty(coordinatedFailure, certainty)
        : coordinatedFailure;
      try {
        await outcomes.publish(certainty);
      } catch (outcomeFailure) {
        throw retainWriteOutcomeFailure(primary, outcomeFailure);
      }
      throw primary;
    }
    outcomes.discardAll();
    throw coordinatedFailure;
  }

  if (parentOutcomes) outcomes.promoteTo(parentOutcomes);
  else {
    if (observation) observation.certainty = "committed";
    await outcomes.publishCommitted();
  }
  return results;
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
