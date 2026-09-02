/**
 * Unit F — the committed-segments enforcer (pattern-engine-ideal-state.md
 * §8.2): the batch enforcer applied to a list of fragments, with two
 * additions. Inherited premises (the parent's liveness and the exact
 * referenced tuple) are re-asserted as guards in every later fragment that
 * writes, and the merge-outcome cut is honored: a skippable root observed with
 * no row skips its dependents. Progress is reported as `recordSeriesProgress`
 * in today's shape, a committed prefix is never replayed, and only the current
 * member is retried after one (once) on a retryable race.
 *
 * Acknowledgement is the driver's strongest truthful one, exactly as today's
 * `executeProgressiveAtomicPlan`: an ordered-committed driver reports the
 * commit before decoding; a weaker batch driver acknowledges after a normalized
 * result, and a dispatched failure before that boundary stays conservatively
 * visible (`mayHaveCommittedSegment`).
 */
import type { AnyDriver } from "@drivers";
import {
  attachRecordSeriesProgress,
  hasRecordSeriesProgress,
  type RecordSeriesProgress,
  UniqueConstraintError,
  UnsupportedOperationError,
} from "@errors";
import { validateFragment } from "../../write-engine/FragmentValidator";
import type { GuardStep } from "../../write-engine/OperationFragment";
import { isRetryableRace } from "../../write-engine/race-retry";
import type { Fragment } from "../fragment";
import {
  type AtomicUnit,
  type BatchRun,
  compileUnit,
  guardSteps,
  runMatchLevels,
  runUnit,
  SkippedMergeRoot,
} from "./batch";
import { type MemberGroup, memberCount, memberGroups } from "./segments-layout";
import {
  type Attribution,
  attributionOf,
  materializeBatchSql,
  mergeRuntimeValues,
  packFragment,
  type RuntimeValues,
  resolveProgramOutputs,
} from "./values";

interface MutableProgress {
  committedSegments: number;
  completedMembers: number;
  committedWriteMembers: number;
  mayHaveCommittedSegment?: true;
  totalMembers?: number;
}

interface CommitState {
  writeCommitted: boolean;
}

export async function executeInSegments(
  run: BatchRun
): Promise<Readonly<Record<string, unknown>>> {
  const progress: MutableProgress = {
    committedSegments: 0,
    completedMembers: 0,
    committedWriteMembers: 0,
  };
  const members = memberCount(run.program);
  if (members !== undefined) progress.totalMembers = members;
  const attribution = attributionOf(run.program);
  const values: RuntimeValues = new Map();
  try {
    const bindLimit = progressiveBindLimit(run.driver);
    let shared: CommitState = { writeCommitted: false };
    for (const group of memberGroups(run.program)) {
      const commitState: CommitState =
        group.member === undefined ? shared : { writeCommitted: false };
      if (group.member === undefined) shared = commitState;
      await runGroup(
        group,
        run,
        values,
        progress,
        commitState,
        attribution,
        bindLimit,
        members !== undefined
      );
      if (group.member !== undefined) progress.completedMembers += 1;
    }
  } catch (error) {
    if (hasRecordSeriesProgress(error)) throw error;
    throw attachProgress(error, progress, "planning");
  }
  try {
    const outputs = resolveProgramOutputs(run.program, values, run.rows);
    if (members === undefined) progress.completedMembers += 1;
    return outputs;
  } catch (error) {
    throw attachProgress(error, progress, "result");
  }
}

async function runGroup(
  group: MemberGroup,
  run: BatchRun,
  values: RuntimeValues,
  progress: MutableProgress,
  commitState: CommitState,
  attribution: Attribution,
  bindLimit: number,
  programHasMembers: boolean
): Promise<void> {
  const memberPath = group.member === undefined ? [] : [group.member];
  const phases = phasesFor(group.member, programHasMembers);
  for (const fragment of group.fragments) {
    const skipped = await runFragmentSegment(
      fragment,
      group,
      run,
      values,
      progress,
      commitState,
      attribution,
      bindLimit,
      memberPath,
      phases
    );
    if (skipped) return;
  }
}

interface Phases {
  readonly match: RecordSeriesProgress["phase"];
  readonly unit: RecordSeriesProgress["phase"];
}

/**
 * Today's phase names, read from the layout: before the first member the
 * fragments are the series' capture and prefix; a member's own match phase is
 * its planning; a program without members reports as the generated-output
 * fallback does (planning, member, result).
 */
function phasesFor(
  member: number | undefined,
  programHasMembers: boolean
): Phases {
  if (member === undefined && programHasMembers) {
    return { match: "capture", unit: "prefix" };
  }
  return { match: "planning", unit: "member" };
}

