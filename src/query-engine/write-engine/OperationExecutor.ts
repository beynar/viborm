// biome-ignore-all lint/style/useFilenamingConvention: OperationExecutor is the architecture name.
import type { AnyDriver, QueryExecutionContext, QueryResult } from "@drivers";
import {
  assertStatementBindParameterCapacity,
  normalizedBindParameterLimit,
} from "@drivers/bind-parameter-capacity";
import {
  type ConsumableResultCandidate,
  executeConsumableResultCandidate,
} from "@drivers/consumable-result-candidate";
import { attachCommitCertainty } from "@drivers/driver-error-context";
import {
  bindExecutionTransactionPhases,
  getExecutionExtensionChain,
  getExecutionInstrumentation,
} from "@drivers/execution-context";
import {
  assertNormalizedBatchResults,
  assertNormalizedQueryResult,
} from "@drivers/normalized-result";
import { transferPreparedStatement } from "@drivers/prepared-statement-provenance";
import {
  attachRecordSeriesProgress,
  hasRecordSeriesProgress,
  isVibORMError,
  NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
  NestedWriteAssertionError,
  NestedWriteError,
  QueryEngineError,
  type RecordSeriesProgress,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
  VibORMErrorCode,
} from "@errors";
import { runProtectedObservers } from "@extensions/observation";
import { retainWriteOutcomeFailure } from "@extensions/query";
import {
  ATTR_VIBORM_WRITE_ATOMICITY,
  ATTR_VIBORM_WRITE_COMMIT_OUTCOME,
  ATTR_VIBORM_WRITE_COMMITTED_SEGMENTS,
  ATTR_VIBORM_WRITE_COMMITTED_WRITE_MEMBERS,
  ATTR_VIBORM_WRITE_COMPLETED_MEMBERS,
  ATTR_VIBORM_WRITE_MEMBER_PATH,
  ATTR_VIBORM_WRITE_STATEMENT_COUNT,
  SPAN_RECORD_SERIES_SEGMENT,
} from "@instrumentation";
import { getOfficialInstrumentationChainCapability } from "@instrumentation/extension";
import type {
  InstrumentationLifecycleFactsReader,
  InstrumentationLifecycleOutcome,
  SegmentInstrumentationFacts,
} from "@instrumentation/lifecycle-facts";
import {
  shouldTraceSpan,
  type TracerWrapper,
  type VibORMSpanOptions,
} from "@instrumentation/tracer";
import { isSql, Sql } from "@sql";
import { createCorrelationId } from "../execution-context";
import type { QueryEngine } from "../query-engine";
import type { ResultParser } from "../result/ResultParser";
import type { CompiledRowParser } from "../result/result-row-parser";
import { executeSkippableWrite } from "../skippable-write";
import type {
  ExpectedResultShape,
  Operation,
  PreparedBatchGuard,
  PreparedBatchOperation,
  PreparedQuery,
} from "../types";
import { validateFragment } from "./FragmentValidator";
import {
  crossedReferenceContinuationGuards,
  firstGeneratedOutputDependency,
  type GeneratedOutputSegment,
  generatedOutputSegments,
  statementStepsById,
} from "./generated-output-boundary";

import {
  createFailureError,
  type Failure,
  type FragmentOutputSource,
  type GuardStep,
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type OperationValueReference,
  type PlanningFragment,
  type ReadStep,
  ref,
  type StatementOutputSource,
  type StatementStep,
  statementHasReferences,
  statementOutputReferences,
  statementReferences,
} from "./OperationFragment";
import { planningKey } from "./Part";
import { isRetryableRace, markRaceIfPinned } from "./race-retry";
import {
  isRecordSeries,
  type RecordSeriesOperation,
  type RoutedExecutableOperation,
  type SeriesRootConflictDisposition,
} from "./record-series";
import { isRecord, noAtomicSubstrateError } from "./shared";

type RuntimeValues = Map<string, Map<string, unknown>>;

export type CommittedWriteSegmentNotification = () => Promise<void>;
/** Conservatively invalidate after dispatch when provider acknowledgement is ambiguous. */
export type WriteMayBeVisibleNotification = () => Promise<void>;

interface PreparedResultRowsCapability {
  createResultParser(): ResultParser;
  createExpectedResultShape(): ExpectedResultShape | undefined;
  compileResultRows(
    parser: ResultParser,
    shape: ExpectedResultShape | undefined
  ): CompiledRowParser | undefined;
  parseResultWithProgram<T>(
    outputs: Readonly<Record<string, unknown>>,
    parser: ResultParser,
    shape: ExpectedResultShape | undefined,
    compiled: CompiledRowParser | undefined,
    consumableRows?: unknown[]
  ): T;
}

/** Internal savepoint control flow for a duplicate-skipped series member. */
class SkippedRecordSeriesMember extends Error {}

/**
 * The internal contract the executor drives. The executor knows nothing about
 * what the operation means: it is handed a mode, a planning fragment, a
 * per-branch compiler, and a result parser, and it only runs already-compiled
 * fragments safely. Concrete operations own every semantic decision.
 */
export interface ExecutableOperation {
  readonly mode: "transaction" | "batch";
  readonly preparedResultRows?: PreparedResultRowsCapability;
  /** Exact private disposition for a root INSERT whose duplicate skips its member. */
  readonly seriesRootConflict?: SeriesRootConflictDisposition;
  /**
   * A write this operation's PARSED SHAPE already promises to emit before its
   * root write — the only thing a member that cannot be compiled at preflight can
   * still be asked about its step order. Absent means "the shape declares none",
   * never "there is none": the compiled reader stays the general owner.
   */
  readonly declaredPreRootWriteId?: string;
  planning(): PlanningFragment;
  compile(known: Readonly<Record<string, unknown>>): OperationFragment;
  parse<T>(outputs: Readonly<Record<string, unknown>>): T;
  /**
   * Optional execution-context gate, invoked ONLY on the `$transaction([...])`
   * array batch-preparation seam ({@link prepareSharedBatch}),
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
   * Optional here because nested and synthesized atoms never cross the public
   * routing boundary. {@link RoutedExecutableOperation} strengthens it to a
   * required record for every top-level operation.
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
  readonly skippableRootWriteId?: string;
}

interface AtomicExecutionResult {
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly skippedRoot: boolean;
}

interface ProgressiveMemberPreparation {
  readonly operation: ExecutableOperation;
  readonly planning: PlanningFragment;
  /** Present only when the member has no data-dependent planning phase. */
  readonly compiled?: OperationFragment;
}

interface ProgressiveMemberCommitState {
  writeCommitted: boolean;
}

type ProgressiveSegmentPhase = "prefix" | "member" | "suffix";

/** One validated statement candidate before a caller-specific policy is applied. */
export interface SingleStatementCandidate {
  readonly fragment: OperationFragment;
  readonly step: StatementStep;
}

function compileSingleStatementCandidate(
  operation: ExecutableOperation
): SingleStatementCandidate | undefined {
  if (operation.planning().steps.length > 0) return undefined;
  const fragment = operation.compile({});
  if (fragment.steps.length !== 1) return undefined;
  const [step] = fragment.steps;
  if (!step || step.kind === "guard" || step.kind === "recordSeries") {
    return undefined;
  }
  if (!isSql(step.statement)) return undefined;
  validateFragment(fragment);
  return { fragment, step };
}

function canExecuteDirectly(candidate: SingleStatementCandidate): boolean {
  const { step } = candidate;
  return !(
    (step.kind === "write" && step.onUniqueConflict) ||
    statementHasReferences(step.statement) ||
    stepUsesInsertIdScratch(step)
  );
}

function canPrepareSingle(candidate: SingleStatementCandidate): boolean {
  return canExecuteDirectly(candidate) && candidate.step.expects === undefined;
}

function canBuildStatement(candidate: SingleStatementCandidate): boolean {
  const { step } = candidate;
  return !(
    (step.kind === "write" && step.onUniqueConflict) ||
    statementHasReferences(step.statement)
  );
}

export class OperationExecutor {
  private readonly engine: QueryEngine;
  private readonly consumableResultCandidate:
    | ConsumableResultCandidate
    | undefined;
  private readonly runStatementAtomic: <T>(
    plan: SingleStatementCandidate,
    operation: ExecutableOperation,
    driver: AnyDriver,
    context: QueryExecutionContext,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ) => Promise<T>;

  constructor(
    engine: QueryEngine,
    consumableResultCandidate?: ConsumableResultCandidate
  ) {
    this.engine = engine;
    this.consumableResultCandidate = consumableResultCandidate;
    this.runStatementAtomic = consumableResultCandidate
      ? this.runCandidateStatementAtomic
      : this.runBorrowedStatementAtomic;
  }

  execute<T>(
    operation: ExecutableOperation | RecordSeriesOperation,
    context: QueryExecutionContext,
    driverOverride?: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    // A SERIES has no single planning-then-compilation fragment, so none of the
    // ordinary seams below it may be entered. A transaction-capable driver owns
    // one interactive scope and can retry the complete series. A no-transaction
    // driver with native atomic batches runs guarded progressive segments; it
    // reports a committed prefix and never replays that prefix on retry.
    if (isRecordSeries(operation)) {
      const seriesDriver = driverOverride ?? this.engine.driver;
      if (!seriesDriver.supportsTransactions && seriesDriver.supportsBatch) {
        return this.runProgressiveRecordSeries<T>(
          operation,
          context,
          seriesDriver,
          committedWriteSegment,
          writeMayBeVisible
        );
      }
      setTracerAttributes(progressiveTracer(context), {
        [ATTR_VIBORM_WRITE_ATOMICITY]: "operation",
      });
      return this.runTransactionScope(
        seriesDriver,
        (driver) => this.runRecordSeries<T>(operation, context, driver),
        context,
        committedWriteSegment,
        writeMayBeVisible
      );
    }
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
    const directCandidate = compileSingleStatementCandidate(operation);
    if (directCandidate && canExecuteDirectly(directCandidate)) {
      return this.runStatementAtomic<T>(
        directCandidate,
        operation,
        driver,
        context,
        committedWriteSegment,
        writeMayBeVisible
      );
    }
    // A driver with neither an atomic transaction nor an atomic batch cannot run
    // a MULTI-statement operation — fail closed with V1's byte-identical error.
    if (!(driver.supportsTransactions || driver.supportsBatch)) {
      return Promise.reject(
        noAtomicSubstrateError(driver.driverName, context.operation ?? "query")
      );
    }
    if (operation.mode === "transaction") {
      return this.runTransaction<T>(
        operation,
        context,
        committedWriteSegment,
        writeMayBeVisible
      );
    }
    return this.runAtomicBatch<T>(
      operation,
      context,
      committedWriteSegment,
      writeMayBeVisible
    );
  }

