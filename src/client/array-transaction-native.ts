import type {
  AnyDriver,
  QueryExecutionContext,
  QueryResult,
} from "@drivers/exports";
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
import {
  combineArrayFailures,
  markArrayCommitCertainty,
} from "./array-transaction-failures";
import {
  assertNativeBatchResults,
  executeNativeBatch,
  type PreparedNativeBatch,
  prepareNativeBatch,
} from "./array-transaction-native-batch";

export interface NativeArraySlot extends ArrayAdmissionSlot {
  readonly operation: TransactionOperationCapability;
  readonly owner: TransactionOperationOwner<TransactionOperationCapability>;
}

export async function executeInterceptedNativeArray(
  slots: readonly NativeArraySlot[],
  outcomes: TransactionWriteOutcomes,
  driver: AnyDriver,
  options: TransactionOptions | BatchTransactionOptions | undefined,
  context: QueryExecutionContext,
  reportCertainty?: (certainty: WriteOutcome["certainty"]) => void
): Promise<unknown[]> {
  let batch: PreparedNativeBatch;
  try {
    batch = await prepareNativeBatch(slots, driver);
  } catch (error) {
    outcomes.discardAll();
    throw await rejectAndCombine(slots, error);
  }
  const { queries, guards, parsers } = batch;

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
      queries,
      guards,
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
    assertNativeBatchResults(driver, batchResults, queries.length);
  } catch (error) {
    throw await closeCommittedFailure(slots, error, commitFailures);
  }

  const results: unknown[] = new Array(slots.length);
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index]!;
    try {
      slot.child.resolve(await parsers[index]!(batchResults));
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
  return rejectAndCombine(slots, primary, commitFailures);
}

async function closeCommittedFailure(
  slots: readonly NativeArraySlot[],
  failure: unknown,
  commitFailures: readonly unknown[]
): Promise<unknown> {
  for (const slot of slots) slot.certainty = "committed";
  return rejectAndCombine(
    slots,
    markArrayCommitCertainty(failure, "committed"),
    commitFailures
  );
}

/** Reject every child with the primary failure and fold in what settled. */
async function rejectAndCombine(
  slots: readonly NativeArraySlot[],
  primary: unknown,
  extra: readonly unknown[] = []
): Promise<unknown> {
  for (const slot of slots) slot.child.reject(primary);
  const suppressed: unknown[] = [];
  for (const outcome of await Promise.allSettled(slots.map(readArrayQuery))) {
    if (outcome.status === "rejected") {
      suppressed.push(...queryFailureParts(outcome.reason));
    }
  }
  return combineArrayFailures(primary, [...suppressed, ...extra]);
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
