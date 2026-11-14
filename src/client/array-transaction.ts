/**
 * The one executor of `$transaction([...])`. Every application runs it: one
 * transaction on a transaction driver, one native batch on a batch driver.
 * A chain whose parts intercept calls admits the members through its
 * coordination's `admit` hook (`@extensions/array-admission`), read from
 * the chain's state, so an application without one carries none of it.
 */

import { attachCommitCertainty } from "@drivers/driver-error-context";
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
import {
  InvalidTransactionInputError,
  isVibORMError,
  PendingOperationError,
  TransactionError,
} from "@errors";
import {
  type ArrayCertainty,
  type Coordination,
  railOf,
} from "@extensions/coordination";
import type {
  TransactionWriteOutcomes,
  WriteOutcome,
  WriteOutcomeNotifications,
} from "@extensions/query";
import { attributeOperationBatchError } from "@query-engine/batch-error-attribution";
import type { QueryEngine } from "@query-engine/query-engine";
import {
  readTransactionOperation,
  type TransactionOperationCapability,
  type TransactionOperationOwner,
  transactionOperationOwner,
} from "@query-engine/transaction-operation";
import type { PreparedBatchGuard } from "@query-engine/types";

type ArrayOptions = TransactionOptions | BatchTransactionOptions | undefined;

/** Each member's parser over the batch's results. */
type BatchParser = (batchResults: QueryResult<unknown>[]) => Promise<unknown>;

/**
 * Execute one root or nested array transaction. Without an observer, every
 * member's request work (control admission included) settles before any
 * provider effect; an observer runs it inside each member's unit instead.
 */
