/**
 * Unit F — substrate admission, before anything is parsed, scheduled or sent.
 *
 * Today's `routing.ts` (`assertRoutedAtomicResolution`) and the row-returning
 * bulk owner's constructor refuse, BEFORE the parse boundary, an operation
 * whose public result cannot be resolved atomically: on a batch-only driver
 * without an interactive transaction, on a dialect without `RETURNING`, the
 * result is parsed after the atomic unit commits and cannot be rolled back.
 * Single-row refetch operations (`update`, `delete`, `upsert`) are refused
 * outright; a bulk operation only when it asks for rows (`select`).
 *
 * The pattern engine's chain calls {@link refuseUnsupportedSubstrate} first —
 * before `parseValidated` — so an invalid payload on such a driver reports the
 * substrate refusal exactly as today; `execute` calls it again on the program
 * it is handed (a caller that skipped the chain still gets the refusal before
 * the first provider call).
 */
import type { AnyDriver } from "@drivers";
import { TransactionError } from "@errors";
import type { Program } from "../fragment";

/** The single-row refetch operations whose returned identity needs atomic resolution. */
const ATOMIC_RESOLUTION_OPERATIONS: ReadonlySet<string> = new Set([
  "update",
  "delete",
  "upsert",
]);

/** The bulk operations whose `select` arm returns the affected rows. */
const ROW_RETURNING_BULK_OPERATIONS: ReadonlySet<string> = new Set([
  "createMany",
  "updateMany",
]);

/** The driver facts admission reads. */
export type SubstrateFacts = Pick<
  AnyDriver,
  "driverName" | "supportsBatch" | "supportsTransactions" | "adapter"
>;

/**
 * Refuse, with today's exact class and text, an operation whose public result
 * this substrate cannot roll back. `hasPublicResult` is whether the payload
 * asks for rows (`select`) — the bulk operations' only refused form.
 */
export function refuseUnsupportedSubstrate(
  driver: SubstrateFacts,
  operation: string,
  hasPublicResult: boolean
): void {
  const batchOnlyNonReturning =
    driver.supportsBatch &&
    !driver.supportsTransactions &&
    !driver.adapter.capabilities.supportsReturning;
  if (!batchOnlyNonReturning) return;
  if (ATOMIC_RESOLUTION_OPERATIONS.has(operation)) {
    throw new TransactionError(
      operation === "upsert"
        ? "cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back after an atomic batch commits"
        : `Driver '${driver.driverName}' cannot execute '${operation}' because public result parsing cannot be rolled back.`,
      { meta: { driver: driver.driverName, operation } }
    );
  }
  if (ROW_RETURNING_BULK_OPERATIONS.has(operation) && hasPublicResult) {
    throw new TransactionError(
      `Driver '${driver.driverName}' cannot execute '${operation}' with 'select' because public result parsing cannot be rolled back.`,
      { meta: { driver: driver.driverName, operation } }
    );
  }
}

/** Does the program's terminal result come from a read (a `select` projection)? */
export function publishesRows(program: Program): boolean {
  const reads = new Set<string>();
  for (const fragment of program.fragments) {
    for (const step of fragment.writes) {
      if (step.kind === "read") reads.add(step.id);
    }
  }
  return Object.values(program.outputs).some((source) =>
    (Array.isArray(source) ? source : [source]).some((reference) =>
      reads.has(reference.step)
    )
  );
}