  /**
   * Run one series inside an already-open interactive scope: capture, build every
   * member, run the members one after another on THIS driver, then the result
   * reads, then parse.
   *
   * Members go through {@link execute} with this driver as the override, so each
   * keeps its own planning, compilation, postconditions and race marking. Linear
   * execution admits no guard step — and none can reach it: a guard is a
   * batch-mode lowering, and this scope exists only on a substrate that offers an
   * interactive transaction, which is exactly the substrate on which every member
   * compiles in transaction mode.
   *
   * Nothing here re-runs anything: the routed boundary above the executor owns the
   * one retry, and it retries the COMPLETE series (this capture included) rather
   * than a member on its own — a member that re-ran alone would re-run against
   * state its predecessors have already changed inside this scope.
   */
  private async runRecordSeries<T>(
    operation: RecordSeriesOperation,
    context: QueryExecutionContext,
    driver: AnyDriver,
    inheritedValues: RuntimeValues = new Map()
  ): Promise<T> {
    const capture = materializeExternalFragment(
      operation.capture(),
      inheritedValues
    );
    validateFragment(capture);
    assertOperationFragmentCapacity(
      capture,
      driver,
      normalizedBindParameterLimit(driver.maxBindParametersPerStatement)
    );
    const captured = await this.executeLinear(
      capture,
      driver,
      cloneRuntimeValues(inheritedValues),
      context
    );
    // Every member is BUILT before the first one runs a statement: building is
    // where a member's public envelope is checked, so a shape the engine cannot
    // express is refused while this scope still has nothing to undo.
    const members = operation.compileMembers(captured);
    const memberResults: unknown[] = [];
    for (const member of members) {
      memberResults.push(
        await this.runRecordSeriesMember(
          member,
          context,
          driver,
          inheritedValues
        )
      );
    }
    const resultReads = operation.compileResultReads(captured, memberResults);
    const resultReadResults: unknown[] = [];
    for (const resultRead of resultReads) {
      resultReadResults.push(
        await this.runLinearOn<unknown>(
          resultRead,
          context,
          driver,
          cloneRuntimeValues(inheritedValues)
        )
      );
    }
    const parsed = operation.parseSeries({
      captured,
      memberResults,
      resultReadResults,
    });
    // The series owns its public shape exactly as `parse<T>` does for one
    // fragment; the generic is the caller's expectation of it, not a second
    // opinion the executor could hold.
    return parsed as T;
  }

  /**
   * Execute the existing record-series form as ordered atomic batches. Every
   * batch-only driver can use normalized successful return as the boundary for
   * the next segment. A driver with committed-batch notification additionally
   * gives failures during result decoding exact committed-prefix attribution.
   */
  private async runProgressiveRecordSeries<T>(
    operation: RecordSeriesOperation,
    context: QueryExecutionContext,
    driver: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    const progress: MutableRecordSeriesProgress = {
      committedSegments: 0,
      completedMembers: 0,
      committedWriteMembers: 0,
    };

    try {
      const bindLimit = progressiveBindLimit(driver);
      return await this.runProgressiveRecordSeriesAt<T>(
        operation,
        context,
        driver,
        new Map(),
        [],
        progress,
        [],
        bindLimit,
        committedWriteSegment,
        writeMayBeVisible
      );
    } catch (error) {
      if (hasRecordSeriesProgress(error)) throw error;
      throw attachProgress(error, progress, "planning");
    } finally {
      setProgressiveParentAttributes(progressiveTracer(context), progress);
    }
  }

  /**
   * Run one series at its exact position in an enclosing member. A nested series
   * inherits only already-materialized values from the enclosing prefix. Its own
   * member values stay private because a RecordSeriesStep publishes no output.
   */
  private async runProgressiveRecordSeriesAt<T>(
    operation: RecordSeriesOperation,
    context: QueryExecutionContext,
    driver: AnyDriver,
    inheritedValues: RuntimeValues,
    inheritedGuards: readonly GuardStep[],
    progress: MutableRecordSeriesProgress,
    seriesPath: readonly number[],
    bindLimit: number,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification,
    memberPhase: ProgressiveSegmentPhase = "member"
  ): Promise<T> {
    let captured: Readonly<Record<string, unknown>>;
    try {
      const capture = materializeExternalFragment(
        operation.capture(),
        inheritedValues
      );
      validateFragment(capture);
      if (capture.steps.some((step) => step.kind !== "read")) {
        throw progressiveSeriesRefusal(
          driver,
          "its capture contains a write that cannot be committed before the member set is fixed"
        );
      }
      assertStaticFragmentCapacity(capture, driver, bindLimit);
      captured = await this.executePlanningLevels(capture, driver, context);
    } catch (error) {
      if (hasRecordSeriesProgress(error)) throw error;
      throw attachProgress(error, progress, "capture", seriesPath);
    }

    let preparedMembers: readonly ProgressiveMemberPreparation[];
    try {
      const members = operation.compileMembers(captured);
      if (seriesPath.length === 0) {
        progress.totalMembers = members.length;
      } else {
        // Counters cover the complete depth-first execution once nesting is
        // entered, so a root-only total would no longer describe them.
        progress.totalMembers = undefined;
      }
      preparedMembers = members.map((member) =>
        this.prepareProgressiveMember(
          member,
          inheritedValues,
          driver,
          bindLimit
        )
      );
    } catch (error) {
      if (hasRecordSeriesProgress(error)) throw error;
      throw attachProgress(error, progress, "planning", seriesPath);
    }

    const memberResults: unknown[] = [];
    for (const [index, prepared] of preparedMembers.entries()) {
      memberResults.push(
        await this.runProgressiveRecordSeriesMember(
          prepared,
          context,
          driver,
          inheritedValues,
          inheritedGuards,
          progress,
          [...seriesPath, index],
          bindLimit,
          committedWriteSegment,
          writeMayBeVisible,
          memberPhase
        )
      );
    }

    let resultReadResults: unknown[];
    try {
      const resultReads = operation.compileResultReads(captured, memberResults);
      resultReadResults = [];
      for (const resultRead of resultReads) {
        const prepared = this.prepareProgressiveMember(
          resultRead,
          inheritedValues,
          driver,
          bindLimit
        );
        const fragment = await this.buildProgressiveMemberFragment(
          prepared,
          driver,
          context,
          inheritedValues,
          bindLimit
        );
        if (fragment.steps.some((step) => step.kind === "recordSeries")) {
          throw progressiveSeriesRefusal(
            driver,
            "a final result read unexpectedly contains a nested record series"
          );
        }
        const plan = this.compileToEntries(fragment);
        assertAtomicPlanCapacity(plan, driver, bindLimit);
        if (atomicPlanHasWrite(plan)) {
          throw progressiveSeriesRefusal(
            driver,
            "a final result read unexpectedly contains a write"
          );
        }
        const execution = await this.executeEntries(plan, driver, context);
        resultReadResults.push(resultRead.parse(execution.outputs));
      }
      return operation.parseSeries({
        captured,
        memberResults,
        resultReadResults,
      }) as T;
    } catch (error) {
      if (hasRecordSeriesProgress(error)) throw error;
      throw attachProgress(error, progress, "result", seriesPath);
    }
  }

  private prepareProgressiveMember(
    operation: ExecutableOperation,
    inheritedValues: RuntimeValues,
    driver: AnyDriver,
    bindLimit: number
  ): ProgressiveMemberPreparation {
    const planning = materializeExternalFragment(
      operation.planning(),
      inheritedValues
    );
    validateFragment(planning);
    if (planning.steps.some((step) => step.kind !== "read")) {
      throw progressiveSeriesRefusal(
        driver,
        "a member planning phase contains a write that cannot share the member's atomic batch"
      );
    }
    assertStaticFragmentCapacity(planning, driver, bindLimit);
    if (planning.steps.length !== 0) {
      // This member cannot be compiled here: compiling it needs planning outputs
      // only its own turn can read. Its DECLARED shape can still be read, and
      // that is this reader's entire unique coverage — TIMING. Without it a
      // member that both plans and promises a write before a skippable root
      // takes its root-conflict refusal at member time, after earlier members
      // have durably committed, which is exactly what plan §9.6 forbids by
      // asking for the refusal "before member zero". The compiled reader below
      // stays the general owner of the same invariant for every member it can
      // reach, including the probe-dependent arms a shape cannot promise.
      assertDeclaredRootConflictEligibility(operation, driver);
      return { operation, planning };
    }
    // Empty planning makes compilation independent of predecessor effects.
    // Every such member is compiled during series preflight, before the first
    // segment commit, so a statically knowable capacity refusal cannot strand a
    // durable prefix.
    const compiled = materializeExternalFragment(
      operation.compile({}),
      inheritedValues
    );
    validateFragment(compiled);
    assertStaticFragmentCapacity(compiled, driver, bindLimit);
    assertProgressiveBoundaryEligibility(compiled, driver);
    assertProgressiveRootConflictEligibility(
      compiled,
      operation.seriesRootConflict,
      driver
    );
    assertGeneratedOutputFragmentEligibility(
      compiled,
      driver,
      this.engine.adapter.batchRefs.storeLastInsertId !== undefined,
      operation.seriesRootConflict?.rootWriteId
    );
    return { operation, planning, compiled };
  }