async function runFragmentSegment(
  fragment: Fragment,
  group: MemberGroup,
  run: BatchRun,
  values: RuntimeValues,
  progress: MutableProgress,
  commitState: CommitState,
  attribution: Attribution,
  bindLimit: number,
  memberPath: readonly number[],
  phases: Phases
): Promise<boolean> {
  let attemptedRetry = false;
  while (true) {
    const startSegments = progress.committedSegments;
    const attemptValues = new Map(values);
    const retryable = (error: unknown) =>
      group.member !== undefined &&
      progress.committedSegments === startSegments &&
      progress.committedSegments > 0 &&
      !attemptedRetry &&
      isRetryableRace(error);
    try {
      await runMatchLevels(
        fragment,
        run.driver,
        attemptValues,
        run.context,
        attribution
      );
    } catch (error) {
      if (retryable(error)) {
        attemptedRetry = true;
        continue;
      }
      if (hasRecordSeriesProgress(error)) throw error;
      throw attachProgress(error, progress, phases.match, memberPath);
    }
    try {
      // The arm the matches decided, re-packed with their results (§6.3).
      const packed = packFragment(fragment, attemptValues);
      const unit = compileUnit(packed, run.driver, attemptValues, {
        inherited: inheritedGuards(fragment, attemptValues),
        attribution,
        ...(group.mergeRoot ? { mergeRoot: group.mergeRoot } : {}),
      });
      assertSegmentCapacity(unit, run.driver, bindLimit);
      const outcome = await runSegment(
        unit,
        run,
        progress,
        commitState,
        attribution,
        memberPath
      );
      if (outcome.skippedRoot) return true;
      mergeRuntimeValues(values, unit.values);
      return false;
    } catch (error) {
      if (error instanceof SkippedMergeRoot) return true;
      if (hasRecordSeriesProgress(error)) throw error;
      if (retryable(error)) {
        attemptedRetry = true;
        continue;
      }
      throw attachProgress(error, progress, phases.unit, memberPath);
    }
  }
}

/**
 * The fragment's inherited premises as guards, materialized against what the
 * committed prefix bound. They repeat in every later unit that writes.
 */
function inheritedGuards(
  fragment: Fragment,
  values: RuntimeValues
): GuardStep[] {
  return guardSteps(fragment.inherited).map((guard) => {
    const materialized: GuardStep = {
      ...guard,
      premise: {
        ...guard.premise,
        statement: materializeBatchSql(guard.premise.statement, values),
      },
    };
    validateFragment({ steps: [materialized], outputs: {} });
    return materialized;
  });
}

async function runSegment(
  unit: AtomicUnit,
  run: BatchRun,
  progress: MutableProgress,
  commitState: CommitState,
  attribution: Attribution,
  memberPath: readonly number[]
): Promise<{ readonly skippedRoot: boolean }> {
  const { driver } = run;
  let segmentCommitted = false;
  let countedCommittedWriteMember = false;
  let invalidationFailure: { readonly error: unknown } | undefined;
  let dispatched = false;
  const committed = unit.hasWrite
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
          await run.committedWriteSegment?.();
        } catch (error) {
          invalidationFailure = { error };
        }
      }
    : undefined;
  try {
    const outcome = await runUnit(
      unit,
      driver,
      run.context,
      attribution,
      driver.supportsOrderedCommittedSegments ? committed : undefined,
      () => {
        dispatched = true;
      }
    );
    if (unit.hasWrite && !driver.supportsOrderedCommittedSegments) {
      await committed?.();
    }
    if (
      outcome.skippedRoot &&
      countedCommittedWriteMember &&
      commitState.writeCommitted
    ) {
      commitState.writeCommitted = false;
      progress.committedWriteMembers -= 1;
    }
    if (invalidationFailure) {
      throw attachProgress(
        invalidationFailure.error,
        progress,
        "invalidation",
        memberPath
      );
    }
    return outcome;
  } catch (error) {
    if (hasRecordSeriesProgress(error)) throw error;
    const rolledBack =
      error instanceof UniqueConstraintError ||
      error instanceof SkippedMergeRoot ||
      isRetryableRace(error);
    if (invalidationFailure) {
      throw attachProgress(
        new AggregateError(
          [error, invalidationFailure.error],
          "Committed segment decoding and cache invalidation both failed."
        ),
        progress,
        "invalidation",
        memberPath
      );
    }
    if (
      unit.hasWrite &&
      dispatched &&
      !segmentCommitted &&
      !driver.supportsOrderedCommittedSegments &&
      !rolledBack
    ) {
      progress.mayHaveCommittedSegment = true;
      try {
        await run.writeMayBeVisible?.();
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

function attachProgress(
  error: unknown,
  progress: MutableProgress,
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

function progressiveRefusal(
  driver: AnyDriver,
  reason: string
): UnsupportedOperationError {
  return new UnsupportedOperationError(
    `Driver '${driver.driverName}' cannot execute this record series as committed segments because ${reason}.`
  );
}

function progressiveBindLimit(driver: AnyDriver): number {
  if (!driver.supportsBatch) {
    throw progressiveRefusal(
      driver,
      "the provider does not expose an atomic batch substrate"
    );
  }
  const limit = driver.maxBindParametersPerStatement;
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0
    ? limit
    : Number.POSITIVE_INFINITY;
}

function assertSegmentCapacity(
  unit: AtomicUnit,
  driver: AnyDriver,
  limit: number
): void {
  for (const entry of unit.entries) {
    if (entry.statement.values.length > limit) {
      throw progressiveRefusal(
        driver,
        `one member statement needs ${entry.statement.values.length} bound values, above the verified limit of ${limit}`
      );
    }
  }
}
