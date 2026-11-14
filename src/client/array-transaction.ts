import type { QueryExecutionContext } from "@drivers/exports";
import type {
  BatchTransactionOptions,
  TransactionOptions,
} from "@drivers/shared/transaction-options";
import { InvalidTransactionInputError, PendingOperationError } from "@errors";
import { extensionHost, runProtectedObservers } from "@extensions/host-slot";
import type { QueryEngine } from "@query-engine/query-engine";
import {
  readTransactionOperation,
  type TransactionOperationCapability,
  transactionOperationOwner,
} from "@query-engine/transaction-operation";
import type { ArrayObservationState } from "./array-transaction-intercepted";
import { executeLegacyArrayTransaction } from "./array-transaction-legacy";

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
    return finishArrayResults(operations, engine, () =>
      canRequireInterceptedArray(engine) && requiresInterceptedArray(operations)
        ? extensionHost().executeInterceptedArray(
            operations,
            engine,
            options,
            context
          )
        : executeLegacyArrayTransaction(operations, engine, options, context)
    );
  }
  const observation: ArrayObservationState = {};
  return finishArrayResults(operations, engine, () =>
    runProtectedObservers(
      { kind: "batch", operation: "$transaction([...])" },
      observers,
      () => {
        assertOwnedOperations(operations, engine);
        if (operations.length === 0) return Promise.resolve(operations);
        return canRequireInterceptedArray(engine) &&
          requiresInterceptedArray(operations)
          ? extensionHost().executeInterceptedArray(
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
    )
  );
}

/**
 * Each member's value as its caller receives it: a chain that computes
 * result fields or watches writes finishes every member once the array has
 * settled.
 * The members are read before the run, which writes its values over them.
 */
function finishArrayResults(
  operations: readonly unknown[],
  engine: QueryEngine,
  run: () => Promise<unknown[]>
): Promise<unknown[]> {
  const chain = engine.extensionChain;
  if (chain?.result === undefined && chain?.written === undefined) return run();
  const members = [...operations] as object[];
  return run().then(async (values) => {
    // One member at a time: a member's write hooks run in member order, and
    // one failing does not keep the next from running.
    const failures: unknown[] = [];
    for (const [index, operation] of members.entries()) {
      const owner = transactionOperationOwner(operation);
      try {
        if (owner.finishResult)
          values[index] = await owner.finishResult(operation, values[index]);
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Several array members failed after commit.",
        {
          cause: failures[0],
        }
      );
    return values;
  });
}

/**
 * Settle synchronous request work, control admission included, for every
 * member before any provider effect.
 */
function prepareRequestAdmissions(
  operations: readonly TransactionOperationCapability[],
  _engine: QueryEngine
): void {
  for (const operation of operations) {
    transactionOperationOwner(operation).prepareAdmission(operation);
  }
  for (const operation of operations) {
    transactionOperationOwner(operation).prepareAdmission(operation, "plan");
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
    (chain.hasRequestHandlers ||
      chain.hasQueryHandlers ||
      chain.hasCache ||
      chain.written !== undefined)
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
