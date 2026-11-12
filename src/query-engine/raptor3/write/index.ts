/**
 * The new write path's entry: one call, sent by itself, inside the
 * transaction its caller lends it, or handed over as one unit.
 */
import type { AnyDriver } from "@drivers";
import { attachCommitCertainty } from "@drivers/driver-error-context";
import { bindExecutionTransactionPhases } from "@drivers/execution-context";
import {
  attachRecordSeriesProgress,
  isVibORMError,
  TransactionError,
  UniqueConstraintError,
} from "@errors";
import type { AnyModel } from "@schema/model";
import { sql } from "@sql";
import type { PreparedBatchOperation } from "../../types";
import type { Arguments, Input } from "../shared/schema";
import type {
  ExecutionBinding,
  SqlOperationContext,
} from "../shared/sql-operation-context";
import {
  batches,
  contextOf,
  dialogue,
  prepared,
  type Transport,
  unproven,
  unsaid,
} from "./send";
import { Lost, SEVERAL, Store } from "./store";
import { verbs } from "./verbs";

/** The verbs of one call, run on a store. */
const call =
  (
    store: Store,
    model: AnyModel,
    args: Arguments,
    raw: unknown
  ): (() => () => unknown) =>
  () => {
    const { operation } = store;
    const verb = verbs(store)[operation.operation as "create"];
    return verb(model, args, raw as Input);
  };

/** A call sent by itself, or inside the transaction its caller lends it; made again where its backend says a unit of its own that was undone is. */
export async function writeCall(
  operation: SqlOperationContext,
  driver: AnyDriver,
  model: AnyModel,
  args: Arguments,
  raw: unknown,
  binding?: ExecutionBinding
): Promise<unknown> {
  for (let attempt = 1; ; attempt++)
    try {
      return await sent(operation, driver, model, args, raw, binding);
    } catch (error) {
      if (
        binding?.kind === "borrowed-transaction" ||
        !(await operation.again(error, attempt))
      )
        throw error;
    }
}

async function sent(
  operation: SqlOperationContext,
  driver: AnyDriver,
  model: AnyModel,
  args: Arguments,
  raw: unknown,
  binding?: ExecutionBinding
): Promise<unknown> {
  const seam = binding?.writeOutcome;
  // The transaction says how far its commit went; the seam hears it once.
  let phase: "pending" | "ready" | "committed" = "pending";
  const at = contextOf(operation, model);
  const lent =
    binding?.kind === "borrowed-transaction"
      ? binding.operationRegion
      : undefined;
  /** The unit the call is sent in: one of its own, or the one its caller lends it. */
  const open = (): Transport => {
    if (binding?.kind === "borrowed-transaction")
      return dialogue(
        operation,
        binding.driver,
        lent && ((body) => lent(body, at)),
        binding.memberRollback
      );
    if (!driver.supportsTransactions) return batches(operation, driver);
    return dialogue(
      operation,
      driver,
      (body) =>
        driver.withTransaction(
          body,
          undefined,
          seam
            ? bindExecutionTransactionPhases(at, {
                readyToCommit: () => {
                  phase = "ready";
                },
                committed: () => {
                  phase = "committed";
                },
              })
            : at
        ),
      undefined,
      true
    );
  };
  let transport = open();
  let answer: unknown;
  let store = new Store(operation, transport);
  try {
    try {
      answer = await store.run(call(store, model, args, raw));
    } catch (error) {
      // A row created because none was there, refused because another writer made it meanwhile; a row read without holding it, gone since: where the unit that failed can be undone whole, the call is made again, once.
      const lost = error instanceof Lost;
      if (
        !(lost || store.raced(error)) ||
        store.segments > 0 ||
        (binding?.kind === "borrowed-transaction" && !lent)
      )
        throw lost ? error.failure : error;
      await transport.end(lost ? error.failure : error).catch(() => undefined);
      phase = "pending";
      transport = open();
      store = new Store(operation, transport);
      try {
        answer = await store.run(call(store, model, args, raw));
      } catch (again) {
        throw again instanceof Lost ? again.failure : again;
      }
    }
  } catch (error) {
    await transport.end(error);
    const loose = unproven.has(error as object);
    let failure = operation.failure(error);
    // What stands of a call that failed after a part of it was made is said with its failure; and so that its one unit may have been made.
    const made = store.segments > 0;
    if (
      (made ||
        (unsaid.has(error as object) &&
          !(error instanceof UniqueConstraintError))) &&
      !transport.holds
    )
      failure = attachRecordSeriesProgress(failure, {
        atomicity: "segment",
        phase: store.said ? "result" : "member",
        committedSegments: store.segments,
        // Of a unit that may have been made, nothing is known to be.
        completedMembers: made ? store.members(true) : 0,
        committedWriteMembers: made ? store.members() : 0,
        ...(loose && { mayHaveCommittedSegment: true as const }),
      });
    // What the call sent outside a transaction of its own and cannot prove undone may be there: a key already taken proves it.
    if (binding?.kind !== "borrowed-transaction")
      if (store.segments > 0)
        await operation.stateWriteOutcome(seam?.committedSegment, failure);
      else if (loose && !(error instanceof UniqueConstraintError))
        await operation.stateWriteOutcome(seam?.mayBeVisible, failure);
    throw failure;
  }
  store.watch?.done();
  try {
    await transport.end();
  } catch (error) {
    if (phase === "pending") throw error;
    const durable = phase === "committed";
    const primary = isVibORMError(error)
      ? attachCommitCertainty(
          error,
          durable ? "committed" : "may-have-committed"
        )
      : error;
    await operation.stateWriteOutcome(
      durable ? seam?.committedSegment : seam?.mayBeVisible,
      primary
    );
    throw primary;
  }
  await operation.stateWriteOutcome(seam?.committedSegment);
  return answer;
}

