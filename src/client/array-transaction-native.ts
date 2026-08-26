import type {
  AnyDriver,
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import type {
  BatchTransactionOptions,
  TransactionOptions,
} from "@drivers/shared/transaction-options";
import {
  type ArrayAdmissionSlot,
  readArrayQuery,
} from "@extensions/array-admission";
import type { TransactionWriteOutcomes, WriteOutcome } from "@extensions/query";
import {
  decomposeQueryCoordinationFailure,
  decomposeWriteOutcomePublicationFailure,
} from "@extensions/query";
import type {
  TransactionOperationCapability,
  TransactionOperationOwner,
} from "@query-engine/transaction-operation";
import type { PreparedBatchGuard } from "@query-engine/types";
import {
  combineArrayFailures,
  markArrayCommitCertainty,
} from "./array-transaction-failures";
import {
  assertNativeBatchResults,
  executeNativeBatch,
  missingOperationResult,
  unbatchableArrayError,
} from "./array-transaction-native-batch";

export interface NativeArraySlot extends ArrayAdmissionSlot {
  readonly operation: TransactionOperationCapability;
  readonly owner: TransactionOperationOwner<TransactionOperationCapability>;
}

interface NativeMember {
  parse(batchResults: QueryResult<unknown>[]): Promise<unknown>;
}

export async function executeInterceptedNativeArray(
  slots: readonly NativeArraySlot[],
  outcomes: TransactionWriteOutcomes,
  driver: AnyDriver,
  options: TransactionOptions | BatchTransactionOptions | undefined,
  context: QueryExecutionContext,
  reportCertainty?: (certainty: WriteOutcome["certainty"]) => void
): Promise<unknown[]> {
  const operationQueries: BatchQuery[] = [];
  const batchGuards: PreparedBatchGuard[] = [];
  const members: NativeMember[] = [];
  try {
    for (const slot of slots) {
      const preparation = await slot.owner.observeBatchPhase(
        slot.operation,
        driver,
        async () => {
          const prepared = slot.owner.prepare(slot.operation, driver);
          if (prepared) return { kind: "single" as const, prepared };
          return {
            kind: "batch" as const,
            preparedBatch: await slot.owner.prepareBatch(
              slot.operation,
              driver
            ),
          };
        }
      );
      if (preparation.kind === "single") {
        const start = operationQueries.length;
        operationQueries.push(preparation.prepared);
        members.push({
          parse: (batchResults) =>
            slot.owner.observeBatchPhase(slot.operation, driver, () => {
              const result = batchResults[start];
              if (!result)
                throw missingOperationResult(
                  driver,
                  slot.operation,
                  slot.owner
                );
              return slot.owner.parseResult(slot.operation, result);
            }),
        });
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
      members.push({
        parse: (batchResults) =>
          slot.owner.observeBatchPhase(slot.operation, driver, () =>
            preparedBatch.parseResult(batchResults.slice(start, start + length))
          ),
      });
    }
  } catch (error) {
    throw await closePreDispatchFailure(slots, outcomes, error);
  }

  let committed = false;
  const commitFailures: unknown[] = [];
  const confirmCommit = async (): Promise<void> => {
    if (committed) return;
    committed = true;
    reportCertainty?.("committed");
    for (const slot of slots) slot.certainty = "committed";
    commitFailures.push(
      ...(await publishNativeOutcome(slots, outcomes, "committed"))
    );
  };

  let batchResults: QueryResult<unknown>[];
  try {
    batchResults = await executeNativeBatch(
      driver,
      operationQueries,
      batchGuards,
      options,
      context,
      driver.supportsOrderedCommittedSegments ? confirmCommit : undefined
    );
  } catch (error) {
    if (committed) {
      throw await closeCommittedFailure(slots, error, commitFailures);
    }
    reportCertainty?.("may-have-committed");
    throw await closeDispatchedFailure(slots, outcomes, error);
  }
  await confirmCommit();
  try {
    assertNativeBatchResults(driver, batchResults, operationQueries.length);
  } catch (error) {
    throw await closeCommittedFailure(slots, error, commitFailures);
  }

  const results: unknown[] = new Array(slots.length);
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index]!;
    try {
      slot.child.resolve(await members[index]!.parse(batchResults));
    } catch (error) {
      slot.child.reject(markArrayCommitCertainty(error, "committed"));
    }
  }
  const queryOutcomes = await Promise.allSettled(slots.map(readArrayQuery));
  const queryFailures: unknown[] = [];
  for (let index = 0; index < queryOutcomes.length; index += 1) {
    const outcome = queryOutcomes[index]!;
    if (outcome.status === "fulfilled") results[index] = outcome.value;
    else {
      for (const failure of queryFailureParts(outcome.reason)) {
        queryFailures.push(failure);
      }
    }
  }
  const failures = [
    ...queryFailures,
    ...commitFailures.map((failure) =>
      markArrayCommitCertainty(failure, "committed")
    ),
  ];
  if (failures.length > 0) {
    throw combineArrayFailures(failures[0], failures.slice(1));
  }
  return results;
}