export function executeArrayTransaction(
  candidates: readonly unknown[],
  engine: QueryEngine,
  options: ArrayOptions,
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
    const snapshot = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      snapshot[index] = candidates[index];
    }
    operations = snapshot;
  } catch (error) {
    snapshotFailure = error;
  }
  const run = (batch?: ArrayCertainty): Promise<unknown[]> => {
    if (operations === undefined) throw snapshotFailure;
    assertOwnedOperations(operations, engine);
    if (operations.length === 0) return Promise.resolve(operations);
    if (batch === undefined)
      for (const phase of ["input", "plan"] as const)
        for (const operation of operations)
          transactionOperationOwner(operation).prepareAdmission(
            operation,
            phase
          );
    return executeMembers(operations, engine, options, context, batch);
  };
  const observation = engine.extensionChain?.observation;
  if (observation === undefined)
    return finishArrayResults(operations, engine, run);
  const batch: ArrayCertainty = {};
  return finishArrayResults(operations, engine, () =>
    observation.run(
      {
        kind: "batch",
        operation: "$transaction([...])",
        context,
        certainty: () => batch.certainty,
      },
      () => run(batch)
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
  operations: readonly unknown[] | undefined,
  engine: QueryEngine,
  run: () => Promise<unknown[]>
): Promise<unknown[]> {
  const chain = engine.extensionChain;
  if (chain?.result === undefined && chain?.written === undefined) return run();
  const members = [...(operations ?? [])] as object[];
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
 * The members sent as one transaction, or one native batch. On a chain that
 * may intercept them (its `admit` hook), or whose units observe a native
 * batch's members, each member gets a slot first: its unit entered, its
 * arguments admitted and its handlers started, all before anything is sent.
 */
function executeMembers(
  operations: TransactionOperationCapability[],
  engine: QueryEngine,
  options: ArrayOptions,
  context: QueryExecutionContext,
  batch: ArrayCertainty | undefined
): Promise<unknown[]> {
  const { driver } = engine;
  const native = !driver.supportsTransactions && driver.supportsBatch;
  if (!native) assertAtomicArraySupport(driver);
  const chain = engine.extensionChain;
  const coordination = chain?.coordination;
  // Observed members go through slots, but on a transaction driver only
  // where a part may intercept them; else each member's unit runs around
  // its own work, in order. Unobserved members, prepared already, only
  // where one is intercepted.
  return coordination &&
    (chain?.observation
      ? native || coordination.admit
      : coordination.intercepts?.(operations))
    ? executeSlots(
        operations,
        engine,
        options,
        context,
        batch,
        coordination,
        native
      )
    : native
      ? sendNativeBatch(operations, driver, options, context)
      : sendTransaction(operations, engine, options, context, batch);
}

/** One member of an observed or intercepted array. */
export interface ArraySlot {
  readonly operation: TransactionOperationCapability;
  readonly owner: TransactionOperationOwner<TransactionOperationCapability>;
  /** The core's result, which the member's handlers resume with. */
  readonly child: ArrayDeferred<unknown>;
  /** The member's handlers: its value as its caller receives it. */
  query?: Promise<unknown>;
  notifications?: WriteOutcomeNotifications;
  certainty?: WriteOutcome["certainty"];
  admitted?: boolean;
  admissionFailures?: unknown[];
}

async function executeSlots(
  operations: TransactionOperationCapability[],
  engine: QueryEngine,
  options: ArrayOptions,
  context: QueryExecutionContext,
  batch: ArrayCertainty | undefined,
  coordination: Coordination,
  native: boolean
): Promise<unknown[]> {
  const { driver } = engine;
  const outcomes = railOf(engine.extensionChain)?.outcomes();
  const slots = operations.map(
    (operation): ArraySlot => ({
      operation,
      owner: transactionOperationOwner(operation),
      child: createArrayDeferred(),
    })
  );
  // Each member's unit starts before any member is prepared, and the array
  // waits until every unit reached its child: a handler that waits first
  // (for a tracer to load) does so before the array's work, which then runs
  // inside each member's unit, until its handlers settled.
  const units = await engine.extensionChain?.observation?.members(
    slots.map((slot) => [
      { ...slot.owner.unit(slot.operation), certainty: () => slot.certainty },
      () =>
        slot.child.promise.then(nothing, nothing).then(() => memberValue(slot)),
    ])
  );
  try {
    for (const slot of slots) slot.owner.reserveWith(slot.operation, driver);
    for (const phase of ["input", "plan"] as const)
      for (const slot of slots)
        await slot.owner.observeBatchPhase(slot.operation, driver, () =>
          slot.owner.prepareAdmission(slot.operation, phase)
        );
  } catch (error) {
    for (const slot of slots) slot.child.reject(error);
    throw error;
  }
  const failures = await coordination.admit?.(slots, outcomes);
  if (failures !== undefined)
    throw combineArrayFailures(failures[0], failures.slice(1));
  let values: unknown[];
  try {
    values = await (native
      ? sendNativeBatch(
          operations,
          driver,
          options,
          context,
          slots,
          outcomes,
          batch
        )
      : sendTransaction(
          operations,
          engine,
          options,
          context,
          batch,
          slots,
          outcomes
        ));
  } catch (failure) {
    // A transaction that failed before a member ran still lets that
    // member's handlers and unit end.
    for (const slot of slots) slot.child.reject(failure);
    throw failure;
  }
  // What a member's unit handler threw, once its child succeeded, fails the
  // array: the host contains nothing a handler does.
  await units?.done;
  return values;
}

/** The members in order inside one transaction, or a savepoint. */
function sendTransaction(
  operations: TransactionOperationCapability[],
  engine: QueryEngine,
  options: ArrayOptions,
  context: QueryExecutionContext,
  batch: ArrayCertainty | undefined,
  slots?: ArraySlot[],
  outcomes?: TransactionWriteOutcomes
): Promise<unknown[]> {
  const results: unknown[] = operations;
  const body = async (transactionDriver: AnyDriver): Promise<unknown[]> => {
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]!;
      const slot = slots?.[index];
      if (slot === undefined) {
        results[index] = await transactionOperationOwner(operation).executeWith(
          operation,
          transactionDriver
        );
        continue;
      }
      // The reserved execution turns what its core throws into a rejection.
      slot.owner
        .executeCore(operation, transactionDriver, slot.notifications)
        .then(slot.child.resolve, slot.child.reject);
      try {
        results[index] = await memberValue(slot);
      } catch (failure) {
        // The members after a failed one never run: their handlers resume
        // with its failure before the rollback, which fails with it.
        await settleSlots(slots!.slice(index + 1), [failure]);
      }
    }
    return results;
  };
  const rail = railOf(engine.extensionChain);
  // A chain with the write rail collects the array's write outcomes and
  // reports its commit certainty to the `batch` unit.
  return rail
    ? rail.runTransaction(
        engine.driver,
        outcomes ?? rail.outcomes(),
        engine.transactionWriteOutcomes,
        options as TransactionOptions | undefined,
        context,
        body,
        batch &&
          ((certainty) => {
            batch.certainty = certainty;
          })
      )
    : engine.driver.withTransaction(
        body,
        options as TransactionOptions | undefined,
        context
      );
}

