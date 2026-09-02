/**
 * Unit F — `execute(program, driver, options)` (pattern-engine-ideal-state.md
 * §8, §13.3).
 *
 * The one entry. It chooses the enforcer from the driver's declared substrate
 * exactly as today's `OperationExecutor.execute` does:
 *
 * - a program that is one plain statement (no matches, one read or write with
 *   no reference, no insert-id output, no skip effect) runs directly on the
 *   driver with no envelope — statement atomicity;
 * - a driver with neither an interactive transaction nor an atomic batch
 *   cannot run a multi-statement program and is refused with today's error;
 * - an interactive transaction runs every fragment linearly inside one
 *   transaction (a merge group behind a savepoint);
 * - an atomic-batch driver runs a one-fragment program as one unit, and a
 *   multi-fragment program as committed segments.
 *
 * A retryable race re-runs the whole program once from a fresh construction
 * (the program thunk); a committed prefix forbids that and the segments
 * enforcer's own member retry applies instead.
 */
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import {
  assertStatementBindParameterCapacity,
  normalizedBindParameterLimit,
} from "@drivers/bind-parameter-capacity";
import { createOperationExecutionContext } from "../../execution-context";
import { statementHasReferences } from "../../write-engine/OperationFragment";
import { markRaceIfPinned } from "../../write-engine/race-retry";
import { noAtomicSubstrateError } from "../../write-engine/shared";
import type { Program } from "../fragment";
import { publishesRows, refuseUnsupportedSubstrate } from "./admission";
import { executeInBatch } from "./batch";
import { withRaceRetry } from "./retry";
import { executeInSegments } from "./segments";
import { executeInTransaction } from "./transaction";
import {
  attributionOf,
  enforcePostcondition,
  extractOutputs,
  type RowsBoundary,
  type RuntimeValues,
  resolveProgramOutputs,
  rowsBoundary,
  statementExecutionContext,
} from "./values";

export interface ExecuteOptions {
  /** Driver attribution; defaults to one built from the program's model and operation. */
  readonly execution?: QueryExecutionContext;
  /**
   * The projection's raw keys per published step (unit G's `Projection`), so
   * a provider row that does not match the requested columns is refused with
   * the parser contract's error before it leaves the executor.
   */
  readonly expectedRows?: Readonly<Record<string, readonly string[]>>;
  /** `"open"`: the driver is already inside an atomic scope (see transaction.ts). */
  readonly scope?: "open" | "owned";
  readonly committedWriteSegment?: () => Promise<void>;
  readonly writeMayBeVisible?: () => Promise<void>;
  /** `false` disables the once-only race retry (the segments' member retry stays). */
  readonly retry?: boolean;
}

export type Outputs = Readonly<Record<string, unknown>>;

export async function execute(
  program: Program | (() => Program),
  driver: AnyDriver,
  options: ExecuteOptions = {}
): Promise<Outputs> {
  const construct = typeof program === "function" ? program : () => program;
  const attempt = () => executeOnce(construct(), driver, options);
  return options.retry === false ? attempt() : withRaceRetry(attempt);
}

async function executeOnce(
  program: Program,
  driver: AnyDriver,
  options: ExecuteOptions
): Promise<Outputs> {
  const context =
    options.execution ??
    createOperationExecutionContext(program.model, program.operation);
  refuseUnsupportedSubstrate(driver, program.operation, publishesRows(program));
  const rows = rowsBoundary(driver, program.operation, options.expectedRows);
  const direct = statementAtomicProgram(program);
  if (direct) {
    return runStatementAtomic(program, direct, driver, context, rows);
  }
  if (!(driver.supportsTransactions || driver.supportsBatch)) {
    throw noAtomicSubstrateError(driver.driverName, program.operation);
  }
  if (driver.supportsTransactions) {
    return executeInTransaction({
      program,
      driver,
      context,
      rows,
      ...(options.scope ? { scope: options.scope } : {}),
    });
  }
  const run = {
    program,
    driver,
    context,
    rows,
    ...(options.committedWriteSegment
      ? { committedWriteSegment: options.committedWriteSegment }
      : {}),
    ...(options.writeMayBeVisible
      ? { writeMayBeVisible: options.writeMayBeVisible }
      : {}),
  };
  return program.fragments.length === 1
    ? executeInBatch(run)
    : executeInSegments(run);
}

/**
 * The statement-atomic seam: one plain statement, no envelope. A postcondition
 * is permitted and enforced after the single round trip (the statement either
 * committed its one row or affected none).
 */
function statementAtomicProgram(program: Program) {
  const [fragment] = program.fragments;
  if (!fragment || program.fragments.length !== 1) return undefined;
  if (
    fragment.pack ||
    fragment.matches.length !== 0 ||
    fragment.writes.length !== 1
  ) {
    return undefined;
  }
  const [step] = fragment.writes;
  if (!step || step.kind === "guard" || step.kind === "recordSeries") {
    return undefined;
  }
  if (
    (step.kind === "write" && step.onUniqueConflict) ||
    statementHasReferences(step.statement) ||
    Object.values(step.outputs).some((source) => source.kind === "insertId")
  ) {
    return undefined;
  }
  return step;
}

async function runStatementAtomic(
  program: Program,
  step: NonNullable<ReturnType<typeof statementAtomicProgram>>,
  driver: AnyDriver,
  context: QueryExecutionContext,
  rows: RowsBoundary
): Promise<Outputs> {
  assertStatementBindParameterCapacity(
    step.statement,
    driver.driverName,
    normalizedBindParameterLimit(driver.maxBindParametersPerStatement),
    "operation"
  );
  let result: Awaited<ReturnType<AnyDriver["_execute"]>>;
  try {
    result = await driver._execute(
      step.statement,
      statementExecutionContext(step, context)
    );
  } catch (error) {
    if (step.kind === "write" && step.racePin) {
      markRaceIfPinned(error, step.racePin);
    }
    throw error;
  }
  enforcePostcondition(step, result, attributionOf(program));
  const values: RuntimeValues = new Map();
  values.set(step.id, extractOutputs(step, result, values));
  return resolveProgramOutputs(program, values, rows);
}

export { refuseUnsupportedSubstrate } from "./admission";
export { executeInBatch } from "./batch";
export { withRaceRetry } from "./retry";
export { executeInSegments } from "./segments";
export { executeInTransaction } from "./transaction";