async function closePreDispatchFailure(
  slots: readonly NativeArraySlot[],
  outcomes: TransactionWriteOutcomes,
  failure: unknown
): Promise<unknown> {
  outcomes.discardAll();
  for (const slot of slots) slot.child.reject(failure);
  const settled = await Promise.allSettled(slots.map(readArrayQuery));
  const suppressed: unknown[] = [];
  for (const outcome of settled) {
    if (outcome.status !== "rejected") continue;
    for (const queryFailure of queryFailureParts(outcome.reason)) {
      if (queryFailure !== failure) suppressed.push(queryFailure);
    }
  }
  return combineArrayFailures(failure, suppressed);
}

async function closeDispatchedFailure(
  slots: readonly NativeArraySlot[],
  outcomes: TransactionWriteOutcomes,
  failure: unknown
): Promise<unknown> {
  const primary = markArrayCommitCertainty(failure, "may-have-committed");
  for (const slot of slots) slot.certainty = "may-have-committed";
  const commitFailures = await publishNativeOutcome(
    slots,
    outcomes,
    "may-have-committed"
  );
  for (const slot of slots) slot.child.reject(primary);
  const settled = await Promise.allSettled(slots.map(readArrayQuery));
  const suppressed: unknown[] = [];
  for (const outcome of settled) {
    if (outcome.status !== "rejected") continue;
    for (const queryFailure of queryFailureParts(outcome.reason)) {
      if (queryFailure !== primary) suppressed.push(queryFailure);
    }
  }
  for (const commitFailure of commitFailures) {
    suppressed.push(commitFailure);
  }
  return combineArrayFailures(primary, suppressed);
}

async function closeCommittedFailure(
  slots: readonly NativeArraySlot[],
  failure: unknown,
  commitFailures: readonly unknown[]
): Promise<unknown> {
  const primary = markArrayCommitCertainty(failure, "committed");
  for (const slot of slots) {
    slot.certainty = "committed";
    slot.child.reject(primary);
  }
  const failures: unknown[] = [];
  const settled = await Promise.allSettled(slots.map(readArrayQuery));
  for (const outcome of settled) {
    if (outcome.status !== "rejected") continue;
    for (const queryFailure of queryFailureParts(outcome.reason)) {
      if (queryFailure !== primary) failures.push(queryFailure);
    }
  }
  for (const commitFailure of commitFailures) {
    failures.push(commitFailure);
  }
  return combineArrayFailures(primary, failures);
}

async function publishNativeOutcome(
  slots: readonly NativeArraySlot[],
  outcomes: TransactionWriteOutcomes,
  certainty: WriteOutcome["certainty"]
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const slot of slots) {
    if (!slot.owner.isWrite(slot.operation)) {
      continue;
    }
    try {
      if (certainty === "committed") {
        await slot.notifications?.committed();
      } else {
        await slot.notifications?.mayHaveCommitted();
      }
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await outcomes.publish(certainty);
  } catch (error) {
    for (const failure of decomposeWriteOutcomePublicationFailure(error)) {
      failures.push(failure);
    }
  }
  return failures;
}

function queryFailureParts(failure: unknown): readonly unknown[] {
  const coordination = decomposeQueryCoordinationFailure(failure);
  if (coordination === undefined) return [failure];
  return [coordination.child, ...coordination.postWork];
}
