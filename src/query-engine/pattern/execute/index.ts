/**
 * Unit F — `execute(program, driver, options)` (pattern-engine-ideal-state.md
 * §8, §13.3).
 *
 * The one entry. It chooses the enforcer from the driver's declared substrate
 * exactly as today's `OperationExecutor.execute` does:
 *
 * - a program whose whole effect is one plain statement (no match, one read or
 *   write with no reference, no insert-id output, no skip effect) runs
 *   directly on the driver with no envelope, on EVERY substrate — statement
 *   atomicity;
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
import {
  type StatementStep,
  statementHasReferences,
} from "../../write-engine/OperationFragment";
import { markRaceIfPinned } from "../../write-engine/race-retry";
import { noAtomicSubstrateError } from "../../write-engine/shared";
import type { Fragment, Program } from "../fragment";
import { publishesRows, refuseUnsupportedSubstrate } from "./admission";
import { executeInBatch, guardSteps } from "./batch";
import { withRaceRetry } from "./retry";
import { executeInSegments } from "./segments";
import { executeInTransaction } from "./transaction";
import {
  attributionOf,
  enforcePostcondition,
  extractOutputs,
  packFragment,
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
  const resolved = packWhatNoMatchDecides(program);
  const direct = statementAtomicProgram(resolved, driver);
  if (direct) {
    return runStatementAtomic(resolved, direct, driver, context, rows);
  }
  if (!(driver.supportsTransactions || driver.supportsBatch)) {
    throw noAtomicSubstrateError(driver.driverName, program.operation);
  }
  if (driver.supportsTransactions) {
    return executeInTransaction({
      program: resolved,
      driver,
      context,
      rows,
      ...(options.scope ? { scope: options.scope } : {}),
    });
  }
  const run = {
    program: resolved,
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
  return resolved.fragments.length === 1
    ? executeInBatch(run)
    : executeInSegments(run);
}

/** Does this fragment run any match at all? An EMPTY LEVEL is not a match. */
function hasMatches(fragment: Fragment): boolean {
  return fragment.matches.some((level) => level.length > 0);
}

/**
 * Settle every fragment whose writes no execution can still change.
 *
 * A fragment re-packs its taken arm from what its own matches bound (§6.3).
 * A fragment with NO match has nothing to learn: its `known` is empty whenever
 * it is packed, so packing it now yields exactly what packing it after an
 * empty match phase would. Doing it here — once — is what lets the seam below
 * see a program's real statements instead of the arm-less placeholder the
 * packer hands over, and the enforcers then run those same steps.
 */
function packWhatNoMatchDecides(program: Program): Program {
  if (!program.fragments.some((f) => f.pack && !hasMatches(f))) return program;
  return {
    ...program,
    fragments: program.fragments.map((fragment) => {
      if (!fragment.pack || hasMatches(fragment)) return fragment;
      const { pack: _settled, ...rest } = packFragment(fragment, new Map());
      return rest;
    }),
  };
}

/**
 * The statement-atomic seam: a program whose whole effect is ONE statement
 * runs bare, on every substrate, exactly as today's engine runs it (its
 * `compileSingleStatementCandidate` + `canExecuteDirectly`). A postcondition is
 * permitted and enforced after the single round trip — the statement either
 * committed its one row or affected none, so there is nothing to roll back.
 */
function statementAtomicProgram(
  program: Program,
  driver: AnyDriver
): StatementStep | undefined {
  const [fragment] = program.fragments;
  if (!fragment || program.fragments.length !== 1) return undefined;
  // A match is a statement of its own, and its rows may still re-pack the
  // writes; both make this more than one statement.
  if (hasMatches(fragment) || fragment.writes.length !== 1) return undefined;
  // On an atomic-batch substrate each premise lowers to a GUARD statement of
  // its own; the transaction substrate enforces the same premise with the
  // match's lock and emits none. A premise outlives its match whenever the
  // locate folded into the write, which is why counting matches is not enough.
  if (
    !driver.supportsTransactions &&
    guardSteps(fragment.premises).length > 0
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
  step: StatementStep,
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
