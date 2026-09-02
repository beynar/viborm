/**
 * Unit F — the transaction enforcer (pattern-engine-ideal-state.md §8.2).
 *
 * Per fragment: the matches run first, one round trip each in dependency
 * order (today's `executeLinear` over the planning fragment), decision matches
 * locked with the dialect's `FOR UPDATE`; then the asserts and retracts, one
 * round trip each, every postcondition checked in JS before the transaction
 * commits. The lock IS the premise: a guard step packing supplied for the
 * batch substrate is not executed here, exactly as today's transaction-mode
 * compilers emit none.
 *
 * A merge-outcome boundary (a skippable root whose row count decides whether
 * its dependents run) is a SAVEPOINT around the root and its dependents: a
 * zero-row root rolls the savepoint back and the dependents are not executed
 * (today's `runRecordSeriesMember`).
 */
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import {
  assertStatementBindParameterCapacity,
  normalizedBindParameterLimit,
} from "@drivers/bind-parameter-capacity";
import { QueryEngineError } from "@errors";
import { type Sql, sql } from "@sql";
import { executeSkippableWrite } from "../../skippable-write";
import type {
  OperationStep,
  StatementStep,
} from "../../write-engine/OperationFragment";
import { markRaceIfPinned } from "../../write-engine/race-retry";
import type { Fragment, Program } from "../fragment";
import { memberGroups } from "./segments-layout";
import {
  type Attribution,
  attributionOf,
  enforcePostcondition,
  extractOutputs,
  materializeLinearSql,
  type RowsBoundary,
  type RuntimeValues,
  resolveProgramOutputs,
  statementExecutionContext,
} from "./values";

export interface TransactionRun {
  readonly program: Program;
  readonly driver: AnyDriver;
  readonly context: QueryExecutionContext;
  readonly rows: RowsBoundary;
  /**
   * `"open"`: the driver handed in is already inside its own atomic scope (the
   * client's callback-transaction seam) — run linearly on it rather than open
   * a second envelope. `"owned"` (default): open one interactive transaction.
   */
  readonly scope?: "open" | "owned";
}

/** Internal control flow for a merge root whose row count was zero. */
class SkippedMergeMember extends Error {}

export async function executeInTransaction(
  run: TransactionRun
): Promise<Readonly<Record<string, unknown>>> {
  if (run.scope === "open") {
    return runProgramLinear(run, run.driver);
  }
  return run.driver.withTransaction(
    (transaction) => runProgramLinear(run, transaction),
    undefined,
    run.context
  );
}

async function runProgramLinear(
  run: TransactionRun,
  driver: AnyDriver
): Promise<Readonly<Record<string, unknown>>> {
  const values: RuntimeValues = new Map();
  const attribution = attributionOf(run.program);
  for (const group of memberGroups(run.program)) {
    if (group.mergeRoot === undefined) {
      for (const fragment of group.fragments) {
        await runFragmentLinear(fragment, driver, values, run, attribution);
      }
      continue;
    }
    // The merge root and its dependents share one savepoint: a zero-row root
    // rolls back whatever the dependents did not get to run, and the group's
    // outputs stay unbound (today's `{ kind: "skipped" }` member result).
    try {
      await driver.withTransaction(
        async (savepoint) => {
          for (const fragment of group.fragments) {
            await runFragmentLinear(
              fragment,
              savepoint,
              values,
              run,
              attribution,
              group.mergeRoot
            );
          }
        },
        undefined,
        run.context
      );
    } catch (error) {
      if (!(error instanceof SkippedMergeMember)) throw error;
      // The savepoint rolled the group back; nothing it bound survives.
      for (const fragment of group.fragments) {
        for (const step of fragment.writes) values.delete(step.id);
        for (const level of fragment.matches) {
          for (const match of level) values.delete(match.id);
        }
      }
    }
  }
  return resolveProgramOutputs(run.program, values, run.rows);
}

async function runFragmentLinear(
  fragment: Fragment,
  driver: AnyDriver,
  values: RuntimeValues,
  run: TransactionRun,
  attribution: Attribution,
  mergeRoot?: string
): Promise<void> {
  const decisions = decisionMatches(fragment);
  for (const level of fragment.matches) {
    for (const match of level) {
      const statement = decisions.has(match.id)
        ? lockForUpdate(driver, match.statement)
        : match.statement;
      await runStatement(
        match,
        statement,
        driver,
        values,
        run.context,
        attribution
      );
    }
  }
  for (const step of fragment.writes) {
    await runWriteStep(
      step,
      driver,
      values,
      run.context,
      attribution,
      mergeRoot
    );
  }
}

async function runWriteStep(
  step: OperationStep,
  driver: AnyDriver,
  values: RuntimeValues,
  context: QueryExecutionContext,
  attribution: Attribution,
  mergeRoot: string | undefined
): Promise<void> {
  if (step.kind === "guard") return; // the lock is the premise (§8.2)
  if (step.kind === "recordSeries") {
    throw new QueryEngineError(
      `Record series step '${step.id}' has no place in a scheduled program.`
    );
  }
  const result = await runStatement(
    step,
    step.statement,
    driver,
    values,
    context,
    attribution,
    step.id === mergeRoot
  );
  if (step.id === mergeRoot && result.rowCount === 0) {
    throw new SkippedMergeMember();
  }
}

async function runStatement(
  step: StatementStep,
  statement: Sql,
  driver: AnyDriver,
  values: RuntimeValues,
  context: QueryExecutionContext,
  attribution: Attribution,
  deferPostcondition = false
): Promise<{ readonly rowCount: number }> {
  const materialized = materializeLinearSql(statement, values);
  assertStatementBindParameterCapacity(
    materialized,
    driver.driverName,
    normalizedBindParameterLimit(driver.maxBindParametersPerStatement),
    "operation"
  );
  const stepContext = statementExecutionContext(step, context);
  let result: Awaited<ReturnType<AnyDriver["_execute"]>>;
  try {
    result =
      step.kind === "write" && step.onUniqueConflict === "skip"
        ? await executeSkippableWrite(driver, materialized, stepContext)
        : await driver._execute(materialized, stepContext);
  } catch (error) {
    if (step.kind === "write" && step.racePin) {
      markRaceIfPinned(error, step.racePin);
    }
    throw error;
  }
  // A merge root's zero-row result is the skip, not a failed postcondition.
  if (!(deferPostcondition && result.rowCount === 0)) {
    enforcePostcondition(step, result, attribution);
  }
  values.set(step.id, extractOutputs(step, result, values));
  return result;
}

/** The matches whose bindings a premise protects — the decision reads. */
export function decisionMatches(fragment: Fragment): ReadonlySet<string> {
  return new Set(fragment.premises.map((bound) => bound.match.id));
}

/**
 * The dialect's row lock, appended to a packed match. SQLite has no row lock
 * (its adapter omits `FOR UPDATE`); PostgreSQL and MySQL append it. The report
 * proposes an adapter method (`locks.forUpdate(statement)`) so this dialect
 * fact leaves the executor.
 */
export function lockForUpdate(driver: AnyDriver, statement: Sql): Sql {
  if (driver.dialect === "sqlite") return statement;
  return sql`${statement} FOR UPDATE`;
}
