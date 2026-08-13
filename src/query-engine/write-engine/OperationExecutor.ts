// biome-ignore-all lint/style/useFilenamingConvention: OperationExecutor is the architecture name.
import type { AnyDriver, QueryExecutionContext, QueryResult } from "@drivers";
import { getExecutionInstrumentation } from "@drivers/execution-context";
import {
  assertNormalizedBatchResults,
  assertNormalizedQueryResult,
} from "@drivers/normalized-result";
import {
  attachRecordSeriesProgress,
  hasRecordSeriesProgress,
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
import type { TracerWrapper } from "@instrumentation/tracer";
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
  statementReferences,
} from "./OperationFragment";
import { planningKey } from "./Part";
import {
  isRetryableRace,
  markRaceable,
  markRaceIfPinned,
  racePinMatches,
} from "./race-retry";
import {
  isRecordSeries,
  type RecordSeriesOperation,
  type RoutedExecutableOperation,
  type SeriesRootConflictDisposition,
} from "./record-series";
import { isRecord, noAtomicSubstrateError } from "./shared";

type RuntimeValues = Map<string, Map<string, unknown>>;

export type CommittedWriteSegmentNotification = () => Promise<void>;

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
  /** Exact private disposition for a root INSERT whose duplicate skips its member. */
  readonly seriesRootConflict?: SeriesRootConflictDisposition;
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

  constructor(engine: QueryEngine) {
    this.engine = engine;
  }

  execute<T>(
    operation: RoutedExecutableOperation,
    context: QueryExecutionContext,
    driverOverride?: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification
  ): Promise<T> {
    // A SERIES has no single planning-then-compilation fragment, so none of the
    // seams below it may be entered: it owns an interactive scope in which it
    // captures, builds its members, and runs them one after another.
    //
    // It always opens that scope ITSELF — on the caller's driver when there is
    // one, where `withTransaction` is a savepoint (the same nesting the client's
    // callback seam already opens per operation). Borrowing the caller's scope
    // instead would make the retry above untrue: a member failure would leave its
    // predecessors' effects standing in a scope it had merely poisoned, so the
    // second attempt could neither undo them nor run at all. `withTransaction`
    // also refuses a substrate offering no interactive scope before it reaches the
    // provider, under that method's own naming.
    if (isRecordSeries(operation)) {
      const seriesDriver = driverOverride ?? this.engine.driver;
      if (
        !seriesDriver.supportsTransactions &&
        seriesDriver.supportsOrderedCommittedSegments
      ) {
        return this.runProgressiveRecordSeries<T>(
          operation,
          context,
          seriesDriver,
          committedWriteSegment
        );
      }
      setTracerAttributes(progressiveTracer(this.engine, context), {
        [ATTR_VIBORM_WRITE_ATOMICITY]: "operation",
      });
      return seriesDriver.withTransaction(
        (driver) => this.runRecordSeries<T>(operation, context, driver),
        undefined,
        context
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
        context
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
      return this.runTransaction<T>(operation, context);
    }
    return this.runAtomicBatch<T>(operation, context, committedWriteSegment);
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
   * Execute the existing record-series form as ordered committed batches. This
   * route is selected only by a driver whose binding contract proves that every
   * submitted batch is atomic and a later batch observes earlier commits.
   */
  private async runProgressiveRecordSeries<T>(
    operation: RecordSeriesOperation,
    context: QueryExecutionContext,
    driver: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification
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
        committedWriteSegment
      );
    } catch (error) {
      if (hasRecordSeriesProgress(error)) throw error;
      throw attachProgress(error, progress, "planning");
    } finally {
      setProgressiveParentAttributes(
        progressiveTracer(this.engine, context),
        progress
      );
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
      if (members.some((member) => member.seriesRootConflict !== undefined)) {
        throw progressiveSeriesRefusal(
          driver,
          "skipDuplicates needs exact root-versus-descendant conflict attribution, which this ordered batch contract does not provide"
        );
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
        const outputs = await this.executeEntries(plan, driver, context);
        resultReadResults.push(resultRead.parse(outputs));
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
    if (planning.steps.length !== 0) return { operation, planning };
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
        await this.executeProgressiveFragment(
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
          fragmentPhase
        );
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
    fragmentPhase: ProgressiveSegmentPhase = "member"
  ): Promise<void> {
    let segment: OperationStep[] = [];
    let activeGuards = [...inheritedGuards];
    const hasNestedSeries = fragment.steps.some(
      (step) => step.kind === "recordSeries"
    );
    let completedNestedSeries = false;
    const flush = async () => {
      if (segment.length === 0) return;
      const phase: ProgressiveSegmentPhase = hasNestedSeries
        ? completedNestedSeries
          ? "suffix"
          : "prefix"
        : fragmentPhase;
      const hasWrite = segment.some((step) => step.kind === "write");
      const guardedSegment = hasWrite ? [...activeGuards, ...segment] : segment;
      const materialized = materializeExternalFragment(
        segmentFragment(guardedSegment),
        runtimeValues
      );
      segment = [];
      validateFragment(materialized);
      const plan = this.compileToEntries(materialized);
      assertAtomicPlanCapacity(plan, driver, bindLimit);
      const tracer = progressiveTracer(this.engine, context);
      const planHasWrite = atomicPlanHasWrite(plan);
      let segmentCommitted = false;
      const committed = planHasWrite
        ? async () => {
            segmentCommitted = true;
            progress.committedSegments += 1;
            if (!commitState.writeCommitted) {
              commitState.writeCommitted = true;
              progress.committedWriteMembers += 1;
            }
            if (!committedWriteSegment) return;
            try {
              await committedWriteSegment();
            } catch (error) {
              throw attachProgress(error, progress, "invalidation", memberPath);
            }
          }
        : undefined;
      try {
        await observeProgressiveSegment(
          tracer,
          plan,
          memberPath,
          planHasWrite,
          () => segmentCommitted,
          () => this.executeEntries(plan, driver, context, committed)
        );
        mergeRuntimeValues(runtimeValues, plan.values);
      } catch (error) {
        if (hasRecordSeriesProgress(error)) throw error;
        throw attachProgress(error, progress, phase, memberPath);
      }
    };

    for (const step of fragment.steps) {
      if (step.kind !== "recordSeries") {
        segment.push(step);
        continue;
      }
      await flush();
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
        "member"
      );
      completedNestedSeries = true;
    }
    await flush();
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
    driver: AnyDriver,
    inheritedValues: RuntimeValues = new Map(),
    skipRootWriteId?: string
  ): Promise<T> {
    const planning = materializeExternalFragment(
      operation.planning(),
      inheritedValues
    );
    validateFragment(planning);
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
    committedWriteSegment?: CommittedWriteSegmentNotification
  ): Promise<T> {
    const driver = this.engine.driver;
    const fragment = await this.buildAtomicFragment(operation, driver, context);
    if (
      fragment.steps.some((step) => step.kind === "recordSeries") &&
      !driver.supportsTransactions &&
      driver.supportsOrderedCommittedSegments
    ) {
      return this.runProgressiveFragmentOperation<T>(
        operation,
        fragment,
        context,
        driver,
        committedWriteSegment
      );
    }
    const plan = this.compileToEntries(fragment);
    const outputs = await this.executeEntries(plan, driver, context);
    return operation.parse<T>(outputs);
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
    committedWriteSegment?: CommittedWriteSegmentNotification
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
          committedWriteSegment
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
      setProgressiveParentAttributes(
        progressiveTracer(this.engine, context),
        progress
      );
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
   * Execute one already-compiled statement-atomic plan directly: a single
   * round-trip on the base driver, its JS postcondition enforced after (no
   * partial state to roll back), the fragment's outputs assembled and parsed. The
   * statement carries no unresolved reference (checked in {@link
   * canExecuteDirectly}), so it runs as-is with no materialization pass.
   */
  private async runStatementAtomic<T>(
    plan: SingleStatementCandidate,
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
    return this.compileToEntries(
      await this.buildAtomicFragment(operation, driver, context)
    );
  }

  private async buildAtomicFragment(
    operation: ExecutableOperation,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<OperationFragment> {
    const planning = operation.planning();
    validateFragment(planning);
    const planningOutputs = await this.executePlanningLevels(
      planning,
      driver,
      context
    );
    const fragment = operation.compile(planningOutputs);
    validateFragment(fragment);
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
    values.set(step.id, extractOutputs(step, result));
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
  private compileToEntries(fragment: OperationFragment): AtomicPlan {
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

      if (step.kind === "write" && step.onUniqueConflict === "skip") {
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
        if (source.kind !== "insertId") continue;
        // A fragment result can read the provider's own insertId directly. Scratch is
        // required only when later SQL in this same atomic unit consumes the value.
        if (!consumedOutputs.has(`${step.id}.${output}`)) continue;
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
    context: QueryExecutionContext,
    committed?: CommittedWriteSegmentNotification
  ): Promise<Readonly<Record<string, unknown>>> {
    const { entries } = plan;
    const queries = entries.map((entry) => driver._prepare(entry.statement));

    let results: QueryResult<unknown>[];
    try {
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
      // An insert-branch loser inside the atomic unit surfaces its pinned unique
      // violation; classify it against any racePin so the retry layer above the
      // executor converges. The batch is one unit,
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

interface MutableRecordSeriesProgress {
  committedSegments: number;
  completedMembers: number;
  committedWriteMembers: number;
  totalMembers?: number;
}

function progressiveTracer(
  engine: QueryEngine,
  context: QueryExecutionContext
): TracerWrapper | undefined {
  return (
    getExecutionInstrumentation(context)?.tracer ??
    engine.instrumentation?.tracer
  );
}

async function observeProgressiveSegment(
  tracer: TracerWrapper | undefined,
  plan: AtomicPlan,
  memberPath: readonly number[],
  hasWrite: boolean,
  didCommit: () => boolean,
  execute: () => Promise<Readonly<Record<string, unknown>>>
): Promise<Readonly<Record<string, unknown>>> {
  if (!tracer) return execute();
  let succeeded = false;
  const spanAttributes = {
    [ATTR_VIBORM_WRITE_ATOMICITY]: "segment",
    [ATTR_VIBORM_WRITE_MEMBER_PATH]:
      memberPath.length === 0 ? "root" : memberPath.join("."),
    [ATTR_VIBORM_WRITE_STATEMENT_COUNT]: plan.entries.length,
  };
  return tracer.startActiveSpan(
    {
      name: SPAN_RECORD_SERIES_SEGMENT,
      attributes: spanAttributes,
    },
    async (span) => {
      try {
        const outputs = await execute();
        succeeded = true;
        return outputs;
      } finally {
        const outcome = hasWrite
          ? didCommit()
            ? "committed"
            : succeeded
              ? "unacknowledged"
              : "rolled_back"
          : "read_only";
        const attributes = {
          [ATTR_VIBORM_WRITE_COMMIT_OUTCOME]: outcome,
        };
        Object.assign(spanAttributes, attributes);
        if (span) {
          try {
            span.setAttributes(attributes);
          } catch {
            // Instrumentation never changes execution.
          }
        } else {
          // Existing custom tracers are allowed to omit an OpenTelemetry Span.
          // The optional active-span seam lets those tracers retain late outcome
          // attributes without making it a required implementation method.
          setTracerAttributes(tracer, attributes);
        }
      }
    }
  );
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
    ...(memberPath.length === 0 ? {} : { memberPath }),
    ...(progress.totalMembers === undefined
      ? {}
      : { totalMembers: progress.totalMembers }),
  });
}

function progressiveSeriesRefusal(
  driver: AnyDriver,
  reason: string
): UnsupportedOperationError {
  return new UnsupportedOperationError(
    `Driver '${driver.driverName}' cannot execute this record series as committed segments because ${reason}.`
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
  if (!(typeof limit === "number" && Number.isInteger(limit) && limit > 0)) {
    throw progressiveSeriesRefusal(
      driver,
      "the provider has no verified bound-parameter capacity"
    );
  }
  return limit;
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
  for (const value of statementReferences(step.statement)) {
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
  return createFailureError(
    failure,
    context.model ?? "record",
    context.operation ?? "query"
  );
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
    return {
      ...step,
      statement: materializeExternalSql(step.statement, localSteps, values),
    };
  });
  return "outputs" in fragment
    ? { steps, outputs: fragment.outputs }
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