  private async buildProgressiveMemberFragment(
    prepared: ProgressiveMemberPreparation,
    driver: AnyDriver,
    context: QueryExecutionContext,
    inheritedValues: RuntimeValues,
    bindLimit: number
  ): Promise<OperationFragment> {
    if (prepared.compiled) return prepared.compiled;
    const planningOutputs = await this.executePlanningLevels(
      prepared.planning,
      driver,
      context
    );
    const fragment = materializeExternalFragment(
      prepared.operation.compile(planningOutputs),
      inheritedValues
    );
    validateFragment(fragment);
    assertStaticFragmentCapacity(fragment, driver, bindLimit);
    assertProgressiveBoundaryEligibility(fragment, driver);
    assertGeneratedOutputFragmentEligibility(
      fragment,
      driver,
      this.engine.adapter.batchRefs.storeLastInsertId !== undefined,
      prepared.operation.seriesRootConflict?.rootWriteId
    );
    return fragment;
  }

  private async runProgressiveRecordSeriesMember(
    prepared: ProgressiveMemberPreparation,
    context: QueryExecutionContext,
    driver: AnyDriver,
    inheritedValues: RuntimeValues,
    inheritedGuards: readonly GuardStep[],
    progress: MutableRecordSeriesProgress,
    memberPath: readonly number[],
    bindLimit: number,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification,
    fragmentPhase: ProgressiveSegmentPhase = "member"
  ): Promise<unknown> {
    let attemptedCurrentMemberRetry = false;
    while (true) {
      const attemptStartSegments = progress.committedSegments;
      let fragment: OperationFragment;
      try {
        fragment = await this.buildProgressiveMemberFragment(
          prepared,
          driver,
          context,
          inheritedValues,
          bindLimit
        );
      } catch (error) {
        if (
          progress.committedSegments === attemptStartSegments &&
          progress.committedSegments > 0 &&
          !attemptedCurrentMemberRetry &&
          isRetryableRace(error)
        ) {
          attemptedCurrentMemberRetry = true;
          continue;
        }
        if (hasRecordSeriesProgress(error)) throw error;
        throw attachProgress(error, progress, "planning", memberPath);
      }

      try {
        const runtimeValues = cloneRuntimeValues(inheritedValues);
        const commitState: ProgressiveMemberCommitState = {
          writeCommitted: false,
        };
        assertProgressiveRootConflictEligibility(
          fragment,
          prepared.operation.seriesRootConflict,
          driver
        );
        const skipped = await this.executeProgressiveFragment(
          fragment,
          context,
          driver,
          runtimeValues,
          inheritedGuards,
          progress,
          memberPath,
          commitState,
          bindLimit,
          committedWriteSegment,
          writeMayBeVisible,
          fragmentPhase,
          prepared.operation.seriesRootConflict
        );
        if (skipped) {
          progress.completedMembers += 1;
          return { kind: "skipped" as const };
        }
        const outputs = resolveFragmentOutputs(fragment, runtimeValues);
        const result = prepared.operation.parse(outputs);
        progress.completedMembers += 1;
        return result;
      } catch (error) {
        if (hasRecordSeriesProgress(error)) throw error;
        if (
          progress.committedSegments === attemptStartSegments &&
          progress.committedSegments > 0 &&
          !attemptedCurrentMemberRetry &&
          isRetryableRace(error)
        ) {
          attemptedCurrentMemberRetry = true;
          continue;
        }
        throw attachProgress(error, progress, "member", memberPath);
      }
    }
  }

  /**
   * Execute ordinary prefix/suffix fragments as atomic batches and recurse at
   * each RecordSeriesStep. Crossing references are replaced only with concrete
   * outputs already acknowledged by the provider; unresolved or scratch SQL
   * values keep the existing fail-closed materialization error.
   */
  private async executeProgressiveFragment(
    fragment: OperationFragment,
    context: QueryExecutionContext,
    driver: AnyDriver,
    runtimeValues: RuntimeValues,
    inheritedGuards: readonly GuardStep[],
    progress: MutableRecordSeriesProgress,
    memberPath: readonly number[],
    commitState: ProgressiveMemberCommitState,
    bindLimit: number,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification,
    fragmentPhase: ProgressiveSegmentPhase = "member",
    rootConflict?: SeriesRootConflictDisposition
  ): Promise<boolean> {
    let segment: OperationStep[] = [];
    let activeGuards = [...inheritedGuards];
    const statementSteps = statementStepsById(fragment);
    const priorOrdinaryIds = new Set<string>();
    const hasNestedSeries = fragment.steps.some(
      (step) => step.kind === "recordSeries"
    );
    let completedNestedSeries = false;
    const flush = async (): Promise<boolean> => {
      if (segment.length === 0) return false;
      const phase: ProgressiveSegmentPhase = hasNestedSeries
        ? completedNestedSeries
          ? "suffix"
          : "prefix"
        : fragmentPhase;
      const ordinarySteps = segment;
      segment = [];
      const generatedSegments = generatedOutputSegments(
        segmentFragment(ordinarySteps),
        this.engine.adapter.batchRefs.storeLastInsertId !== undefined
      );
      const executionSegments = generatedSegments ?? [
        { steps: ordinarySteps, continuationGuards: [] },
      ];
      if (generatedSegments) {
        assertGeneratedOutputSegmentEligibility(
          generatedSegments,
          driver,
          rootConflict?.rootWriteId
        );
      }
      for (const executionSegment of executionSegments) {
        const crossedOutputGuards = crossedReferenceContinuationGuards(
          executionSegment.steps,
          priorOrdinaryIds,
          statementSteps
        );
        const hasWrite = executionSegment.steps.some(
          (step) => step.kind === "write"
        );
        const continuationGuards = new Map<string, GuardStep>();
        for (const guard of [
          ...crossedOutputGuards,
          ...executionSegment.continuationGuards,
        ]) {
          continuationGuards.set(guard.id, guard);
        }
        const guardedSegment = [
          ...(hasWrite ? activeGuards : []),
          ...continuationGuards.values(),
          ...executionSegment.steps,
        ];
        const materialized = materializeExternalFragment(
          segmentFragment(guardedSegment),
          runtimeValues
        );
        validateFragment(materialized);
        const skippableRootWriteId = executionSegment.steps.some(
          (step) => step.id === rootConflict?.rootWriteId
        )
          ? rootConflict?.rootWriteId
          : undefined;
        const plan = this.compileToEntries(materialized, skippableRootWriteId);
        assertAtomicPlanCapacity(plan, driver, bindLimit);
        try {
          const execution = await this.executeProgressiveAtomicPlan(
            plan,
            context,
            driver,
            progress,
            memberPath,
            commitState,
            committedWriteSegment,
            writeMayBeVisible
          );
          if (execution.skippedRoot) return true;
          mergeRuntimeValues(runtimeValues, plan.values);
        } catch (error) {
          if (error instanceof SkippedRecordSeriesMember) return true;
          if (hasRecordSeriesProgress(error)) throw error;
          if (isRetryableRace(error) && !commitState.writeCommitted) {
            throw error;
          }
          throw attachProgress(error, progress, phase, memberPath);
        }
      }
      for (const step of ordinarySteps) {
        if (step.kind === "read" || step.kind === "write") {
          priorOrdinaryIds.add(step.id);
        }
      }
      return false;
    };

    for (const step of fragment.steps) {
      if (step.kind !== "recordSeries") {
        segment.push(step);
        if (step.id === rootConflict?.rootWriteId && (await flush())) {
          return true;
        }
        continue;
      }
      if (await flush()) return true;
      if (step.progressive.kind === "unsupported") {
        throw progressiveSeriesRefusal(driver, step.progressive.reason);
      }
      activeGuards = [
        ...activeGuards,
        materializeProgressiveGuard(step.progressive.guard, runtimeValues),
      ];
      progress.totalMembers = undefined;
      await this.runProgressiveRecordSeriesAt(
        step.series,
        context,
        driver,
        cloneRuntimeValues(runtimeValues),
        activeGuards,
        progress,
        memberPath,
        bindLimit,
        committedWriteSegment,
        writeMayBeVisible,
        "member"
      );
      completedNestedSeries = true;
    }
    return flush();
  }

