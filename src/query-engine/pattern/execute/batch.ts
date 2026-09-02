/**
 * Unit F — the atomic-batch enforcer (pattern-engine-ideal-state.md §8.2).
 *
 * The matches run in a preceding round trip per dependency level (today's
 * `executePlanningLevels`: a level of one read on its own `_execute`, a wider
 * level through one `_executeBatch`), their postconditions enforced in step
 * order. Then ONE atomic unit: one guard per premise, before the writes, in
 * the stable order of `fragment.premises`, then the asserts and retracts in
 * dataflow order. A guard is the match re-run under the adapter's assertion
 * unless packing supplied an explicit guard (`BoundPremise.guard`), which is
 * used verbatim. Postconditions the batch cannot enforce — those on the unit's
 * own statements — are stripped; a provider `insertId` a later statement of
 * the same unit consumes rides the adapter's `batchRefs` scratch.
 *
 * Failure attribution inside the unit is today's: a guard abort is attributed
 * by the provider's statement index or by re-probing each guard, a pinned
 * unique violation is marked retryable, a skippable merge root's violation is
 * the skip.
 */
import { getAdapterInternals } from "@adapters/adapter-internals";
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import {
  assertStatementBindParameterCapacity,
  normalizedBindParameterLimit,
} from "@drivers/bind-parameter-capacity";
import {
  assertNormalizedBatchResults,
  assertNormalizedQueryResult,
} from "@drivers/normalized-result";
import { transferPreparedStatement } from "@drivers/prepared-statement-provenance";
import type { QueryResult } from "@drivers/types";
import {
  NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
  NestedWriteAssertionError,
  NestedWriteError,
  QueryEngineError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import { type Sql, sql } from "@sql";
import { createCorrelationId } from "../../execution-context";
import type { PreparedQuery } from "../../types";
import { validateFragment } from "../../write-engine/FragmentValidator";
import {
  createFailureError,
  type Failure,
  type GuardStep,
  type OperationFragment,
  type OperationStep,
  ref,
  type StatementStep,
  statementReferences,
} from "../../write-engine/OperationFragment";
import {
  isRetryableRace,
  markRaceIfPinned,
} from "../../write-engine/race-retry";
import type { BoundPremise, Fragment, Program } from "../fragment";
import {
  type Attribution,
  attributionOf,
  enforcePostcondition,
  extractOutputs,
  materializeBatchSql,
  materializeLinearSql,
  mergeBatchOutputs,
  packFragment,
  type RowsBoundary,
  type RuntimeValues,
  resolveConsumedValue,
  resolveProgramOutputs,
  setRuntimeValue,
  statementExecutionContext,
} from "./values";

export interface BatchRun {
  readonly program: Program;
  readonly driver: AnyDriver;
  readonly context: QueryExecutionContext;
  readonly rows: RowsBoundary;
  /** Fired after a unit carrying a write is acknowledged committed. */
  readonly committedWriteSegment?: () => Promise<void>;
  /** Fired when a dispatched write's outcome is unknown (no acknowledgement). */
  readonly writeMayBeVisible?: () => Promise<void>;
}

export interface BatchEntry {
  readonly statement: Sql;
  readonly step?: StatementStep;
  readonly guard?: GuardStep;
  readonly guardProbe?: Sql;
}

/** One compiled atomic unit: its entries and the values threaded through. */
export interface AtomicUnit {
  readonly entries: readonly BatchEntry[];
  readonly steps: readonly StatementStep[];
  readonly values: RuntimeValues;
  readonly hasWrite: boolean;
  readonly mergeRoot?: string;
}

export interface UnitOutcome {
  readonly skippedRoot: boolean;
}

/** Internal control flow for a merge root whose unique violation is the skip. */
export class SkippedMergeRoot extends Error {}

export async function executeInBatch(
  run: BatchRun
): Promise<Readonly<Record<string, unknown>>> {
  const [fragment] = run.program.fragments;
  if (!fragment || run.program.fragments.length !== 1) {
    throw new QueryEngineError(
      "The atomic-batch enforcer runs exactly one fragment; a multi-fragment program is the segments enforcer's."
    );
  }
  const attribution = attributionOf(run.program);
  const values: RuntimeValues = new Map();
  await runMatchLevels(fragment, run.driver, values, run.context, attribution);
  // The arm the matches decided, re-packed with their results (§6.3).
  const packed = packFragment(fragment, values);
  const unit = compileUnit(packed, run.driver, values, {
    inherited: [],
    attribution,
  });
  assertUnitCapacity(unit, run.driver);
  let committedNotified = false;
  let outcomeFailure: { readonly error: unknown } | undefined;
  const committed =
    unit.hasWrite && run.committedWriteSegment
      ? async () => {
          if (committedNotified) return;
          committedNotified = true;
          try {
            await run.committedWriteSegment?.();
          } catch (error) {
            outcomeFailure = { error };
          }
        }
      : undefined;
  let dispatched = false;
  try {
    await runUnit(
      unit,
      run.driver,
      run.context,
      attribution,
      run.driver.supportsOrderedCommittedSegments ? committed : undefined,
      run.writeMayBeVisible
        ? () => {
            dispatched = true;
          }
        : undefined
    );
    if (unit.hasWrite && !run.driver.supportsOrderedCommittedSegments) {
      await committed?.();
    }
  } catch (error) {
    if (outcomeFailure) throw outcomeFailure.error;
    if (
      unit.hasWrite &&
      dispatched &&
      !committedNotified &&
      run.writeMayBeVisible &&
      !(error instanceof UniqueConstraintError || isRetryableRace(error))
    ) {
      await run.writeMayBeVisible();
    }
    throw error;
  }
  if (outcomeFailure) throw outcomeFailure.error;
  return resolveProgramOutputs(run.program, unit.values, run.rows);
}

// ---------------------------------------------------------------------------
// Match phase
// ---------------------------------------------------------------------------

/**
 * Run a fragment's matches level by level. Every match's postcondition is
 * enforced afterwards in step order, so the first failing read raises the same
 * typed failure it raises sequentially. An `unreferenced` premise is enforced
 * here as well: its match lists the holders that would become an occupied
 * slot, and any row refuses the operation before a write is dispatched
 * (today's occupied-slot refusal).
 */
export async function runMatchLevels(
  fragment: Fragment,
  driver: AnyDriver,
  values: RuntimeValues,
  context: QueryExecutionContext,
  attribution: Attribution
): Promise<void> {
  for (const level of fragment.matches) {
    const [only] = level;
    if (only && level.length === 1) {
      const statement = materializeLinearSql(only.statement, values);
      assertCapacity(statement, driver);
      const result = await driver._execute(
        statement,
        statementExecutionContext(only, context)
      );
      enforcePostcondition(only, result, attribution);
      values.set(only.id, extractOutputs(only, result, values));
      continue;
    }
    const queries = level.map((step) => {
      const statement = materializeLinearSql(step.statement, values);
      assertCapacity(statement, driver);
      return prepareBatchQuery(
        statement,
        driver,
        statementExecutionContext(step, context)
      );
    });
    const results = await driver._executeBatch(queries, undefined, context);
    assertNormalizedBatchResults(results, level.length, {
      provider: driver.driverName,
      operation: "query-engine-v2",
    });
    for (const [index, step] of level.entries()) {
      const result = results[index];
      if (!result) continue;
      enforcePostcondition(step, result, attribution);
      values.set(step.id, extractOutputs(step, result, values));
    }
  }
  enforceUnreferencedPremises(fragment, values, attribution);
}

function enforceUnreferencedPremises(
  fragment: Fragment,
  values: RuntimeValues,
  attribution: Attribution
): void {
  for (const bound of fragment.premises) {
    if (bound.premise.kind !== "unreferenced") continue;
    const outputs = values.get(bound.match.id);
    const holders = outputs
      ? [...outputs.values()].find(Array.isArray)
      : undefined;
    if (Array.isArray(holders) && holders.length > 0) {
      throw createFailureError(
        bound.failure,
        attribution.model,
        attribution.operation
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * The guard a premise lowers to inside an atomic unit. Explicit guards are
 * used verbatim; otherwise the enforcer re-runs the match under the adapter's
 * assertion. A raceable `notExists` premise carrying a pin needs no guard —
 * the pin rides the write and the unique constraint catches the race (the Pin
 * Rule). An `occupant` premise cannot be derived from the match re-run (the
 * match would still find A row, not necessarily the same occupant), so it
 * requires an explicit guard. `unreferenced` is enforced at match time. A
 * derived guard raises the premise's own failure — today's exact class,
 * message and raceability, supplied by packing.
 */
export function guardFor(bound: BoundPremise): GuardStep | undefined {
  if (bound.guard) return bound.guard;
  const { premise, match } = bound;
  switch (premise.kind) {
    case "exists":
      return derivedGuard(match, "exists", bound.failure);
    case "notExists":
      if (premise.pin) return undefined;
      return derivedGuard(match, "notExists", bound.failure);
    case "occupant":
      throw new QueryEngineError(
        `Premise 'occupant' on match '${match.id}' needs an explicit guard; the match re-run cannot assert the occupant.`
      );
    case "unreferenced":
      return undefined;
    default:
      return undefined;
  }
}

function derivedGuard(
  match: StatementStep,
  kind: "exists" | "notExists",
  failure: Failure
): GuardStep {
  return {
    id: `${match.id}.premise`,
    kind: "guard",
    premise: { kind, statement: match.statement },
    failure,
  };
}

export function guardSteps(premises: readonly BoundPremise[]): GuardStep[] {
  const guards: GuardStep[] = [];
  for (const bound of premises) {
    const guard = guardFor(bound);
    if (guard) guards.push(guard);
  }
  return guards;
}

// ---------------------------------------------------------------------------
// The atomic unit
// ---------------------------------------------------------------------------

export interface CompileUnitOptions {
  /** Inherited premises re-asserted in this unit (segments only), first. */
  readonly inherited: readonly GuardStep[];
  readonly attribution: Attribution;
  /** The merge root whose zero-row outcome skips its dependents. */
  readonly mergeRoot?: string;
}

/**
 * Lower a fragment's assert phase into one runnable unit: inherited guards
 * (only when the unit carries a write — a read-only unit has nothing to
 * protect), premise guards in stable order, then the writes. The fragment's
 * matches are already bound in `values`, so their references materialize as
 * literals exactly as today's compilers substitute planning outputs.
 */
export function compileUnit(
  fragment: Fragment,
  driver: AnyDriver,
  values: RuntimeValues,
  options: CompileUnitOptions
): AtomicUnit {
  const hasWrite = fragment.writes.some((step) => step.kind === "write");
  const premiseGuards = guardSteps(fragment.premises);
  const unitSteps: OperationStep[] = [
    ...(hasWrite ? options.inherited : []),
    ...premiseGuards,
    ...fragment.writes,
  ];
  // The whole fragment, matches first, is what the vocabulary's validator
  // checks: every reference points backward at a declared output, ids are
  // unique, and every guard obeys the Pin Rule. What earlier fragments bound
  // stands in as already-run reads, so a later member's reference to the
  // capture is backward, not "outside".
  validateFragment(unitFragment(fragment, unitSteps, values));

  const unitValues: RuntimeValues = new Map(values);
  const batchId = `operation_${createCorrelationId()}`;
  const adapter = driver.adapter;
  const batchRefs = getAdapterInternals(adapter).batchRefs;
  const entries: BatchEntry[] = [];
  const steps: StatementStep[] = [];
  let nextReference = 0;
  let usesScratch = false;
  const consumed = locallyConsumedOutputs(unitSteps);

  for (const step of unitSteps) {
    if (step.kind === "recordSeries") {
      throw new QueryEngineError(
        `Record series step '${step.id}' has no place in a scheduled program.`
      );
    }
    if (step.kind === "guard") {
      const probe = materializeBatchSql(step.premise.statement, unitValues);
      const statement =
        step.premise.kind === "exists"
          ? adapter.assertions.exists(probe)
          : adapter.assertions.notExists(probe);
      entries.push({ statement, guard: step, guardProbe: probe });
      continue;
    }
    if (
      step.kind === "write" &&
      step.onUniqueConflict === "skip" &&
      step.id !== options.mergeRoot
    ) {
      throw new QueryEngineError(
        `Step '${step.id}' carries an onUniqueConflict skip effect that has no atomic-batch lowering.`
      );
    }
    // Postconditions on the unit's own statements are stripped: the batch
    // cannot check them, and today's batch-mode compilers emit none.
    steps.push(step);
    entries.push({
      statement: materializeBatchSql(step.statement, unitValues),
      step,
    });
    for (const [output, source] of Object.entries(step.outputs)) {
      if (source.kind === "consumedValue") {
        const resolved = resolveConsumedValue(source.source, unitValues, true);
        if (resolved !== undefined) {
          setRuntimeValue(unitValues, step.id, output, resolved);
        }
        continue;
      }
      if (source.kind !== "insertId") continue;
      if (!consumed.has(`${step.id}.${output}`)) continue;
      const storeLastInsertId = batchRefs.storeLastInsertId;
      if (!storeLastInsertId) {
        throw new QueryEngineError(
          `Step '${step.id}' publishes an insert id a later statement of the same unit consumes, and this dialect has no batch scratch for it; the scheduler must cut a fragment there.`
        );
      }
      usesScratch = true;
      const key = `ref_${nextReference}`;
      nextReference += 1;
      setRuntimeValue(
        unitValues,
        step.id,
        output,
        batchRefs.read(batchId, key)
      );
      entries.push({ statement: storeLastInsertId(batchId, key) });
    }
  }

  const wrapped = usesScratch
    ? [
        ...batchRefs.setup(batchId).map((statement) => ({ statement })),
        { statement: batchRefs.clear(batchId) },
        ...entries,
        { statement: batchRefs.cleanup(batchId) },
      ]
    : entries;
  return {
    entries: wrapped,
    steps,
    values: unitValues,
    hasWrite,
    ...(options.mergeRoot ? { mergeRoot: options.mergeRoot } : {}),
  };
}

function unitFragment(
  fragment: Fragment,
  unitSteps: readonly OperationStep[],
  bound: RuntimeValues
): OperationFragment {
  const steps: OperationStep[] = [];
  const local = new Set<string>();
  for (const level of fragment.matches) {
    for (const match of level) local.add(match.id);
  }
  for (const step of unitSteps) local.add(step.id);
  for (const [stepId, outputs] of bound) {
    if (local.has(stepId)) continue;
    steps.push({
      id: stepId,
      kind: "read",
      statement: sql.empty,
      outputs: Object.fromEntries(
        [...outputs.keys()].map((name) => [name, { kind: "rows" as const }])
      ),
    });
  }
  for (const level of fragment.matches) steps.push(...level);
  steps.push(...unitSteps);
  const outputs: Record<string, ReturnType<typeof ref>> = {};
  for (const step of steps) {
    if (step.kind === "guard" || step.kind === "recordSeries") continue;
    for (const output of Object.keys(step.outputs)) {
      outputs[`${step.id}.${output}`] = ref(step.id, output);
    }
  }
  return { steps, outputs };
}

function locallyConsumedOutputs(
  steps: readonly OperationStep[]
): ReadonlySet<string> {
  const consumed = new Set<string>();
  for (const step of steps) {
    const statement =
      step.kind === "guard"
        ? step.premise.statement
        : step.kind === "recordSeries"
          ? undefined
          : step.statement;
    if (!statement) continue;
    for (const reference of statementReferences(statement)) {
      consumed.add(`${reference.step}.${reference.output}`);
    }
  }
  return consumed;
}

export function assertUnitCapacity(unit: AtomicUnit, driver: AnyDriver): void {
  for (const entry of unit.entries) assertCapacity(entry.statement, driver);
}

function assertCapacity(statement: Sql, driver: AnyDriver): void {
  assertStatementBindParameterCapacity(
    statement,
    driver.driverName,
    normalizedBindParameterLimit(driver.maxBindParametersPerStatement),
    "operation"
  );
}

/**
 * Run one unit as one driver batch and merge its results into the unit's
 * values. A skippable merge root that made no row (a zero row count, or the
 * unique violation the dialect cannot absorb in place) reports `skippedRoot`.
 */
export async function runUnit(
  unit: AtomicUnit,
  driver: AnyDriver,
  context: QueryExecutionContext,
  attribution: Attribution,
  committed?: () => Promise<void>,
  dispatching?: () => void
): Promise<UnitOutcome> {
  const queries = unit.entries.map((entry) =>
    prepareBatchQuery(
      entry.statement,
      driver,
      statementExecutionContext(entry.step, context)
    )
  );
  let results: QueryResult<unknown>[];
  try {
    dispatching?.();
    results = await driver._executeBatch(
      queries,
      undefined,
      context,
      committed
    );
  } catch (rawError) {
    const error = await attributeGuardFailure(
      rawError,
      unit.entries,
      driver,
      context,
      attribution
    );
    const root = unit.entries.find(
      (entry) => entry.step?.id === unit.mergeRoot
    )?.step;
    if (
      error instanceof UniqueConstraintError &&
      root?.kind === "write" &&
      root.onUniqueConflict === "skip"
    ) {
      throw new SkippedMergeRoot();
    }
    for (const entry of unit.entries) {
      const pin = entry.step?.kind === "write" ? entry.step.racePin : undefined;
      if (pin) markRaceIfPinned(error, pin);
    }
    throw error;
  }
  assertNormalizedBatchResults(results, unit.entries.length, {
    provider: driver.driverName,
    operation: "query-engine-v2",
  });
  const rootIndex =
    unit.mergeRoot === undefined
      ? -1
      : unit.entries.findIndex((entry) => entry.step?.id === unit.mergeRoot);
  if (rootIndex >= 0 && results[rootIndex]?.rowCount === 0) {
    return { skippedRoot: true };
  }
  for (let index = 0; index < unit.entries.length; index += 1) {
    const step = unit.entries[index]?.step;
    const result = results[index];
    if (!(step && result)) continue;
    mergeBatchOutputs(step, result, unit.values);
  }
  return { skippedRoot: false };
}

function prepareBatchQuery(
  statement: Sql,
  driver: AnyDriver,
  context: QueryExecutionContext
): PreparedQuery {
  const prepared = driver._prepare(statement, context);
  return transferPreparedStatement(prepared, {
    sql: prepared.sql,
    params: prepared.params ?? [],
    context,
  });
}

async function attributeGuardFailure(
  error: unknown,
  entries: readonly BatchEntry[],
  driver: AnyDriver,
  context: QueryExecutionContext,
  attribution: Attribution
): Promise<unknown> {
  if (!(error instanceof NestedWriteAssertionError)) return error;
  const failureOf = (guard: GuardStep) =>
    createFailureError(guard.failure, attribution.model, attribution.operation);
  const statementIndex = error.meta.statementIndex;
  if (typeof statementIndex === "number") {
    const guard = entries[statementIndex]?.guard;
    return guard ? failureOf(guard) : error;
  }
  for (const entry of entries) {
    if (!(entry.guard && entry.guardProbe)) continue;
    const result = await driver._execute(entry.guardProbe, context);
    assertNormalizedQueryResult(result, {
      provider: driver.driverName,
      operation: entry.guard.id,
    });
    const exists = result.rows.length > 0;
    const holds = entry.guard.premise.kind === "exists" ? exists : !exists;
    if (!holds) return failureOf(entry.guard);
  }
  if (entries.some((entry) => entry.guard)) return error;
  return new NestedWriteError(NESTED_WRITE_ASSERTION_FLOOR_MESSAGE, "", {
    code: VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED,
    cause: error,
  });
}