/** The members prepared in order and sent as one native batch. */
async function sendNativeBatch(
  operations: TransactionOperationCapability[],
  driver: AnyDriver,
  options: ArrayOptions,
  context: QueryExecutionContext,
  slots?: ArraySlot[],
  outcomes?: TransactionWriteOutcomes,
  batch?: ArrayCertainty
): Promise<unknown[]> {
  // Slots were reserved before they were admitted.
  if (slots === undefined)
    for (const operation of operations)
      transactionOperationOwner(operation).reserveWith(operation, driver);
  // What the sent batch reached, reported to every unit and published once,
  // and what publishing it failed with.
  let reached: WriteOutcome["certainty"] | undefined;
  const late: unknown[] = [];
  const publish = async (certainty: WriteOutcome["certainty"]) => {
    if (reached) return;
    reached = certainty;
    if (batch) batch.certainty = certainty;
    for (const slot of slots!) {
      slot.certainty = certainty;
      try {
        // Only a write's handlers are handed notifications.
        await slot.notifications?.[
          certainty === "committed" ? "committed" : "mayHaveCommitted"
        ]();
      } catch (error) {
        late.push(error);
      }
    }
    try {
      await outcomes?.publish(certainty);
    } catch (error) {
      late.push(error);
    }
  };
  // The failure to throw: every slot settled, it rejects with the folded one.
  const close = async (failure: unknown, sent?: true): Promise<unknown> => {
    if (slots === undefined) return failure;
    if (sent) await publish("may-have-committed");
    else outcomes?.discardAll();
    await settleSlots(
      slots,
      [reached ? markCommitCertainty(failure, reached) : failure],
      late
    );
  };
  let queries: BatchQuery[];
  let guards: PreparedBatchGuard[];
  let parsers: BatchParser[];
  try {
    ({ queries, guards, parsers } = await prepareNativeBatch(
      operations,
      driver
    ));
  } catch (error) {
    throw await close(error);
  }
  let batchResults: QueryResult<unknown>[];
  try {
    batchResults = await executeNativeBatch(
      driver,
      queries,
      guards,
      options,
      context,
      slots && driver.supportsOrderedCommittedSegments
        ? () => publish("committed")
        : undefined
    );
    if (slots) await publish("committed");
    assertNativeBatchResults(driver, batchResults, queries.length);
  } catch (error) {
    throw await close(error, true);
  }
  const results: unknown[] = operations;
  for (let index = 0; index < parsers.length; index += 1) {
    const slot = slots?.[index];
    if (slot === undefined)
      results[index] = await parsers[index]!(batchResults);
    else
      try {
        slot.child.resolve(await parsers[index]!(batchResults));
      } catch (error) {
        slot.child.reject(markCommitCertainty(error, "committed"));
      }
  }
  if (slots)
    await settleSlots(
      slots,
      [],
      late.map((error) => markCommitCertainty(error, "committed")),
      results
    );
  return results;
}

const nothing = (): undefined => undefined;

