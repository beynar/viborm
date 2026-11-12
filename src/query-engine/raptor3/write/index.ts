/**
 * The new write path's entry: one call, sent by itself, inside the
 * transaction its caller lends it, or handed over as one unit.
 */
import type { AnyDriver } from "@drivers";
import { attachCommitCertainty } from "@drivers/driver-error-context";
import { bindExecutionTransactionPhases } from "@drivers/execution-context";
import { isVibORMError } from "@errors";
import type { AnyModel } from "@schema/model";
import { sql } from "@sql";
import type { PreparedBatchOperation } from "../../types";
import type { ExecutionBinding } from "../shared/operation-context";
import type { Arguments, Input } from "../shared/schema";
import type { SqlOperationContext } from "../shared/sql-operation-context";
import { batches, contextOf, dialogue, prepared, type Transport } from "./send";
import { outside } from "./statements";
import { SEVERAL, Store } from "./store";
import { verbs } from "./verbs";

export { OUTSIDE } from "./statements";

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
    if (!verb) outside();
    return verb(model, args, raw as Input);
  };

/** A call sent by itself, or inside the transaction its caller lends it. */
export async function writeCall(
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
  let transport: Transport;
  if (binding?.kind === "borrowed-transaction") {
    const lent = binding.operationRegion;
    transport = dialogue(
      operation,
      binding.driver,
      lent && ((body) => lent(body, at))
    );
  } else if (driver.supportsTransactions)
    transport = dialogue(operation, driver, (body) =>
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
      )
    );
  else transport = batches(operation, driver);
  let answer: unknown;
  try {
    const store = new Store(operation, transport);
    answer = await store.run(call(store, model, args, raw));
  } catch (error) {
    await transport.end(error);
    throw error;
  }
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
    send: () => Promise.reject(SEVERAL),
    end: async () => undefined,
  });
  try {
    const { statements, answer } = await store.prepare(
      call(store, model, args, raw)
    );
    return {
      queries: statements.map((statement) =>
        prepared(operation, driver, statement)
      ),
      guards: statements.flatMap((statement, queryIndex) =>
        statement.stops
          ? [
              {
                queryIndex,
                premise: statement.premise ?? "exists",
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
      ),
      parseResult: (results) => answer(results as never),
    };
  } catch (error) {
    if (error !== SEVERAL) throw error;
    return undefined;
  }
}