/**
 * A call as one unit its caller sends, among other calls' units: its
 * statements are handed over, each with what it reports where it stops the
 * unit. None where the call must hear the database to go on: what it would
 * read now, a call sent before it in the same unit may change.
 */
export async function prepareCall(
  operation: SqlOperationContext,
  driver: AnyDriver,
  model: AnyModel,
  args: Arguments,
  raw: unknown
): Promise<PreparedBatchOperation<unknown> | undefined> {
  const store = new Store(operation, {
    holds: false,
    // What the call may ask before its unit is asked outside it.
    send: (statements) =>
      Promise.all(
        statements.map((statement) =>
          driver._execute<Input>(
            statement.sql,
            contextOf(operation, statement.model)
          )
        )
      ),
    end: async () => undefined,
  });
  try {
    const { statements, answer } = await store.prepare(
      call(store, model, args, raw)
    );
    const guards = statements.flatMap((statement, queryIndex) =>
      statement.stops
        ? [
            {
              queryIndex,
              premise: statement.premise ?? ("exists" as const),
              // A statement that judges its own rows is pointed at by its place.
              probe: statement.premise
                ? statement.probe!
                : operation.driver.adapter.clauses.select(sql`1`),
              failure: statement.stops,
              model: statement.model["~"].names.ts!,
              operation: operation.operation,
            },
          ]
        : []
    );
    return {
      queries: statements.map((statement) =>
        prepared(operation, driver, statement)
      ),
      // A unit nothing can stop names no guard.
      ...(guards.length > 0 && { guards }),
      parseResult: (results) => {
        // A unit answered short is its driver's failure, said as such.
        for (let at = 0; at < statements.length; at++)
          if (!results[at])
            throw new TransactionError(
              `Driver '${driver.driverName}' omitted the prepared result for operation '${operation.operation}'.`,
              {
                meta: {
                  model: operation.modelName,
                  operation: operation.operation,
                },
              }
            );
        try {
          const value = answer(results as never);
          store.watch?.done();
          return value;
        } catch (error) {
          throw operation.failure(error);
        }
      },
    };
  } catch (error) {
    if (error !== SEVERAL) throw error;
    return undefined;
  }
}