/** The member's value as its handlers return it, or its core's before they start. */
export function memberValue(
  slot: Pick<ArraySlot, "query" | "child">
): Promise<unknown> {
  return slot.query ?? slot.child.promise;
}

/**
 * Wait for every member's handlers, each child still unsettled rejected
 * with the first of `failures`, their values written into `values`; then
 * fail with the first failure, the distinct others and `extra` folded in.
 */
export async function settleSlots(
  slots: readonly ArraySlot[],
  failures: unknown[],
  extra: readonly unknown[] = [],
  values: unknown[] = []
): Promise<void> {
  for (const slot of slots) slot.child.reject(failures[0]);
  for (const [index, settled] of (
    await Promise.allSettled(slots.map(memberValue))
  ).entries())
    if (settled.status === "fulfilled") values[index] = settled.value;
    else failures.push(settled.reason);
  failures.push(...extra);
  if (failures.length > 0)
    throw combineArrayFailures(failures[0], failures.slice(1));
}

/** The primary failure, with the distinct ones that settled beside it. */
export function combineArrayFailures(
  primary: unknown,
  suppressed: readonly unknown[]
): unknown {
  const distinct = suppressed.filter((failure) => failure !== primary);
  if (distinct.length === 0) return primary;
  return new AggregateError(
    [primary, ...distinct],
    "Array transaction and operation post-work both failed.",
    { cause: primary }
  );
}

/** An error of viborm's own marked with the array's commit certainty. */
function markCommitCertainty(
  error: unknown,
  certainty: WriteOutcome["certainty"]
): unknown {
  return isVibORMError(error) ? attachCommitCertainty(error, certainty) : error;
}

export interface ArrayDeferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
}

/** A promise settled from outside; the first settlement holds. */
export function createArrayDeferred<Value>(): ArrayDeferred<Value> {
  // Promise executors run synchronously; TypeScript does not model that guarantee.
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  promise.catch(nothing);
  return { promise, resolve, reject };
}

/** Prepare members in order into one native batch with per-member parsers. */
export async function prepareNativeBatch(
  operations: readonly TransactionOperationCapability[],
  driver: AnyDriver
): Promise<{
  readonly queries: BatchQuery[];
  readonly guards: PreparedBatchGuard[];
  readonly parsers: BatchParser[];
}> {
  const queries: BatchQuery[] = [];
  const guards: PreparedBatchGuard[] = [];
  const parsers: BatchParser[] = [];
  for (const operation of operations) {
    const owner = transactionOperationOwner(operation);
    const preparation = await owner.observeBatchPhase(
      operation,
      driver,
      async () => {
        const prepared = owner.prepare(operation, driver);
        if (prepared) return { prepared };
        return { preparedBatch: await owner.prepareBatch(operation) };
      }
    );
    const start = queries.length;
    if (preparation.prepared) {
      queries.push(preparation.prepared);
      parsers.push((batchResults) =>
        owner.observeBatchPhase(operation, driver, () => {
          const result = batchResults[start];
          if (!result)
            throw arrayError(
              driver,
              `omitted the result for operation "${owner.operation(operation)}"`,
              { operation: owner.operation(operation) }
            );
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
  options: ArrayOptions,
  context: QueryExecutionContext,
  committed?: () => Promise<void>
): Promise<QueryResult<unknown>[]> {
  // The driver answers an empty batch itself, without sending it.
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
  throw arrayError(
    driver,
    "supports neither transactions nor atomic batch execution"
  );
}

export function unbatchableArrayError(driver: AnyDriver): TransactionError {
  return arrayError(
    driver,
    "does not support callback transactions and this transaction contains operations that cannot be batched atomically"
  );
}

function arrayError(
  driver: AnyDriver,
  problem: string,
  meta: Record<string, unknown> = { method: "$transaction([...])" }
): TransactionError {
  return new TransactionError(`Driver "${driver.driverName}" ${problem}.`, {
    meta: { driver: driver.driverName, ...meta },
  });
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