  /**
   * Execute one progressive atomic unit with the driver's strongest truthful
   * acknowledgement. A committed-callback driver reports the atomic commit
   * before decoding. A weaker batch driver acknowledges it after a normalized
   * result; a dispatched failure before that boundary remains conservatively
   * visible. Definite invalidation runs at that truthful boundary. Its failure
   * is retained until a normalized zero-row root can be removed from the
   * committed-write-member count.
   */
  private async executeProgressiveAtomicPlan(
    plan: AtomicPlan,
    context: QueryExecutionContext,
    driver: AnyDriver,
    progress: MutableRecordSeriesProgress,
    memberPath: readonly number[],
    commitState: ProgressiveMemberCommitState,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<AtomicExecutionResult> {
    const planHasWrite = atomicPlanHasWrite(plan);
    let segmentCommitted = false;
    let countedCommittedWriteMember = false;
    let invalidationFailed = false;
    let invalidationFailure: unknown;
    let dispatched = false;
    let unacknowledged = false;
    const committed = planHasWrite
      ? async () => {
          if (segmentCommitted) return;
          segmentCommitted = true;
          progress.committedSegments += 1;
          if (!commitState.writeCommitted) {
            commitState.writeCommitted = true;
            progress.committedWriteMembers += 1;
            countedCommittedWriteMember = true;
          }
          try {
            await committedWriteSegment?.();
          } catch (error) {
            invalidationFailed = true;
            invalidationFailure = error;
          }
        }
      : undefined;

    return observeProgressiveSegment(
      context,
      plan,
      memberPath,
      planHasWrite,
      () => segmentCommitted,
      () => unacknowledged,
      async () => {
        try {
          const outputs = await this.executeEntries(
            plan,
            driver,
            context,
            driver.supportsOrderedCommittedSegments ? committed : undefined,
            () => {
              dispatched = true;
            }
          );
          if (planHasWrite && !driver.supportsOrderedCommittedSegments) {
            await committed?.();
          }
          if (
            outputs.skippedRoot &&
            countedCommittedWriteMember &&
            commitState.writeCommitted
          ) {
            commitState.writeCommitted = false;
            progress.committedWriteMembers -= 1;
          }
          if (invalidationFailed) {
            throw attachProgress(
              invalidationFailure,
              progress,
              "invalidation",
              memberPath
            );
          }
          return outputs;
        } catch (error) {
          if (hasRecordSeriesProgress(error)) throw error;
          const segmentRolledBack =
            error instanceof UniqueConstraintError ||
            error instanceof SkippedRecordSeriesMember ||
            isRetryableRace(error);
          if (invalidationFailed) {
            throw attachProgress(
              new AggregateError(
                [error, invalidationFailure],
                "Committed segment decoding and cache invalidation both failed."
              ),
              progress,
              "invalidation",
              memberPath
            );
          }
          if (
            planHasWrite &&
            dispatched &&
            !segmentCommitted &&
            !driver.supportsOrderedCommittedSegments &&
            !segmentRolledBack
          ) {
            unacknowledged = true;
            progress.mayHaveCommittedSegment = true;
            try {
              await writeMayBeVisible?.();
            } catch (invalidationError) {
              throw attachProgress(
                new AggregateError(
                  [error, invalidationError],
                  "Progressive segment outcome and cache invalidation both failed."
                ),
                progress,
                "invalidation",
                memberPath
              );
            }
          }
          throw error;
        }
      }
    );
  }

  private async runRecordSeriesMember(
    member: ExecutableOperation,
    context: QueryExecutionContext,
    driver: AnyDriver,
    inheritedValues: RuntimeValues
  ): Promise<unknown> {
    const rootWriteId = member.seriesRootConflict?.rootWriteId;
    if (!rootWriteId) {
      return this.runLinearOn(
        member,
        context,
        driver,
        cloneRuntimeValues(inheritedValues)
      );
    }
    try {
      const value = await driver.withTransaction(
        (savepointDriver) =>
          this.runLinearOn(
            member,
            context,
            savepointDriver,
            cloneRuntimeValues(inheritedValues),
            rootWriteId
          ),
        undefined,
        context
      );
      return { kind: "inserted" as const, value };
    } catch (error) {
      if (error instanceof SkippedRecordSeriesMember) {
        return { kind: "skipped" as const };
      }
      throw error;
    }
  }

  private runTransaction<T>(
    operation: ExecutableOperation,
    context: QueryExecutionContext,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    return this.runTransactionScope(
      this.engine.driver,
      (driver) => this.runLinearOn<T>(operation, context, driver),
      context,
      committedWriteSegment,
      writeMayBeVisible
    );
  }

  /** Publish one direct transaction's exact durable phase without changing zero path. */
  private async runTransactionScope<T>(
    driver: AnyDriver,
    callback: (driver: AnyDriver) => Promise<T>,
    context: QueryExecutionContext,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    if (!(committedWriteSegment || writeMayBeVisible)) {
      return driver.withTransaction(callback, undefined, context);
    }

    const transactionState: {
      phase: "pending" | "ready" | "committed";
    } = { phase: "pending" };
    const transactionContext = bindExecutionTransactionPhases(context, {
      readyToCommit: () => {
        transactionState.phase = "ready";
      },
      committed: () => {
        transactionState.phase = "committed";
      },
    });
    let transactionResult: T;
    try {
      transactionResult = await driver.withTransaction(
        callback,
        undefined,
        transactionContext
      );
    } catch (error) {
      const certainty =
        transactionState.phase === "committed"
          ? "committed"
          : transactionState.phase === "ready"
            ? "may-have-committed"
            : undefined;
      const primary =
        certainty && isVibORMError(error)
          ? attachCommitCertainty(error, certainty)
          : error;
      const notify =
        transactionState.phase === "committed"
          ? committedWriteSegment
          : transactionState.phase === "ready"
            ? writeMayBeVisible
            : undefined;
      if (notify) {
        try {
          await notify();
        } catch (outcomeFailure) {
          throw retainWriteOutcomeFailure(primary, outcomeFailure);
        }
      }
      throw primary;
    }
    await committedWriteSegment?.();
    return transactionResult;
  }

  private async runLinearOn<T>(
    operation: ExecutableOperation,
    context: QueryExecutionContext,
    driver: AnyDriver,
    inheritedValues: RuntimeValues = new Map(),
    skipRootWriteId?: string
  ): Promise<T> {
    const planning = materializeExternalFragment(
      operation.planning(),
      inheritedValues
    );
    validateFragment(planning);
    assertOperationFragmentCapacity(
      planning,
      driver,
      normalizedBindParameterLimit(driver.maxBindParametersPerStatement)
    );
    const planningOutputs = await this.executeLinear(
      planning,
      driver,
      cloneRuntimeValues(inheritedValues),
      context
    );
    const fragment = materializeExternalFragment(
      operation.compile(planningOutputs),
      inheritedValues
    );
    validateFragment(fragment);
    assertOperationFragmentCapacity(
      fragment,
      driver,
      normalizedBindParameterLimit(driver.maxBindParametersPerStatement)
    );
    const outputs = await this.executeLinear(
      fragment,
      driver,
      cloneRuntimeValues(inheritedValues),
      context,
      skipRootWriteId
    );
    return operation.parse<T>(outputs);
  }

  private async runAtomicBatch<T>(
    operation: ExecutableOperation,
    context: QueryExecutionContext,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    const driver = this.engine.driver;
    const fragment = await this.buildAtomicFragment(operation, driver, context);
    if (
      fragment.steps.some((step) => step.kind === "recordSeries") &&
      !driver.supportsTransactions
    ) {
      return this.runProgressiveFragmentOperation<T>(
        operation,
        fragment,
        context,
        driver,
        committedWriteSegment,
        writeMayBeVisible
      );
    }
    const generatedSegments = generatedOutputSegments(
      fragment,
      this.engine.adapter.batchRefs.storeLastInsertId !== undefined
    );
    if (generatedSegments) {
      return this.runGeneratedOutputFallback<T>(
        operation,
        fragment,
        generatedSegments,
        context,
        driver,
        committedWriteSegment,
        writeMayBeVisible
      );
    }
    const plan = this.compileToEntries(fragment);
    assertOperationPlanCapacity(
      plan,
      driver,
      normalizedBindParameterLimit(driver.maxBindParametersPerStatement)
    );
    const planHasWrite = atomicPlanHasWrite(plan);
    let committedNotified = false;
    let hasOutcomeFailure = false;
    let outcomeFailure: unknown;
    const committed =
      planHasWrite && committedWriteSegment
        ? async () => {
            if (committedNotified) return;
            committedNotified = true;
            try {
              await committedWriteSegment();
            } catch (error) {
              hasOutcomeFailure = true;
              outcomeFailure = error;
            }
          }
        : undefined;
    let dispatched = false;
    let execution: AtomicExecutionResult;
    try {
      execution = await this.executeEntries(
        plan,
        driver,
        context,
        driver.supportsOrderedCommittedSegments ? committed : undefined,
        writeMayBeVisible
          ? () => {
              dispatched = true;
            }
          : undefined
      );
      if (planHasWrite && !driver.supportsOrderedCommittedSegments) {
        await committed?.();
      }
    } catch (error) {
      if (hasOutcomeFailure) {
        throw retainWriteOutcomeFailure(error, outcomeFailure);
      }
      if (
        planHasWrite &&
        dispatched &&
        !committedNotified &&
        writeMayBeVisible &&
        !(error instanceof UniqueConstraintError || isRetryableRace(error))
      ) {
        try {
          await writeMayBeVisible();
        } catch (writeOutcomeFailure) {
          throw retainWriteOutcomeFailure(error, writeOutcomeFailure);
        }
      }
      throw error;
    }

    let operationOutcome:
      | { readonly status: "success"; readonly value: T }
      | { readonly status: "failure"; readonly error: unknown };
    try {
      operationOutcome = {
        status: "success",
        value: operation.parse<T>(execution.outputs),
      };
    } catch (error) {
      operationOutcome = { status: "failure", error };
    }
    if (hasOutcomeFailure) {
      if (operationOutcome.status === "failure") {
        throw retainWriteOutcomeFailure(operationOutcome.error, outcomeFailure);
      }
      throw outcomeFailure;
    }
    if (operationOutcome.status === "failure") throw operationOutcome.error;
    return operationOutcome.value;
  }

  private async runGeneratedOutputFallback<T>(
    operation: ExecutableOperation,
    fragment: OperationFragment,
    segments: readonly GeneratedOutputSegment[],
    context: QueryExecutionContext,
    driver: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    const progress: MutableRecordSeriesProgress = {
      committedSegments: 0,
      completedMembers: 0,
      committedWriteMembers: 0,
    };
    try {
      let bindLimit: number;
      try {
        bindLimit = progressiveBindLimit(driver);
        assertStaticFragmentCapacity(fragment, driver, bindLimit);
        assertGeneratedOutputSegmentEligibility(segments, driver);
      } catch (error) {
        throw attachProgress(error, progress, "planning");
      }
      const runtimeValues: RuntimeValues = new Map();
      const commitState: ProgressiveMemberCommitState = {
        writeCommitted: false,
      };
      for (const segment of segments) {
        const materialized = materializeExternalFragment(
          segmentFragment([...segment.continuationGuards, ...segment.steps]),
          runtimeValues
        );
        validateFragment(materialized);
        const plan = this.compileToEntries(materialized);
        assertAtomicPlanCapacity(plan, driver, bindLimit);
        try {
          await this.executeProgressiveAtomicPlan(
            plan,
            context,
            driver,
            progress,
            [],
            commitState,
            committedWriteSegment,
            writeMayBeVisible
          );
          mergeRuntimeValues(runtimeValues, plan.values);
        } catch (error) {
          if (hasRecordSeriesProgress(error)) throw error;
          throw attachProgress(error, progress, "member");
        }
      }
      try {
        const outputs = resolveFragmentOutputs(fragment, runtimeValues);
        const result = operation.parse<T>(outputs);
        progress.completedMembers += 1;
        return result;
      } catch (error) {
        throw attachProgress(error, progress, "result");
      }
    } finally {
      setProgressiveParentAttributes(progressiveTracer(context), progress);
    }
  }

  /**
   * Run a non-series operation whose final record fragment contains a nested
   * series. This is the D1 route for one compiled record tree: its ordinary
   * prefix and suffix use the same segment runner as a root record series.
   */
  private async runProgressiveFragmentOperation<T>(
    operation: ExecutableOperation,
    fragment: OperationFragment,
    context: QueryExecutionContext,
    driver: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    const progress: MutableRecordSeriesProgress = {
      committedSegments: 0,
      completedMembers: 0,
      committedWriteMembers: 0,
    };
    try {
      let bindLimit: number;
      try {
        bindLimit = progressiveBindLimit(driver);
        assertStaticFragmentCapacity(fragment, driver, bindLimit);
        assertProgressiveBoundaryEligibility(fragment, driver);
        assertGeneratedOutputFragmentEligibility(
          fragment,
          driver,
          this.engine.adapter.batchRefs.storeLastInsertId !== undefined
        );
      } catch (error) {
        throw attachProgress(error, progress, "planning");
      }
      const runtimeValues: RuntimeValues = new Map();
      try {
        await this.executeProgressiveFragment(
          fragment,
          context,
          driver,
          runtimeValues,
          [],
          progress,
          [],
          { writeCommitted: false },
          bindLimit,
          committedWriteSegment,
          writeMayBeVisible
        );
      } catch (error) {
        if (hasRecordSeriesProgress(error)) throw error;
        throw attachProgress(error, progress, "member");
      }
      try {
        const outputs = resolveFragmentOutputs(fragment, runtimeValues);
        const result = operation.parse<T>(outputs);
        progress.completedMembers += 1;
        return result;
      } catch (error) {
        throw attachProgress(error, progress, "result");
      }
    } finally {
      setProgressiveParentAttributes(progressiveTracer(context), progress);
    }
  }

  /**
   * The `$transaction([...])` array seam: lower this operation
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
    operation: RoutedExecutableOperation,
    driver: AnyDriver,
    context: QueryExecutionContext,
    operationName: Operation
  ): Promise<PreparedBatchOperation<T> | undefined> {
    if (isRecordSeries(operation)) return undefined;
    operation.assertBatchPreparable?.();
    const fragment = await this.buildAtomicFragment(operation, driver, context);
    if (fragment.steps.some((step) => step.kind === "recordSeries")) {
      return undefined;
    }
    assertIndivisibleGeneratedOutput(
      fragment,
      this.engine.adapter.batchRefs.storeLastInsertId !== undefined
    );
    const plan = this.compileToEntries(fragment);
    assertOperationPlanCapacity(
      plan,
      driver,
      normalizedBindParameterLimit(driver.maxBindParametersPerStatement)
    );
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
   * Execute one already-compiled statement-atomic plan directly: a single
   * round-trip on the base driver, its JS postcondition enforced after (no
   * partial state to roll back), the fragment's outputs assembled and parsed. The
   * statement carries no unresolved reference (checked in {@link
   * canExecuteDirectly}), so it runs as-is with no materialization pass.
   */
  private async runBorrowedStatementAtomic<T>(
    plan: SingleStatementCandidate,
    operation: ExecutableOperation,
    driver: AnyDriver,
    context: QueryExecutionContext,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    const { step } = plan;
    assertOperationStatementCapacity(
      step.statement,
      driver,
      normalizedBindParameterLimit(driver.maxBindParametersPerStatement)
    );
    if (
      committedWriteSegment === undefined &&
      writeMayBeVisible === undefined
    ) {
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
      const values: RuntimeValues = new Map();
      values.set(step.id, extractOutputs(step, result, values));
      return operation.parse<T>(resolveFragmentOutputs(plan.fragment, values));
    }

    let result: QueryResult<unknown>;
    try {
      result = await this.executeStatement(
        step,
        step.statement,
        driver,
        context
      );
    } catch (error) {
      if (
        step.kind === "write" &&
        writeMayBeVisible &&
        !(error instanceof UniqueConstraintError || isRetryableRace(error))
      ) {
        try {
          await writeMayBeVisible();
        } catch (outcomeFailure) {
          throw retainWriteOutcomeFailure(error, outcomeFailure);
        }
      }
      throw error;
    }

    let operationOutcome:
      | { readonly status: "success"; readonly value: T }
      | { readonly status: "failure"; readonly error: unknown };
    try {
      assertNormalizedQueryResult(result, {
        provider: driver.driverName,
        operation: step.id,
      });
      enforcePostcondition(step, result, context);
      const values: RuntimeValues = new Map();
      values.set(step.id, extractOutputs(step, result, values));
      operationOutcome = {
        status: "success",
        value: operation.parse<T>(
          resolveFragmentOutputs(plan.fragment, values)
        ),
      };
    } catch (error) {
      operationOutcome = { status: "failure", error };
    }
    if (step.kind === "write" && committedWriteSegment) {
      try {
        await committedWriteSegment();
      } catch (outcomeFailure) {
        if (operationOutcome.status === "failure") {
          throw retainWriteOutcomeFailure(
            operationOutcome.error,
            outcomeFailure
          );
        }
        throw outcomeFailure;
      }
    }
    if (operationOutcome.status === "failure") throw operationOutcome.error;
    return operationOutcome.value;
  }

  private async runCandidateStatementAtomic<T>(
    plan: SingleStatementCandidate,
    operation: ExecutableOperation,
    driver: AnyDriver,
    context: QueryExecutionContext,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    const candidate = this.consumableResultCandidate;
    const { step } = plan;
    if (!candidate || candidate.driver !== driver || step.kind !== "read") {
      return this.runBorrowedStatementAtomic<T>(
        plan,
        operation,
        driver,
        context,
        committedWriteSegment,
        writeMayBeVisible
      );
    }
    const preparedRead = operation.preparedResultRows;
    if (!preparedRead) {
      return this.runBorrowedStatementAtomic<T>(
        plan,
        operation,
        driver,
        context,
        committedWriteSegment,
        writeMayBeVisible
      );
    }

    assertOperationStatementCapacity(
      step.statement,
      driver,
      normalizedBindParameterLimit(driver.maxBindParametersPerStatement)
    );
    const parser = preparedRead.createResultParser();
    const shape = preparedRead.createExpectedResultShape();
    const compiled = preparedRead.compileResultRows(parser, shape);
    if (compiled?.containerPolicy !== "reusable") {
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
      const values: RuntimeValues = new Map();
      values.set(step.id, extractOutputs(step, result, values));
      return preparedRead.parseResultWithProgram<T>(
        resolveFragmentOutputs(plan.fragment, values),
        parser,
        shape,
        compiled
      );
    }

    return executeConsumableResultCandidate<T>(
      candidate,
      step.statement,
      context,
      (result, consumableRows) => {
        assertNormalizedQueryResult(result, {
          provider: driver.driverName,
          operation: step.id,
        });
        enforcePostcondition(step, result, context);
        const values: RuntimeValues = new Map();
        values.set(step.id, extractOutputs(step, result, values));
        const outputs = resolveFragmentOutputs(plan.fragment, values);
        return preparedRead.parseResultWithProgram<T>(
          outputs,
          parser,
          shape,
          compiled,
          consumableRows
        );
      }
    );
  }

  /**
   * The single-statement seam: if this operation is one plain
   * statement — empty planning, exactly one read/write step with no guard,
   * postcondition, skip effect, unresolved reference, or insert-id scratch — return
   * its compiled plan so the caller can expose it through `prepare()` (the cache
   * flow's single-statement path, and the array-batch "single" fast path).
   * Otherwise `undefined`: the operation runs through the atomic-batch seam.
   */
  singleStatementPlan(
    operation: RoutedExecutableOperation
  ): SingleStatementCandidate | undefined {
    if (isRecordSeries(operation)) return undefined;
    const candidate = compileSingleStatementCandidate(operation);
    return candidate && canPrepareSingle(candidate) ? candidate : undefined;
  }

  buildStatement(operation: RoutedExecutableOperation): Sql | undefined {
    if (isRecordSeries(operation)) return undefined;
    const candidate = compileSingleStatementCandidate(operation);
    return candidate && canBuildStatement(candidate)
      ? candidate.step.statement
      : undefined;
  }

  /** Prepare the single statement's driver query with the operation's context. */
  prepareSingleStatement(
    plan: SingleStatementCandidate,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): PreparedQuery {
    assertOperationStatementCapacity(
      plan.step.statement,
      driver,
      normalizedBindParameterLimit(driver.maxBindParametersPerStatement)
    );
    return prepareBatchQuery(plan.step.statement, driver, context);
  }

  /** Parse one statement's raw result into the operation's public shape. */
  parseSingleStatement<T>(
    operation: ExecutableOperation,
    plan: SingleStatementCandidate,
    raw: { rows: unknown[]; rowCount: number }
  ): T {
    const result: QueryResult<unknown> = {
      rows: raw.rows,
      rowCount: raw.rowCount,
    };
    const values: RuntimeValues = new Map();
    values.set(plan.step.id, extractOutputs(plan.step, result, values));
    return operation.parse<T>(resolveFragmentOutputs(plan.fragment, values));
  }

  private async buildAtomicFragment(
    operation: ExecutableOperation,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<OperationFragment> {
    const planning = operation.planning();
    validateFragment(planning);
    assertOperationFragmentCapacity(
      planning,
      driver,
      normalizedBindParameterLimit(driver.maxBindParametersPerStatement)
    );
    const planningOutputs = await this.executePlanningLevels(
      planning,
      driver,
      context
    );
    const fragment = operation.compile(planningOutputs);
    validateFragment(fragment);
    if (!fragment.steps.some((step) => step.kind === "recordSeries")) {
      assertOperationFragmentCapacity(
        fragment,
        driver,
        normalizedBindParameterLimit(driver.maxBindParametersPerStatement)
      );
    }
    return fragment;
  }

  /**
   * Planning reads are grouped by dependency level on batch-only drivers. The
   * compiled writes already ride ONE atomic batch; the planning
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
    return derivePlanningKnown(fragment, values);
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
      driver._prepare(materializeLinearSql(step.statement, values), context)
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
      values.set(step.id, extractOutputs(step, result, values));
    }
  }

  private async executeLinear(
    fragment: OperationFragment | PlanningFragment,
    driver: AnyDriver,
    values: RuntimeValues,
    context: QueryExecutionContext,
    skipRootWriteId?: string
  ): Promise<Readonly<Record<string, unknown>>> {
    for (const step of fragment.steps) {
      await this.runLinearStep(step, driver, values, context, skipRootWriteId);
    }
    return "outputs" in fragment
      ? resolveFragmentOutputs(fragment, values)
      : derivePlanningKnown(fragment, values);
  }

  /** One step on its own round trip, its output threaded into `values`. */
  private async runLinearStep(
    step: OperationStep,
    driver: AnyDriver,
    values: RuntimeValues,
    context: QueryExecutionContext,
    skipRootWriteId?: string
  ): Promise<void> {
    if (step.kind === "recordSeries") {
      await this.runRecordSeries(step.series, context, driver, values);
      return;
    }
    if (step.kind === "guard") {
      throw new QueryEngineError(
        `Guard step '${step.id}' requires atomic batch execution.`
      );
    }
    const statement = materializeLinearSql(step.statement, values);
    // A write carrying the `onUniqueConflict: "skip"` effect (ATOM “Bulk specializations”)
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
    if (step.id === skipRootWriteId && result.rowCount === 0) {
      throw new SkippedRecordSeriesMember();
    }
    enforcePostcondition(step, result, context);
    values.set(step.id, extractOutputs(step, result, values));
  }

  /**
   * Execute one materialized statement, classifying a race against the step's
   * `racePin` (ATOM “The execution vocabulary”) so the retry layer **above** the
   * executor (the routed `PendingOperation` lifecycle) can retry a matched
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
  private compileToEntries(
    fragment: OperationFragment,
    skippableRootWriteId?: string
  ): AtomicPlan {
    const values: RuntimeValues = new Map();
    const batchId = `operation_${createCorrelationId()}`;
    const batchEntries: BatchEntry[] = [];
    let nextReference = 0;
    let usesScratch = false;
    const consumedOutputs = locallyConsumedOutputs(fragment.steps);

    for (const step of fragment.steps) {
      if (step.kind === "recordSeries") {
        throw new QueryEngineError(
          `Record series step '${step.id}' requires ordered series execution.`
        );
      }
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
        // one must fail closed here — never a silent skip (ATOM “The execution vocabulary”).
        throw new QueryEngineError(
          `Step '${step.id}' carries a postcondition that is not yet enforced in batch mode.`
        );
      }

      if (
        step.kind === "write" &&
        step.onUniqueConflict === "skip" &&
        step.id !== skippableRootWriteId
      ) {
        // The savepoint-wrapped skip effect (ATOM “Bulk specializations”) has no lowering to a plain
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
        if (source.kind === "consumedValue") {
          if (source.source.kind === "literal") {
            setRuntimeValue(values, step.id, output, source.source.value);
            continue;
          }
          const producer = values
            .get(source.source.reference.step)
            ?.get(source.source.reference.output);
          if (producer !== undefined) {
            setRuntimeValue(values, step.id, output, producer);
          }
          continue;
        }
        if (source.kind !== "insertId") continue;
        // A fragment result can read the provider's own insertId directly. Scratch is
        // required only when later SQL in this same atomic unit consumes the value.
        if (!consumedOutputs.has(`${step.id}.${output}`)) continue;
        const storeLastInsertId =
          this.engine.adapter.batchRefs.storeLastInsertId;
        // The shared-batch entrance and the default-operation segment planner
        // have already rejected or cut every unsupported cross-statement
        // dependency. An absent store here therefore means this insertId is only
        // a public result and needs no scratch lowering.
        if (!storeLastInsertId) continue;
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
          statement: storeLastInsertId(batchId, key),
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
      ...(skippableRootWriteId ? { skippableRootWriteId } : {}),
    };
  }

  /** Execute-entries half: run the atomic unit and assemble declared outputs. */
  private async executeEntries(
    plan: AtomicPlan,
    driver: AnyDriver,
    context: QueryExecutionContext,
    committed?: CommittedWriteSegmentNotification,
    dispatching?: () => void
  ): Promise<AtomicExecutionResult> {
    const { entries } = plan;
    const queries = entries.map((entry) =>
      driver._prepare(entry.statement, context)
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
        entries,
        driver,
        context
      );
      const skippableRoot = entries.find(
        (entry) => entry.step?.id === plan.skippableRootWriteId
      )?.step;
      if (
        error instanceof UniqueConstraintError &&
        skippableRoot?.kind === "write" &&
        skippableRoot.onUniqueConflict === "skip"
      ) {
        throw new SkippedRecordSeriesMember();
      }
      // An insert-branch loser inside the atomic unit surfaces its pinned unique
      // violation; classify it against any racePin so the retry layer above the
      // executor converges. The batch is one unit,
      // so the failing entry is not individually reported — match the error
      // against every racePin the plan carries (there is one per insert branch).
      for (const entry of entries) {
        const pin =
          entry.step?.kind === "write" ? entry.step.racePin : undefined;
        if (pin) {
          markRaceIfPinned(error, pin);
        }
      }
      throw error;
    }
    assertNormalizedBatchResults(results, entries.length, {
      provider: driver.driverName,
      operation: "query-engine-v2",
    });
    const rootIndex =
      plan.skippableRootWriteId === undefined
        ? -1
        : entries.findIndex(
            (entry) => entry.step?.id === plan.skippableRootWriteId
          );
    if (rootIndex >= 0 && results[rootIndex]?.rowCount === 0) {
      return { outputs: {}, skippedRoot: true };
    }
    return { outputs: assembleOutputs(plan, results), skippedRoot: false };
  }
}

interface MutableRecordSeriesProgress {
  committedSegments: number;
  completedMembers: number;
  committedWriteMembers: number;
  mayHaveCommittedSegment?: true;
  totalMembers?: number;
}

function progressiveTracer(
  context: QueryExecutionContext
): TracerWrapper | undefined {
  return getExecutionInstrumentation(context)?.tracer;
}

async function observeProgressiveSegment<T>(
  context: QueryExecutionContext,
  plan: AtomicPlan,
  memberPath: readonly number[],
  hasWrite: boolean,
  didCommit: () => boolean,
  mayHaveCommitted: () => boolean,
  execute: () => Promise<T>
): Promise<T> {
  const observers = getExecutionExtensionChain(context)?.observe;
  if (observers === undefined || observers.length === 0) {
    return execute();
  }
  const official = getOfficialInstrumentationChainCapability(
    getExecutionExtensionChain(context)
  );
  const usesOfficialInstrumentation = official?.observesLifecycle === true;
  const readInstrumentationFacts =
    usesOfficialInstrumentation &&
    official.context.config.tracing !== undefined &&
    shouldTraceSpan(official.context.tracer, SPAN_RECORD_SERIES_SEGMENT)
      ? createProgressiveSegmentInstrumentationFacts(
          plan,
          memberPath,
          hasWrite,
          didCommit,
          mayHaveCommitted
        )
      : undefined;
  return runProtectedObservers(
    {
      kind: "segment",
      ...(context.operation === undefined
        ? {}
        : { operation: context.operation }),
      ...(context.model === undefined || context.model === "$raw"
        ? {}
        : { model: context.model }),
    },
    observers,
    execute,
    () => {
      if (!hasWrite) return undefined;
      if (didCommit()) return { commitCertainty: "committed" };
      if (mayHaveCommitted()) {
        return { commitCertainty: "may-have-committed" };
      }
      return undefined;
    },
    readInstrumentationFacts
  );
}

function createProgressiveSegmentInstrumentationFacts(
  plan: AtomicPlan,
  memberPath: readonly number[],
  hasWrite: boolean,
  didCommit: () => boolean,
  mayHaveCommitted: () => boolean
): InstrumentationLifecycleFactsReader {
  const spanOptions: VibORMSpanOptions = Object.freeze({
    name: SPAN_RECORD_SERIES_SEGMENT,
    attributes: Object.freeze({
      [ATTR_VIBORM_WRITE_ATOMICITY]: "segment",
      [ATTR_VIBORM_WRITE_MEMBER_PATH]:
        memberPath.length === 0 ? "root" : memberPath.join("."),
      [ATTR_VIBORM_WRITE_STATEMENT_COUNT]: plan.entries.length,
    }),
  });
  const facts: SegmentInstrumentationFacts = Object.freeze({
    kind: "segment",
    spanOptions,
    complete: (outcome: InstrumentationLifecycleOutcome) =>
      Object.freeze({
        spanAttributes: Object.freeze({
          [ATTR_VIBORM_WRITE_COMMIT_OUTCOME]: progressiveSegmentOutcome(
            hasWrite,
            didCommit(),
            mayHaveCommitted(),
            outcome.status === "success"
          ),
        }),
      }),
  });
  return () => facts;
}

function progressiveSegmentOutcome(
  hasWrite: boolean,
  didCommit: boolean,
  mayHaveCommitted: boolean,
  succeeded: boolean
): "committed" | "read_only" | "rolled_back" | "unacknowledged" {
  if (!hasWrite) return "read_only";
  if (didCommit) return "committed";
  if (mayHaveCommitted || succeeded) return "unacknowledged";
  return "rolled_back";
}

function setProgressiveParentAttributes(
  tracer: TracerWrapper | undefined,
  progress: MutableRecordSeriesProgress
): void {
  setTracerAttributes(tracer, {
    [ATTR_VIBORM_WRITE_ATOMICITY]: "segment",
    [ATTR_VIBORM_WRITE_COMMITTED_SEGMENTS]: progress.committedSegments,
    [ATTR_VIBORM_WRITE_COMPLETED_MEMBERS]: progress.completedMembers,
    [ATTR_VIBORM_WRITE_COMMITTED_WRITE_MEMBERS]: progress.committedWriteMembers,
  });
}

function setTracerAttributes(
  tracer: TracerWrapper | undefined,
  attributes: Parameters<
    NonNullable<TracerWrapper["setActiveSpanAttributes"]>
  >[0]
): void {
  try {
    tracer?.setActiveSpanAttributes?.(attributes);
  } catch {
    // A custom observer cannot change the database outcome.
  }
}

function attachProgress(
  error: unknown,
  progress: MutableRecordSeriesProgress,
  phase: RecordSeriesProgress["phase"],
  memberPath: readonly number[] = []
): unknown {
  return attachRecordSeriesProgress(error, {
    atomicity: "segment",
    phase,
    committedSegments: progress.committedSegments,
    completedMembers: progress.completedMembers,
    committedWriteMembers: progress.committedWriteMembers,
    ...(progress.mayHaveCommittedSegment
      ? { mayHaveCommittedSegment: true as const }
      : {}),
    ...(memberPath.length === 0 ? {} : { memberPath }),
    ...(progress.totalMembers === undefined
      ? {}
      : { totalMembers: progress.totalMembers }),
  });
}

function executionRefusal(
  driver: AnyDriver,
  subject: string,
  reason: string
): UnsupportedOperationError {
  return new UnsupportedOperationError(
    `Driver '${driver.driverName}' cannot execute this ${subject} because ${reason}.`
  );
}

function progressiveSeriesRefusal(
  driver: AnyDriver,
  reason: string
): UnsupportedOperationError {
  return executionRefusal(
    driver,
    "record series as committed segments",
    reason
  );
}

function assertOperationStatementCapacity(
  statement: Sql,
  driver: AnyDriver,
  limit: number | undefined
): void {
  assertStatementBindParameterCapacity(
    statement,
    driver.driverName,
    limit,
    "operation"
  );
}

function assertOperationFragmentCapacity(
  fragment: OperationFragment | PlanningFragment,
  driver: AnyDriver,
  limit: number | undefined
): void {
  if (limit === undefined) return;
  for (const step of fragment.steps) {
    if (step.kind === "recordSeries") continue;
    const statement =
      step.kind === "guard" ? step.premise.statement : step.statement;
    assertOperationStatementCapacity(statement, driver, limit);
  }
}

function assertOperationPlanCapacity(
  plan: AtomicPlan,
  driver: AnyDriver,
  limit: number | undefined
): void {
  for (const entry of plan.entries) {
    assertOperationStatementCapacity(entry.statement, driver, limit);
  }
}

/**
 * THE COMPILED READER of "a skipped root must strand nothing" — the general owner.
 * It sees the member's real step order, so it answers for every arm actually
 * chosen, including the probe-dependent ones no parsed shape can promise. It runs
 * at series preflight for members with empty planning, and at member time for the
 * rest; {@link assertDeclaredRootConflictEligibility} is what covers the timing
 * that leaves open.
 */
function assertProgressiveRootConflictEligibility(
  fragment: OperationFragment,
  disposition: SeriesRootConflictDisposition | undefined,
  driver: AnyDriver
): void {
  if (!disposition) return;
  const rootIndex = fragment.steps.findIndex(
    (step) => step.id === disposition.rootWriteId
  );
  const root = fragment.steps[rootIndex];
  if (!(rootIndex >= 0 && root?.kind === "write")) {
    throw new QueryEngineError(
      `Record-series root-conflict step '${disposition.rootWriteId}' is not a write in its member fragment.`
    );
  }
  const priorEffect = fragment.steps
    .slice(0, rootIndex)
    .find((step) => step.kind === "write" || step.kind === "recordSeries");
  if (!priorEffect) return;
  throw strandedRootConflictPrefix(disposition, priorEffect.id, driver);
}

/**
 * THE DECLARED READER of the same invariant, for the members the compiled one
 * structurally cannot reach at preflight (plan §9.6, "before member zero").
 *
 * It adds no sentence and no second refusal: both readers throw
 * {@link strandedRootConflictPrefix}. What it adds is WHEN — a member whose
 * planning phase is non-empty is compiled only on its own turn, and by then a
 * predecessor may hold a durable segment. The operation's parsed shape is the one
 * thing available earlier, and an operation only declares a write it is certain
 * to emit, so this can refuse nothing the compiled reader would have passed.
 */
function assertDeclaredRootConflictEligibility(
  operation: ExecutableOperation,
  driver: AnyDriver
): void {
  const disposition = operation.seriesRootConflict;
  const declared = operation.declaredPreRootWriteId;
  if (!(disposition && declared)) return;
  throw strandedRootConflictPrefix(disposition, declared, driver);
}

function strandedRootConflictPrefix(
  disposition: SeriesRootConflictDisposition,
  priorEffectId: string,
  driver: AnyDriver
): UnsupportedOperationError {
  return progressiveSeriesRefusal(
    driver,
    `skipping root '${disposition.rootWriteId}' would leave prior effect '${priorEffectId}' committed`
  );
}

function atomicPlanHasWrite(plan: AtomicPlan): boolean {
  return plan.entries.some((entry) => entry.step?.kind === "write");
}

function progressiveBindLimit(driver: AnyDriver): number {
  if (!driver.supportsBatch) {
    throw progressiveSeriesRefusal(
      driver,
      "the provider does not expose an atomic batch substrate"
    );
  }
  const limit = driver.maxBindParametersPerStatement;
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0
    ? limit
    : Number.POSITIVE_INFINITY;
}

function assertStaticFragmentCapacity(
  fragment: OperationFragment | PlanningFragment,
  driver: AnyDriver,
  limit: number
): void {
  for (const step of fragment.steps) {
    if (step.kind === "recordSeries") {
      if (
        step.progressive.kind === "guarded" &&
        step.progressive.guard.premise.statement.values.length > limit
      ) {
        throw progressiveSeriesRefusal(
          driver,
          `one statically compiled boundary guard needs ${step.progressive.guard.premise.statement.values.length} bound values, above the verified limit of ${limit}`
        );
      }
      continue;
    }
    const statement =
      step.kind === "guard" ? step.premise.statement : step.statement;
    if (statement.values.length > limit) {
      throw progressiveSeriesRefusal(
        driver,
        `one statically compiled statement needs ${statement.values.length} bound values, above the verified limit of ${limit}`
      );
    }
    if (
      (step.kind === "read" || step.kind === "write") &&
      step.progressiveContinuation &&
      step.progressiveContinuation.premise.statement.values.length > limit
    ) {
      throw progressiveSeriesRefusal(
        driver,
        `one statically compiled continuation guard needs ${step.progressiveContinuation.premise.statement.values.length} bound values, above the verified limit of ${limit}`
      );
    }
  }
}

function assertProgressiveBoundaryEligibility(
  fragment: OperationFragment,
  driver: AnyDriver
): void {
  for (const step of fragment.steps) {
    if (
      step.kind === "recordSeries" &&
      step.progressive.kind === "unsupported"
    ) {
      throw progressiveSeriesRefusal(driver, step.progressive.reason);
    }
  }
}

function assertGeneratedOutputSegmentEligibility(
  segments: readonly GeneratedOutputSegment[],
  driver: AnyDriver,
  skippableRootWriteId?: string
): void {
  if (segments.length < 2) {
    throw new QueryEngineError(
      "Generated-output fallback did not produce an execution boundary."
    );
  }
  for (const segment of segments) {
    assertGeneratedOutputStepsEligibility(
      segment.steps,
      driver,
      skippableRootWriteId
    );
  }
}

function assertGeneratedOutputStepsEligibility(
  steps: readonly OperationStep[],
  driver: AnyDriver,
  skippableRootWriteId?: string
): void {
  for (const step of steps) {
    if (step.kind === "recordSeries") {
      throw progressiveSeriesRefusal(
        driver,
        "a generated-output boundary crosses a nested record series"
      );
    }
    if (step.kind === "guard") continue;
    if (step.expects) {
      throw new QueryEngineError(
        `Step '${step.id}' carries a postcondition that cannot be checked after a committed generated-output segment.`
      );
    }
    if (
      step.kind === "write" &&
      step.onUniqueConflict === "skip" &&
      step.id !== skippableRootWriteId
    ) {
      throw new QueryEngineError(
        `Step '${step.id}' carries an onUniqueConflict skip effect that cannot cross a generated-output segment boundary.`
      );
    }
  }
}

function assertGeneratedOutputFragmentEligibility(
  fragment: OperationFragment,
  driver: AnyDriver,
  supportsInsertIdScratch: boolean,
  skippableRootWriteId?: string
): void {
  const statementSteps = statementStepsById(fragment);
  const priorOrdinaryIds = new Set<string>();
  let ordinary: OperationStep[] = [];
  const flush = () => {
    if (ordinary.length === 0) return;
    const crossedGuards = crossedReferenceContinuationGuards(
      ordinary,
      priorOrdinaryIds,
      statementSteps
    );
    if (crossedGuards.length > 0) {
      assertGeneratedOutputStepsEligibility(
        ordinary,
        driver,
        skippableRootWriteId
      );
    }
    const segments = generatedOutputSegments(
      segmentFragment(ordinary),
      supportsInsertIdScratch
    );
    for (const step of ordinary) {
      if (step.kind === "read" || step.kind === "write") {
        priorOrdinaryIds.add(step.id);
      }
    }
    ordinary = [];
    if (segments) {
      assertGeneratedOutputSegmentEligibility(
        segments,
        driver,
        skippableRootWriteId
      );
    }
  };
  for (const step of fragment.steps) {
    if (step.kind === "recordSeries") {
      flush();
      continue;
    }
    ordinary.push(step);
  }
  flush();
}

function assertAtomicPlanCapacity(
  plan: AtomicPlan,
  driver: AnyDriver,
  limit: number
): void {
  for (const entry of plan.entries) {
    if (entry.statement.values.length > limit) {
      throw progressiveSeriesRefusal(
        driver,
        `one member statement needs ${entry.statement.values.length} bound values, above the verified limit of ${limit}`
      );
    }
  }
}

function mergeRuntimeValues(
  target: RuntimeValues,
  source: RuntimeValues
): void {
  for (const [step, outputs] of source) {
    target.set(step, new Map(outputs));
  }
}

/** Preserve every output a split segment actually publishes for later segments. */
function segmentFragment(steps: readonly OperationStep[]): OperationFragment {
  const outputs: Record<string, OperationValueReference> = {};
  for (const step of steps) {
    if (step.kind === "guard" || step.kind === "recordSeries") continue;
    for (const output of Object.keys(step.outputs)) {
      outputs[`${step.id}.${output}`] = ref(step.id, output);
    }
  }
  return { steps, outputs };
}

function assertIndivisibleGeneratedOutput(
  fragment: OperationFragment,
  supportsInsertIdScratch: boolean
): void {
  const reference = firstGeneratedOutputDependency(
    fragment,
    statementStepsById(fragment),
    supportsInsertIdScratch
  );
  if (!reference) return;
  throw new UnsupportedOperationError(
    `query-engine-v2 cannot materialize generated output '${reference.step}.${reference.output}' across statements inside one indivisible shared batch. Use the default operation form or a driver with an interactive transaction.`
  );
}

/** Outputs consumed by SQL inside the same fragment, excluding public result refs. */
function locallyConsumedOutputs(
  steps: readonly OperationStep[]
): ReadonlySet<string> {
  const consumed = new Set<string>();
  for (const step of steps) {
    const statement =
      step.kind === "guard"
        ? step.premise.statement
        : step.kind === "recordSeries"
          ? step.progressive.kind === "guarded"
            ? step.progressive.guard.premise.statement
            : undefined
          : step.statement;
    if (!statement) continue;
    for (const reference of statementReferences(statement)) {
      consumed.add(`${reference.step}.${reference.output}`);
    }
  }
  return consumed;
}

function materializeProgressiveGuard(
  guard: GuardStep,
  values: RuntimeValues
): GuardStep {
  const fragment = materializeExternalFragment(
    { steps: [guard], outputs: {} },
    values
  );
  validateFragment(fragment);
  const materialized = fragment.steps[0];
  if (materialized?.kind !== "guard") {
    throw new QueryEngineError(
      `Progressive boundary guard '${guard.id}' did not remain a guard.`
    );
  }
  return materialized;
}

/**
 * Assemble a fragment's declared outputs from one atomic batch's results —
 * shared by the executed path and the `prepareSharedBatch` seam so a returned plan
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
  for (const value of [
    ...statementReferences(step.statement),
    ...statementOutputReferences(step),
  ]) {
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
  const prepared = driver._prepare(statement, context);
  return transferPreparedStatement(prepared, {
    sql: prepared.sql,
    params: prepared.params ?? [],
    context,
  });
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
  return createFailureError(
    failure,
    context.model ?? "record",
    context.operation ?? "query"
  );
}

function materializeLinearSql(statement: Sql, values: RuntimeValues): Sql {
  if (!statementHasReferences(statement)) return statement;

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
      // write's superset planning (ATOM “Planning fragments”) behave identically on
      // every driver — eight of nine binders coerce `undefined` to NULL, mysql2
      // rejects it outright — so the semantics live in the engine, not in one
      // driver.
      return resolved ?? null;
    })
  );
}

function cloneRuntimeValues(values: RuntimeValues): RuntimeValues {
  const cloned: RuntimeValues = new Map();
  for (const [step, outputs] of values) {
    cloned.set(step, new Map(outputs));
  }
  return cloned;
}

function materializeExternalFragment(
  fragment: OperationFragment,
  values: RuntimeValues
): OperationFragment;
function materializeExternalFragment(
  fragment: PlanningFragment,
  values: RuntimeValues
): PlanningFragment;
function materializeExternalFragment(
  fragment: OperationFragment | PlanningFragment,
  values: RuntimeValues
): OperationFragment | PlanningFragment {
  if (values.size === 0) return fragment;
  const localSteps = new Set(fragment.steps.map((step) => step.id));
  const steps = fragment.steps.map((step) => {
    if (step.kind === "recordSeries") {
      if (step.progressive.kind === "unsupported") return step;
      return {
        ...step,
        progressive: {
          ...step.progressive,
          guard: {
            ...step.progressive.guard,
            premise: {
              ...step.progressive.guard.premise,
              statement: materializeExternalSql(
                step.progressive.guard.premise.statement,
                localSteps,
                values
              ),
            },
          },
        },
      };
    }
    if (step.kind === "guard") {
      return {
        ...step,
        premise: {
          ...step.premise,
          statement: materializeExternalSql(
            step.premise.statement,
            localSteps,
            values
          ),
        },
      };
    }
    const outputs = Object.fromEntries(
      Object.entries<StatementOutputSource>(step.outputs).map(
        ([name, source]) => [
          name,
          source.kind === "consumedValue"
            ? {
                ...source,
                source: materializeExternalConsumedSource(
                  source.source,
                  localSteps,
                  values
                ),
              }
            : source,
        ]
      )
    );
    return {
      ...step,
      statement: materializeExternalSql(step.statement, localSteps, values),
      outputs,
      ...(step.progressiveContinuation
        ? {
            progressiveContinuation: {
              ...step.progressiveContinuation,
              premise: {
                ...step.progressiveContinuation.premise,
                statement: materializeExternalSql(
                  step.progressiveContinuation.premise.statement,
                  localSteps,
                  values
                ),
              },
            },
          }
        : {}),
    };
  });
  return "outputs" in fragment
    ? {
        steps,
        outputs: fragment.outputs,
      }
    : { steps: steps.filter(isStatementStep) };
}

function isStatementStep(step: OperationStep): step is StatementStep {
  return step.kind === "read" || step.kind === "write";
}

function materializeExternalSql(
  statement: Sql,
  localSteps: ReadonlySet<string>,
  values: RuntimeValues
): Sql {
  return new Sql(
    statement.strings,
    statement.values.map((value) => {
      if (!(isOperationValueReference(value) && !localSteps.has(value.step))) {
        return value;
      }
      const resolved = resolveRuntimeValue(value, values);
      if (isSql(resolved)) {
        throw new QueryEngineError(
          `External operation reference '${value.step}.${value.output}' is not a concrete runtime value.`
        );
      }
      return resolved ?? null;
    })
  );
}

function materializeExternalValue(
  value: unknown,
  localSteps: ReadonlySet<string>,
  values: RuntimeValues
): unknown {
  if (!(isOperationValueReference(value) && !localSteps.has(value.step))) {
    return value;
  }
  const resolved = resolveRuntimeValue(value, values);
  if (isSql(resolved)) {
    throw new QueryEngineError(
      `External operation reference '${value.step}.${value.output}' is not a concrete runtime value.`
    );
  }
  return resolved ?? null;
}

function materializeExternalConsumedSource(
  source: Extract<StatementOutputSource, { kind: "consumedValue" }>["source"],
  localSteps: ReadonlySet<string>,
  values: RuntimeValues
): Extract<StatementOutputSource, { kind: "consumedValue" }>["source"] {
  if (source.kind === "literal" || localSteps.has(source.reference.step)) {
    return source;
  }
  return {
    kind: "literal",
    value: materializeExternalValue(source.reference, localSteps, values),
  };
}

function materializeBatchSql(statement: Sql, values: RuntimeValues): Sql {
  if (!statementHasReferences(statement)) return statement;

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
  result: QueryResult<unknown>,
  values: RuntimeValues
): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  // A write whose skip effect (ATOM “Bulk specializations”) ABSORBED a unique violation made no row, so it
  // produced no insert id: `executeSkippableWrite` yields the zero-row result and the
  // driver reports nothing to read. That absence is the skip itself, not a driver failure,
  // so the declared output resolves to `undefined` and the consumer decides from the row
  // count — the only thing that says the skip happened. Every OTHER absent insert
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
    outputs.set(name, extractOutput(step.id, source, result, values));
  }
  return outputs;
}

function extractOutput(
  step: string,
  source: StatementOutputSource,
  result: QueryResult<unknown>,
  values: RuntimeValues
): unknown {
  if (source.kind === "rows") return result.rows;
  if (source.kind === "rowCount") return result.rowCount;
  if (source.kind === "consumedValue") {
    return resolveConsumedValue(source.source, values, false);
  }
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
    if (source.kind === "consumedValue") {
      const resolved = resolveConsumedValue(source.source, values, true);
      // A batch-local scratch expression has already been embedded in every later
      // statement before provider I/O. It is not a public runtime value, and the
      // preflight above refuses any fragment that tries to carry it across a boundary.
      if (isSql(resolved)) continue;
      setRuntimeValue(values, step.id, name, resolved);
      continue;
    }
    if (source.kind === "insertId" && result.insertId === undefined) {
      const existing = values.get(step.id)?.get(name);
      if (isSql(existing)) continue;
    }
    setRuntimeValue(
      values,
      step.id,
      name,
      extractOutput(step.id, source, result, values)
    );
  }
}

function resolveConsumedValue(
  source: Extract<StatementOutputSource, { kind: "consumedValue" }>["source"],
  values: RuntimeValues,
  allowScratchSql: boolean
): unknown {
  const resolved =
    source.kind === "reference"
      ? resolveRuntimeValue(source.reference, values)
      : source.value;
  if (isSql(resolved) && !allowScratchSql) {
    throw new QueryEngineError(
      "A consumed-value output did not resolve to a concrete runtime value."
    );
  }
  return resolved;
}

/**
 * The DERIVED planning publication: every declared output of every planning
 * statement, under its stable `planningKey(step.id, name)` address. Planning
 * has no explicit outputs map to under-publish through — the steps ARE the
 * declaration.
 */
function derivePlanningKnown(
  fragment: PlanningFragment,
  values: RuntimeValues
): Readonly<Record<string, unknown>> {
  const outputs: Record<string, unknown> = {};
  for (const step of fragment.steps) {
    for (const name of Object.keys(step.outputs)) {
      outputs[planningKey(step.id, name)] = resolveSingleOutput(
        planningKey(step.id, name),
        ref(step.id, name),
        values
      );
    }
  }
  return outputs;
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
 * (ATOM “The execution vocabulary”). The list is homogeneous: mixing row and count sources is a typed
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
