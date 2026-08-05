// biome-ignore-all lint/style/useFilenamingConvention: OperationExecutor is the architecture name.
import type { AnyDriver, QueryExecutionContext, QueryResult } from "@drivers";
import {
  assertNormalizedBatchResults,
  assertNormalizedQueryResult,
} from "@drivers/normalized-result";
import {
  NestedWriteAssertionError,
  NestedWriteError,
  NotFoundError,
  QueryEngineError,
  TransactionError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import { isSql, Sql } from "@sql";
import { createCorrelationId } from "../execution-context";
import type { QueryEngine } from "../query-engine";
import { executeSkippableWrite } from "../skippable-write";
import type {
  Operation,
  PreparedBatchGuard,
  PreparedBatchOperation,
  PreparedQuery,
} from "../types";
import { validateFragment } from "./FragmentValidator";
import { NESTED_WRITE_ASSERTION_FLOOR_MESSAGE } from "./messages";
import {
  type Failure,
  type FragmentOutputSource,
  type GuardStep,
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type OperationValueReference,
  type PlanningFragment,
  type ReadStep,
  type StatementOutputSource,
  type StatementStep,
} from "./OperationFragment";
import { markRaceable, markRaceIfPinned, racePinMatches } from "./race-retry";
import { isRecord, noAtomicSubstrateError } from "./shared";

type RuntimeValues = Map<string, Map<string, unknown>>;

/**
 * The internal contract the executor drives. The executor knows nothing about
 * what the operation means: it is handed a mode, a planning fragment, a
 * per-branch compiler, and a result parser, and it only runs already-compiled
 * fragments safely. Concrete operations own every semantic decision.
 */
export interface ExecutableOperation {
  readonly mode: "transaction" | "batch";
  planning(): PlanningFragment;
  compile(known: Readonly<Record<string, unknown>>): OperationFragment;
  parse<T>(outputs: Readonly<Record<string, unknown>>): T;
  /**
   * Optional execution-context gate, invoked ONLY on the `$transaction([...])`
   * array batch-preparation seams ({@link prepareBatch}/{@link prepareSharedBatch}),
   * never on the direct linear path. An operation whose direct result is a
   * documented no-op but whose batch-preparation V1 rejects — V1 builds its batch
   * plan eagerly and raises where the payload has nothing to lower — surfaces that
   * same rejection here, so the array path stays byte-identical to V1. The
   * operation carries this semantics; the executor only invokes the hook.
   */
  assertBatchPreparable?(): void;
  /**
   * The payload this operation VALIDATED, as the schema layer left it: shorthands
   * expanded, defaults applied, and operand callbacks already resolved to the
   * field reference or SQL fragment they returned.
   *
   * The cache flow keys on this and never on the caller's raw payload — a
   * payload carrying a callback has no stable serialization until validation has
   * run it, and two spellings of the same comparison must land on one key.
   * Present on the read families, which are the only cacheable operations
   * ({@link file://../cache-flow.ts}); a caller that asks any other
   * operation for it gets a loud refusal rather than a raw-payload fallback.
   */
  readonly validatedArgs?: Record<string, unknown>;
}

interface BatchEntry {
  readonly statement: Sql;
  readonly step?: StatementStep;
  readonly guard?: GuardStep;
  readonly guardProbe?: Sql;
}

/**
 * A compiled atomic unit: the materialized entries plus the values threaded
 * through compilation and reused for output assembly. Shaped as a value so a
 * future `$transaction([...])` path can pull entries out of several operations
 * and merge them into one driver batch — the envelope is not privately owned.
 */
interface AtomicPlan {
  readonly fragment: OperationFragment;
  readonly entries: readonly BatchEntry[];
  readonly values: RuntimeValues;
}

/** A single-statement operation's compiled plan (PLAN P5 item 2b seam). */
export interface SingleStatementPlan {
  readonly fragment: OperationFragment;
  readonly step: StatementStep;
}

export class OperationExecutor {
  private readonly engine: QueryEngine;

  constructor(engine: QueryEngine) {
    this.engine = engine;
  }

  execute<T>(
    operation: ExecutableOperation,
    context: QueryExecutionContext,
    driverOverride?: AnyDriver
  ): Promise<T> {
    // A caller-supplied driver is already inside its own atomic scope (the
    // client's callback-transaction seam); run the fragments on it linearly
    // rather than opening a second envelope.
    if (driverOverride) {
      return this.runLinearOn<T>(operation, context, driverOverride);
    }
    const driver = this.engine.driver;
    // A STATEMENT-ATOMIC operation runs directly with NO transaction/batch
    // envelope on any driver — this is V1's `atomicity: "statement"`
    // (`OperationRuntime`, which runs a one-step program through `executeLinear`
    // with no `withTransaction`). It is one plain read/write statement: empty
    // planning, exactly one non-guard step whose SQL carries no unresolved
    // reference, insert-id scratch, or savepoint skip effect. A postcondition is
    // permitted and enforced in JS after the single round-trip, with no partial
    // state to roll back (the statement either committed its one row or affected
    // none). This covers both the single-SELECT read case (one SELECT, not
    // BEGIN+SELECT+COMMIT) and the returning-driver folded-mutation case (one
    // `… RETURNING` statement), which is what closes the write-path regression
    // PERF.md P5 named — the decision is a structural property of the fragment,
    // never the payload's kind. The plan is computed once here and executed
    // directly (no re-plan/compile/validate/materialize round), so the fast path
    // adds no per-call overhead beyond the single statement it runs.
    const atomicPlan = this.statementAtomicPlan(operation);
    if (atomicPlan) {
      return this.runStatementAtomic<T>(atomicPlan, operation, driver, context);
    }
    // A driver with neither an atomic transaction nor an atomic batch cannot run
    // a MULTI-statement operation — fail closed with V1's byte-identical error.
    if (!(driver.supportsTransactions || driver.supportsBatch)) {
      return Promise.reject(
        noAtomicSubstrateError(driver.driverName, context.operation ?? "query")
      );
    }
    if (operation.mode === "transaction") {
      return this.runTransaction<T>(operation, context);
    }
    return this.runAtomicBatch<T>(operation, context);
  }

  private runTransaction<T>(
    operation: ExecutableOperation,
    context: QueryExecutionContext
  ): Promise<T> {
    return this.engine.driver.withTransaction(
      (driver) => this.runLinearOn<T>(operation, context, driver),
      undefined,
      context
    );
  }

  private async runLinearOn<T>(
    operation: ExecutableOperation,
    context: QueryExecutionContext,
    driver: AnyDriver
  ): Promise<T> {
    const planning = operation.planning();
    validateFragment(planning);
    const planningOutputs = await this.executeLinear(
      planning,
      driver,
      new Map(),
      context
    );
    const fragment = operation.compile(planningOutputs);
    validateFragment(fragment);
    const outputs = await this.executeLinear(
      fragment,
      driver,
      new Map(),
      context
    );
    return operation.parse<T>(outputs);
  }

  private async runAtomicBatch<T>(
    operation: ExecutableOperation,
    context: QueryExecutionContext
  ): Promise<T> {
    const plan = await this.buildAtomicPlan(
      operation,
      this.engine.driver,
      context
    );
    const outputs = await this.executeEntries(
      plan,
      this.engine.driver,
      context
    );
    return operation.parse<T>(outputs);
  }

  /**
   * The `prepareBatch` seam of the PendingOperation contract (PLAN P1.5): run
   * planning, compile the taken fragment, and RETURN the atomic-batch entries
   * plus a `parseResult` closure — consumable by the client's shared batch
   * protocol (the `$transaction([...])` array path), which merges entries from
   * several operations into one driver batch. It never executes them itself.
   */
  async prepareBatch<T>(
    operation: ExecutableOperation,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<{
    readonly queries: readonly Sql[];
    parseResult(results: readonly QueryResult<unknown>[]): T;
  }> {
    operation.assertBatchPreparable?.();
    const plan = await this.buildAtomicPlan(operation, driver, context);
    return {
      queries: plan.entries.map((entry) => entry.statement),
      parseResult: (results) =>
        operation.parse<T>(assembleOutputs(plan, results)),
    };
  }

  /**
   * The `$transaction([...])` array seam (PLAN P5 item 2c): lower this operation
   * into a {@link PreparedBatchOperation} the client's **shared batch protocol**
   * merges with other pending operations into ONE driver batch. It exposes the
   * body queries, the guard index map (re-attributed by the client at the merge
   * offset), and a `parseResult` closure — the exact shape V1's batch runtime
   * returns, so a mixed V1/V2 array batches through one uniform path. A fragment
   * that threads an `insertId` across a write boundary (a DB-generated identity
   * a later step consumes — a generated-PK row whose produced id feeds another
   * write, including a junction row referencing it) uses per-operation scratch
   * state the shared merged batch cannot isolate — it FAILS CLOSED with the
   * typed refusal below rather than emit a colliding batch. Such an operation
   * runs through its own atomic unit (`execute`), never the shared-batch merge,
   * on batch-only drivers.
   */
  async prepareSharedBatch<T>(
    operation: ExecutableOperation,
    driver: AnyDriver,
    context: QueryExecutionContext,
    operationName: Operation
  ): Promise<PreparedBatchOperation<T>> {
    operation.assertBatchPreparable?.();
    const plan = await this.buildAtomicPlan(operation, driver, context);
    if (plan.entries.some((entry) => stepUsesInsertIdScratch(entry.step))) {
      throw new TransactionError(
        "query-engine-v2 cannot merge an insertId-scratch operation into a shared driver batch."
      );
    }
    const queries: PreparedQuery[] = plan.entries.map((entry) =>
      prepareBatchQuery(entry.statement, driver, context)
    );
    const guards: PreparedBatchGuard[] = [];
    plan.entries.forEach((entry, queryIndex) => {
      if (!(entry.guard && entry.guardProbe)) return;
      guards.push({
        queryIndex,
        premise: entry.guard.premise.kind,
        probe: entry.guardProbe,
        failure: entry.guard.failure,
        model: context.model ?? "record",
        operation: operationName,
      });
    });
    return {
      queries,
      guards,
      parseResult: (results) =>
        operation.parse<T>(assembleOutputs(plan, results)),
    };
  }

  /**
   * A statement-atomic operation runs directly on the base driver with no atomic
   * envelope (V1's `atomicity: "statement"`). It is one plain read/write step:
   * empty planning, exactly one non-guard step whose SQL carries no unresolved
   * reference, insert-id scratch, or savepoint skip effect. Unlike
   * {@link singleStatementPlan} it PERMITS a postcondition — enforced in JS by
   * `enforcePostcondition` after the single round-trip, with no partial state to
   * roll back (a `… RETURNING` mutation either affected its one row or none). The
   * skip effect is excluded because it needs a savepoint scope the bare path has
   * no envelope for. Returns the compiled plan (already validated) so the caller
   * runs it without a second plan/compile/validate pass — `undefined` means the
   * operation is multi-statement and takes the atomic-envelope path.
   */
  private statementAtomicPlan(
    operation: ExecutableOperation
  ): SingleStatementPlan | undefined {
    if (operation.planning().steps.length > 0) return undefined;
    const fragment = operation.compile({});
    if (fragment.steps.length !== 1) return undefined;
    const [step] = fragment.steps;
    if (!step || step.kind === "guard") return undefined;
    if (step.kind === "write" && step.onUniqueConflict) return undefined;
    if (!isSql(step.statement)) return undefined;
    if (step.statement.values.some(isOperationValueReference)) return undefined;
    if (stepUsesInsertIdScratch(step)) return undefined;
    validateFragment(fragment);
    return { fragment, step };
  }

  /**
   * Execute one already-compiled statement-atomic plan directly: a single
   * round-trip on the base driver, its JS postcondition enforced after (no
   * partial state to roll back), the fragment's outputs assembled and parsed. The
   * statement carries no unresolved reference (checked in {@link
   * statementAtomicPlan}), so it runs as-is with no materialization pass.
   */
  private async runStatementAtomic<T>(
    plan: SingleStatementPlan,
    operation: ExecutableOperation,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<T> {
    const { step } = plan;
    const result = await this.executeStatement(
      step,
      step.statement,
      driver,
      context
    );
    assertNormalizedQueryResult(result, {
      provider: driver.driverName,
      operation: step.id,
    });
    enforcePostcondition(step, result, context);
    const values: RuntimeValues = new Map([
      [step.id, extractOutputs(step, result)],
    ]);
    return operation.parse<T>(resolveFragmentOutputs(plan.fragment, values));
  }

  /**
   * The single-statement seam (PLAN P5 item 2b): if this operation is one plain
   * statement — empty planning, exactly one read/write step with no guard,
   * postcondition, skip effect, unresolved reference, or insert-id scratch — return
   * its compiled plan so the caller can expose it through `prepare()` (the cache
   * flow's single-statement path, and the array-batch "single" fast path).
   * Otherwise `undefined`: the operation runs through the atomic-batch seam.
   */
  singleStatementPlan(
    operation: ExecutableOperation
  ): SingleStatementPlan | undefined {
    if (operation.planning().steps.length > 0) return undefined;
    const fragment = operation.compile({});
    if (fragment.steps.length !== 1) return undefined;
    const [step] = fragment.steps;
    if (!step || step.kind === "guard") return undefined;
    if (
      step.expects ||
      (step.kind === "write" && step.onUniqueConflict)
    ) {
      return undefined;
    }
    if (!isSql(step.statement)) return undefined;
    if (step.statement.values.some(isOperationValueReference)) return undefined;
    if (stepUsesInsertIdScratch(step)) return undefined;
    validateFragment(fragment);
    return { fragment, step };
  }

  /** Prepare the single statement's driver query with the operation's context. */
  prepareSingleStatement(
    plan: SingleStatementPlan,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): PreparedQuery {
    return prepareBatchQuery(plan.step.statement, driver, context);
  }

  /** Parse one statement's raw result into the operation's public shape. */
  parseSingleStatement<T>(
    operation: ExecutableOperation,
    plan: SingleStatementPlan,
    raw: { rows: unknown[]; rowCount: number }
  ): T {
    const result: QueryResult<unknown> = {
      rows: raw.rows,
      rowCount: raw.rowCount,
    };
    const values: RuntimeValues = new Map([
      [plan.step.id, extractOutputs(plan.step, result)],
    ]);
    return operation.parse<T>(resolveFragmentOutputs(plan.fragment, values));
  }

  private async buildAtomicPlan(
    operation: ExecutableOperation,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<AtomicPlan> {
    const planning = operation.planning();
    validateFragment(planning);
    const planningOutputs = await this.executePlanningLevels(
      planning,
      driver,
      context
    );
    const fragment = operation.compile(planningOutputs);
    validateFragment(fragment);
    return this.compileToEntries(fragment);
  }

  /**
   * PLAN Phase 6.1 — the planning half of "reduce the round trips on batch-only
   * drivers". The compiled writes already ride ONE atomic batch; the planning
   * reads used to ride one `_execute` each, so a tree's planning cost grew with
   * its fan-out — six round trips for four sibling targets.
   *
   * Only a technique-#1 REFERENCE orders one planning read against another (a
   * correlated probe whose parameter is the locate's output, `RelationLinkPart`).
   * Reads that reference nothing of each other's are independent by construction,
   * so they can share one round trip. Grouping by dependency LEVEL makes planning
   * cost one round trip per level rather than one per read, and the total stops
   * growing with the fan-out: four siblings drop from six trips to three.
   *
   * A level of ONE read stays on the per-statement path — there is nothing to
   * group, and routing it through the batch seam would change the call shape of
   * the overwhelmingly common single-locate plan for no saving.
   *
   * Only the ATOMIC-BATCH path plans this way. {@link runLinearOn} — transaction
   * mode, and the caller-supplied driver already inside its own scope — keeps the
   * sequential path: its probes take a row lock on an OPEN transaction handle,
   * and it is not the substrate whose round trips this phase exists to lower.
   *
   * Grouping reads is a strengthening, not a weakening: several reads in one
   * atomic batch see ONE snapshot where several `_execute` calls saw several.
   */
  private async executePlanningLevels(
    fragment: PlanningFragment,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<Readonly<Record<string, unknown>>> {
    const reads: ReadStep[] = [];
    for (const step of fragment.steps) {
      // Grouping is for planning READS. Anything else hands the WHOLE fragment
      // back to the linear executor rather than teaching this pass a second
      // spelling of its handling: a guard has no lowering outside the atomic
      // unit and raises the refusal below, and a write's savepoint skip effect
      // and racePin classification live on the per-statement path.
      if (step.kind !== "read") {
        return this.executeLinear(fragment, driver, new Map(), context);
      }
      reads.push(step);
    }
    const values: RuntimeValues = new Map();
    for (const level of planningLevels(reads)) {
      const [only] = level;
      if (only && level.length === 1) {
        await this.runLinearStep(only, driver, values, context);
        continue;
      }
      await this.runPlanningLevel(level, driver, values, context);
    }
    return resolveFragmentOutputs(fragment, values);
  }

  /**
   * One dependency level of independent planning reads through ONE driver batch.
   * Each read's postcondition is enforced afterwards, in step order, so the
   * first failing read raises the same typed failure it raises sequentially —
   * the only difference is that its independent siblings also ran, and a read
   * has nothing to undo.
   */
  private async runPlanningLevel(
    level: readonly ReadStep[],
    driver: AnyDriver,
    values: RuntimeValues,
    context: QueryExecutionContext
  ): Promise<void> {
    const queries = level.map((step) =>
      driver._prepare(materializeLinearSql(step.statement, values))
    );
    const results = await driver._executeBatch(queries, undefined, context);
    assertNormalizedBatchResults(results, level.length, {
      provider: driver.driverName,
      operation: "query-engine-v2",
    });
    for (const [index, step] of level.entries()) {
      const result = results[index];
      if (!result) continue;
      enforcePostcondition(step, result, context);
      values.set(step.id, extractOutputs(step, result));
    }
  }

  private async executeLinear(
    fragment: OperationFragment,
    driver: AnyDriver,
    values: RuntimeValues,
    context: QueryExecutionContext
  ): Promise<Readonly<Record<string, unknown>>> {
    for (const step of fragment.steps) {
      await this.runLinearStep(step, driver, values, context);
    }
    return resolveFragmentOutputs(fragment, values);
  }

  /** One step on its own round trip, its output threaded into `values`. */
  private async runLinearStep(
    step: OperationStep,
    driver: AnyDriver,
    values: RuntimeValues,
    context: QueryExecutionContext
  ): Promise<void> {
    if (step.kind === "guard") {
      throw new QueryEngineError(
        `Guard step '${step.id}' requires atomic batch execution.`
      );
    }
    const statement = materializeLinearSql(step.statement, values);
    // A write carrying the census `onUniqueConflict: "skip"` effect (ATOM §8)
    // runs behind a savepoint: a unique violation is absorbed as a zero-row
    // result rather than aborting the surrounding atomic scope (V1's
    // `executeSkippableWrite`). This is a generic executor effect — no
    // operation-kind knowledge — so any step declaring it is served identically.
    const result = await this.executeStatement(
      step,
      statement,
      driver,
      context
    );
    assertNormalizedQueryResult(result, {
      provider: driver.driverName,
      operation: step.id,
    });
    enforcePostcondition(step, result, context);
    values.set(step.id, extractOutputs(step, result));
  }

  /**
   * Execute one materialized statement, classifying a race against the step's
   * `racePin` (ATOM §1) so the retry layer **above** the executor (the routed
   * `PendingOperation` lifecycle, PLAN P5 item 2f) can retry a matched
   * insert-branch loser. The marking is invisible — the surfaced error is the
   * same typed `UniqueConstraintError` a non-retrying caller would see.
   */
  private async executeStatement(
    step: StatementStep,
    statement: Sql,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<QueryResult<unknown>> {
    try {
      if (step.kind === "write" && step.onUniqueConflict === "skip") {
        return await executeSkippableWrite(driver, statement, context);
      }
      return await driver._execute(statement, context);
    } catch (error) {
      if (step.kind === "write" && step.racePin) {
        markRaceIfPinned(error, step.racePin);
      }
      throw error;
    }
  }

  /** Compile-to-entries half: lower a fragment into a runnable atomic unit. */
  private compileToEntries(fragment: OperationFragment): AtomicPlan {
    const values: RuntimeValues = new Map();
    const batchId = `operation_${createCorrelationId()}`;
    const batchEntries: BatchEntry[] = [];
    let nextReference = 0;
    let usesScratch = false;

    for (const step of fragment.steps) {
      if (step.kind === "guard") {
        const probe = materializeBatchSql(step.premise.statement, values);
        const statement =
          step.premise.kind === "exists"
            ? this.engine.adapter.assertions.exists(probe)
            : this.engine.adapter.assertions.notExists(probe);
        batchEntries.push({ statement, guard: step, guardProbe: probe });
        continue;
      }

      if (step.expects) {
        // Batch lowering of postconditions is later-phase work. A step carrying
        // one must fail closed here — never a silent skip (ATOM §1).
        throw new QueryEngineError(
          `Step '${step.id}' carries a postcondition that is not yet enforced in batch mode.`
        );
      }

      if (step.kind === "write" && step.onUniqueConflict === "skip") {
        // The savepoint-wrapped skip effect (ATOM §8) has no lowering to a plain
        // atomic batch — a batch is one indivisible unit, so a per-row rollback
        // is not expressible. Fail closed rather than silently propagate the
        // violation and abort the whole batch (the recorded batch disposition).
        throw new QueryEngineError(
          `Step '${step.id}' carries an onUniqueConflict skip effect that has no atomic-batch lowering.`
        );
      }

      batchEntries.push({
        statement: materializeBatchSql(step.statement, values),
        step,
      });
      for (const [output, source] of Object.entries(step.outputs)) {
        if (source.kind !== "insertId") continue;
        usesScratch = true;
        const key = `ref_${nextReference}`;
        nextReference += 1;
        setRuntimeValue(
          values,
          step.id,
          output,
          this.engine.adapter.batchRefs.read(batchId, key)
        );
        batchEntries.push({
          statement: this.engine.adapter.batchRefs.storeLastInsertId(
            batchId,
            key
          ),
        });
      }
    }

    return {
      fragment,
      entries: buildBatchEntries(
        batchEntries,
        this.engine.adapter,
        batchId,
        usesScratch
      ),
      values,
    };
  }

  /** Execute-entries half: run the atomic unit and assemble declared outputs. */
  private async executeEntries(
    plan: AtomicPlan,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<Readonly<Record<string, unknown>>> {
    const { entries } = plan;
    const queries = entries.map((entry) => driver._prepare(entry.statement));

    let results: QueryResult<unknown>[];
    try {
      results = await driver._executeBatch(queries, undefined, context);
    } catch (rawError) {
      const error = await attributeGuardFailure(
        rawError,
        entries,
        driver,
        context
      );
      // An insert-branch loser inside the atomic unit surfaces its pinned unique
      // violation; classify it against any racePin so the retry layer above the
      // executor converges (V1 parity, PLAN P5 item 2f). The batch is one unit,
      // so the failing entry is not individually reported — match the error
      // against every racePin the plan carries (there is one per insert branch).
      if (error instanceof UniqueConstraintError) {
        for (const entry of entries) {
          const pin =
            entry.step?.kind === "write" ? entry.step.racePin : undefined;
          if (pin && racePinMatches(error, pin)) {
            markRaceable(error);
            break;
          }
        }
      }
      throw error;
    }
    assertNormalizedBatchResults(results, entries.length, {
      provider: driver.driverName,
      operation: "query-engine-v2",
    });
    return assembleOutputs(plan, results);
  }
}

/**
 * Assemble a fragment's declared outputs from one atomic batch's results —
 * shared by the executed path and the `prepareBatch` seam so a returned plan
 * parses identically to an executed one.
 */
function assembleOutputs(
  plan: AtomicPlan,
  results: readonly QueryResult<unknown>[]
): Readonly<Record<string, unknown>> {
  const { fragment, entries, values } = plan;
  for (let index = 0; index < entries.length; index += 1) {
    const step = entries[index]?.step;
    const result = results[index];
    if (!(step && result)) continue;
    mergeBatchOutputs(step, result, values);
  }
  return resolveFragmentOutputs(fragment, values);
}

/**
 * Split planning reads into dependency LEVELS: level 0 is every read that
 * references nothing this fragment produces, level N every read whose deepest
 * referenced producer sits at level N-1. Reads inside one level are independent
 * of each other by construction — a technique-#1 reference is the ONLY thing
 * that orders one planning read against another — so they may share one round
 * trip, and the levels themselves run in order because a later level's
 * parameters are literally the earlier level's outputs.
 *
 * Levels fill contiguously: a step reaches level N only by referencing a
 * producer at level N-1, so bucket N-1 exists before bucket N is created.
 */
function planningLevels(
  reads: readonly ReadStep[]
): readonly (readonly ReadStep[])[] {
  const levelOf = new Map<string, number>();
  const levels: ReadStep[][] = [];
  for (const step of reads) {
    const level = planningLevel(step, levelOf, levels.length);
    const bucket = levels[level];
    if (bucket) bucket.push(step);
    else levels.push([step]);
    levelOf.set(step.id, level);
  }
  return levels;
}

function planningLevel(
  step: ReadStep,
  levelOf: ReadonlyMap<string, number>,
  unorderableLevel: number
): number {
  let level = 0;
  for (const value of step.statement.values) {
    if (!isOperationValueReference(value)) continue;
    const producer = levelOf.get(value.step);
    // A reference this pass cannot place — a producer the fragment does not
    // carry — is not something grouping may guess at. Keep the step strictly
    // after everything placed so far, which is a level of its own: it then runs
    // alone and materialization raises the same unresolved-reference error it
    // raises today, from the same place.
    if (producer === undefined) return unorderableLevel;
    level = Math.max(level, producer + 1);
  }
  return level;
}

function stepUsesInsertIdScratch(step: StatementStep | undefined): boolean {
  if (!step) return false;
  return Object.values(step.outputs).some(
    (source) => source.kind === "insertId"
  );
}

function prepareBatchQuery(
  statement: Sql,
  driver: AnyDriver,
  context: QueryExecutionContext
): PreparedQuery {
  const prepared = driver._prepare(statement);
  return { sql: prepared.sql, params: prepared.params ?? [], context };
}

function enforcePostcondition(
  step: StatementStep,
  result: QueryResult<unknown>,
  context: QueryExecutionContext
): void {
  const expects = step.expects;
  if (!expects) return;
  if (expects.kind === "exactlyOneRow") {
    if (result.rows.length !== 1) {
      throw failureError(expects.failure, context);
    }
    return;
  }
  const satisfied =
    typeof expects.expected === "number"
      ? result.rowCount === expects.expected
      : result.rowCount >= expects.expected.min;
  if (!satisfied) {
    throw failureError(expects.failure, context);
  }
}

function failureError(failure: Failure, context: QueryExecutionContext): Error {
  if (failure.kind === "nestedWrite") {
    const error = new NestedWriteError(failure.message, failure.relation ?? "");
    if (failure.raceable) error.meta.raceable = true;
    return error;
  }
  if (failure.kind === "notFound") {
    return new NotFoundError(
      context.model ?? "record",
      context.operation ?? "query"
    );
  }
  const error = new TransactionError(failure.message, {
    meta: {
      model: context.model ?? "record",
      operation: context.operation ?? "query",
    },
  });
  // A `query` guard abort can be raceable too — the sole producer is the
  // retained notExists skip-premise pin (`raceableQueryFailure`, ATOM §2). The
  // mark is what lets the routed retry re-plan and converge; dropping it here
  // strands the flag the fragment validator required.
  if (failure.raceable) error.meta.raceable = true;
  return error;
}

function materializeLinearSql(statement: Sql, values: RuntimeValues): Sql {
  return new Sql(
    statement.strings,
    statement.values.map((value) => {
      if (!isOperationValueReference(value)) return value;
      const resolved = resolveRuntimeValue(value, values);
      if (isSql(resolved)) {
        throw new QueryEngineError(
          `Operation reference '${value.step}.${value.output}' is not a concrete runtime value.`
        );
      }
      // An OPTIONAL `firstRowField` whose read matched no row is the ONE source
      // that resolves to `undefined` — every other source either produces a value
      // or fails the operation closed in `extractOutput`/`resolveRuntimeValue`
      // before reaching a bind. Its absence has a meaning, and the meaning is SQL
      // NULL: "no row, so this correlated read must match nothing" (`= NULL` is
      // never true). Saying so here is what makes the untaken arm of a two-arm
      // write's superset planning (ATOM §3 technique 2) behave identically on
      // every driver — eight of nine binders coerce `undefined` to NULL, mysql2
      // rejects it outright — so the semantics live in the engine, not in one
      // driver.
      return resolved ?? null;
    })
  );
}

function materializeBatchSql(statement: Sql, values: RuntimeValues): Sql {
  return new Sql(
    statement.strings,
    statement.values.map((value) =>
      isOperationValueReference(value)
        ? resolveRuntimeValue(value, values)
        : value
    )
  );
}

function extractOutputs(
  step: StatementStep,
  result: QueryResult<unknown>
): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  // A write whose skip effect (ATOM §8) ABSORBED a unique violation made no row, so it
  // produced no insert id: `executeSkippableWrite` yields the zero-row result and the
  // driver reports nothing to read. That absence is the skip itself, not a driver failure,
  // so the declared output resolves to `undefined` and the consumer decides from the row
  // count — the only thing that says the skip happened (E6.9). Every OTHER absent insert
  // id still fails closed below, and no `Ref` can reach this value: it crosses into
  // `compile` as data, where a zero row count is checked first.
  const skipped =
    step.kind === "write" &&
    step.onUniqueConflict === "skip" &&
    result.rowCount === 0;
  for (const [name, source] of Object.entries(step.outputs)) {
    if (skipped && source.kind === "insertId") {
      outputs.set(name, undefined);
      continue;
    }
    outputs.set(name, extractOutput(step.id, source, result));
  }
  return outputs;
}

function extractOutput(
  step: string,
  source: StatementOutputSource,
  result: QueryResult<unknown>
): unknown {
  if (source.kind === "rows") return result.rows;
  if (source.kind === "rowCount") return result.rowCount;
  if (source.kind === "insertId") {
    if (result.insertId === undefined) {
      throw new TransactionError(
        `Step '${step}' did not produce an insert id.`
      );
    }
    return result.insertId;
  }
  const row = result.rows[0];
  if (
    !(isRecord(row) && Object.hasOwn(row, source.field)) ||
    row[source.field] === undefined
  ) {
    // An `optional` firstRowField tolerates an empty result: a planning read whose
    // missing row is a legitimate branch has no compiled consumer for the value, so
    // resolve it to `undefined` instead of aborting the linear pass (T4c).
    if (source.kind === "firstRowField" && source.optional) return undefined;
    throw new TransactionError(
      `Step '${step}' did not produce row field '${source.field}'.`
    );
  }
  return row[source.field];
}

function mergeBatchOutputs(
  step: StatementStep,
  result: QueryResult<unknown>,
  values: RuntimeValues
): void {
  for (const [name, source] of Object.entries(step.outputs)) {
    if (source.kind === "insertId" && result.insertId === undefined) {
      const existing = values.get(step.id)?.get(name);
      if (isSql(existing)) continue;
    }
    setRuntimeValue(
      values,
      step.id,
      name,
      extractOutput(step.id, source, result)
    );
  }
}

function resolveFragmentOutputs(
  fragment: OperationFragment,
  values: RuntimeValues
): Readonly<Record<string, unknown>> {
  const outputs: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(fragment.outputs)) {
    outputs[name] = isReferenceList(source)
      ? resolveOutputList(name, source, values)
      : resolveSingleOutput(name, source, values);
  }
  return outputs;
}

function isReferenceList(
  source: FragmentOutputSource
): source is readonly OperationValueReference[] {
  return Array.isArray(source);
}

function resolveSingleOutput(
  name: string,
  reference: OperationValueReference,
  values: RuntimeValues
): unknown {
  const value = resolveRuntimeValue(reference, values);
  if (isSql(value) || isOperationValueReference(value)) {
    throw new QueryEngineError(
      `Fragment output '${name}' did not resolve to a runtime value.`
    );
  }
  return value;
}

/**
 * An ordered list of refs resolves by concatenating rows or summing counts
 * (ATOM §1). The list is homogeneous: mixing row and count sources is a typed
 * error, never a silent coercion.
 */
function resolveOutputList(
  name: string,
  references: readonly OperationValueReference[],
  values: RuntimeValues
): unknown {
  const resolved = references.map((reference) =>
    resolveSingleOutput(name, reference, values)
  );
  if (resolved.every(Array.isArray)) {
    return resolved.flat();
  }
  if (resolved.every((value) => typeof value === "number")) {
    return (resolved as number[]).reduce((sum, value) => sum + value, 0);
  }
  if (resolved.every((value) => typeof value === "bigint")) {
    return (resolved as bigint[]).reduce((sum, value) => sum + value, 0n);
  }
  throw new QueryEngineError(
    `Fragment output '${name}' names sources that neither all concatenate as rows nor all sum as counts.`
  );
}

function resolveRuntimeValue(
  reference: OperationValueReference,
  values: RuntimeValues
): unknown {
  const outputs = values.get(reference.step);
  if (!outputs?.has(reference.output)) {
    throw new QueryEngineError(
      `Operation reference '${reference.step}.${reference.output}' is unresolved.`
    );
  }
  return outputs.get(reference.output);
}

function setRuntimeValue(
  values: RuntimeValues,
  step: string,
  output: string,
  value: unknown
): void {
  let outputs = values.get(step);
  if (!outputs) {
    outputs = new Map();
    values.set(step, outputs);
  }
  outputs.set(output, value);
}

function buildBatchEntries(
  entries: BatchEntry[],
  adapter: QueryEngine["adapter"],
  batchId: string,
  usesScratch: boolean
): BatchEntry[] {
  if (!usesScratch) return entries;
  return [
    ...adapter.batchRefs.setup(batchId).map((statement) => ({ statement })),
    { statement: adapter.batchRefs.clear(batchId) },
    ...entries,
    { statement: adapter.batchRefs.cleanup(batchId) },
  ];
}

async function attributeGuardFailure(
  error: unknown,
  entries: readonly BatchEntry[],
  driver: AnyDriver,
  context: QueryExecutionContext
): Promise<unknown> {
  if (!(error instanceof NestedWriteAssertionError)) return error;
  const statementIndex = error.meta.statementIndex;
  if (typeof statementIndex === "number") {
    const guard = entries[statementIndex]?.guard;
    return guard ? failureError(guard.failure, context) : error;
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
    if (!holds) return failureError(entry.guard.failure, context);
  }
  // The step-4 floor (V1's `attributeOperationBatchError`, ported): a
  // NestedWriteAssertionError with NO guard to attribute or re-probe against — a
  // guard-free write ladder (a fragment carrying no premise) — surfaces the typed
  // non-raceable V7006 floor, never a bare NestedWriteAssertionError leaking out.
  // When guards exist but none held false, the abort is genuinely un-attributable
  // among them: keep the raw error.
  if (entries.some((entry) => entry.guard)) return error;
  return new NestedWriteError(NESTED_WRITE_ASSERTION_FLOOR_MESSAGE, "", {
    code: VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED,
    cause: error,
  });
}
