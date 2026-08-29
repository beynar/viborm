/**
 * History-aware reset. One lock. Clear, replay from null, then one marker CAS.
 * Never re-enters applyV1.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { admitLiveMigrationCapability } from "./admission";
import { canonicalizeJson } from "./canonical-json";
import { tableExistsProbe } from "./catalog-probes";
import {
  assertTransactionalBoundaryHonored,
  classifyStoredAtomicity,
  groupContiguousAtomicity,
} from "./compile";
import {
  appendLedger,
  casMarker,
  controlTableNames,
  DEFAULT_CONTROL_BASE,
  ensureControlTables,
  markerFromPath,
  readControlState,
  refuseIncompatibleHistory,
  refusePartialControl,
  unfinishedAttempts,
} from "./control";
import type { BoundMigrationDriver } from "./drivers";
import { emptyManagedSnapshot } from "./empty-snapshot";
import {
  evaluateAllChecks,
  executeExactSql,
  executeOperations,
} from "./execute-dispatch";
import {
  loadMigrationGraph,
  type MigrationGraph,
  parentTransition,
  resolveStateSelector,
  selectRoute,
} from "./graph";
import { domainHash, HASH_DOMAIN, type Sha256 } from "./identity";
import { planLiveNamespaceReset } from "./live-reset";
import {
  mayWrapTransaction,
  runSequentialProgram,
  withLockedMigrationProducer,
} from "./pinned-session";
import { getPushMigrationDriver, type MigrationClient } from "./push/planner";
import { fingerprintLive } from "./push-fingerprint";
import { introspectManaged } from "./push-plan";
import { encodeSqlText } from "./sql-blob";
import type { MigrationStorageWriter } from "./storage/contract";
import { assertEstateTargetMatches } from "./target";
import { encodeDispatchIdentity, encodeSqlBlob, eventIdFor } from "./v1-parse";
import type {
  LedgerEventV1,
  MigrationDispatchV1,
  MigrationMarkerV1,
  MigrationOperationV1,
  MigrationStateManifestV1,
  ResetPlanV1,
  ResetV1Options,
} from "./v1-types";

export async function resetV1(
  client: MigrationClient,
  storage: MigrationStorageWriter,
  options: ResetV1Options = {}
): Promise<{ readonly preview: boolean; readonly path: readonly Sha256[] }> {
  const graph = await loadMigrationGraph(storage);
  const target = resolveStateSelector(graph, options.to);
  const path = selectRoute(graph, null, target, options.via);
  const driver = getPushMigrationDriver(client);
  assertEstateTargetMatches(graph.descriptor.target, driver.target);
  const dryRun = options.dryRun === true;
  admitLiveMigrationCapability(
    driver,
    dryRun ? "read-only" : "effectful",
    "reset()"
  );
  if (dryRun) return { preview: true, path };
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const names = controlTableNames(DEFAULT_CONTROL_BASE);
      const control = await readControlState(
        pinned,
        command,
        DEFAULT_CONTROL_BASE
      );
      if (control.presence.kind === "missing-table") {
        refusePartialControl(control.presence);
      }
      const { marker, ledger } = control;
      const needsBootstrap = control.presence.kind !== "present";
      const open = unfinishedAttempts(ledger);
      const resetAttempt =
        open.length === 1 && open[0]!.kind === "reset-started"
          ? open[0]!
          : undefined;
      if (open.length > 0 && !resetAttempt) {
        throw new MigrationError(
          "An unfinished migration attempt is blocking reset",
          VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT
        );
      }
      const targetIdentity = `${command.target.dialect}:${command.namespace ?? ""}`;
      const storedResetPlan = resetAttempt
        ? matchingResetPlan(resetAttempt, graph, target, path, targetIdentity)
        : undefined;
      if (!resetAttempt) {
        refuseIncompatibleHistory(marker, ledger);
      }
      if (resetAttempt && storedResetPlan && marker) {
        const targetState = graph.states.get(target);
        const expected =
          targetState === undefined
            ? undefined
            : (graph.snapshots.get(targetState.snapshotHash) ??
              (targetState.snapshotHash === graph.emptySnapshotHash
                ? emptyManagedSnapshot()
                : undefined));
        if (
          targetState &&
          expected &&
          resetMarkerProvesApplied(
            marker,
            graph,
            target,
            path,
            storedResetPlan
          ) &&
          (await fingerprintLive(
            await introspectManaged(pinned, command),
            command,
            pinned
          )) === (await fingerprintLive(expected, command, pinned))
        ) {
          const applied = {
            format: "1" as const,
            attemptId: resetAttempt.attemptId,
            kind: "reset-applied" as const,
            estateHash: graph.estateHash,
            snapshotHash: marker.snapshotHash,
            sqlHash: null,
            fromState: resetAttempt.fromState,
            toState: target,
            transitionHash: null,
            direction: "reset" as const,
            operationId: null,
            dispatchId: null,
            effectState: "committed" as const,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            toolVersion: "v1",
            failure: null,
          };
          await appendLedger(pinned, command, DEFAULT_CONTROL_BASE, {
            ...applied,
            eventId: eventIdFor(applied),
          });
          return { preview: false, path };
        }
      }
      if (
        resetAttempt &&
        storedResetPlan &&
        !resetSourceMarkerMatches(
          marker,
          resetAttempt,
          storedResetPlan,
          graph.emptySnapshotHash
        )
      ) {
        throw new MigrationError(
          "The unfinished reset source marker no longer matches its plan",
          VibORMErrorCode.MIGRATION_MARKER_CONFLICT
        );
      }
      const hasReplayEvidence = resetAttempt
        ? ledger.some(
            (event) =>
              event.attemptId === resetAttempt.attemptId &&
              event.kind === "reset-step-confirmed" &&
              (event.fromState !== null ||
                event.toState !== null ||
                event.transitionHash !== null ||
                event.operationId !== null)
          )
        : false;
      const livePlan = hasReplayEvidence
        ? undefined
        : await planLiveNamespaceReset(pinned, command, {
            trackingTable: "preserve",
            trackingTableName: names.state,
            preserveTables: [names.log],
          });
      const clearSql = livePlan
        ? [
            ...livePlan.dropForeignKeys,
            ...livePlan.dropTables.map((table) => table.sql),
            ...livePlan.dropEnums,
          ]
        : [];
      const clearDispatches = clearSql.map((sql) => dispatchForClearSql(sql));
      if (
        livePlan &&
        command.target.dialect === "mysql" &&
        (livePlan.dropForeignKeys.length > 0 || livePlan.dropEnums.length > 0)
      ) {
        throw new MigrationError(
          "Stepwise reset refuses clear dispatches without driver-owned pre/post proof",
          VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER
        );
      }
      const planBody = {
        estateHash: graph.estateHash,
        targetIdentity,
        sourceRevision: marker?.revision ?? 0,
        sourceFingerprint: marker?.snapshotHash ?? graph.emptySnapshotHash,
        replayPath: path,
        clearDispatches,
        referencedStates: path,
      };
      const stored = storedResetPlan;
      if (stored && livePlan) {
        assertStoredResetPlan(stored, planBody);
      }
      const resetPlanHash = stored
        ? stored.resetPlanHash
        : domainHash(HASH_DOMAIN.resetPlan, canonicalizeJson(planBody));
      const plan: ResetPlanV1 = stored ?? { ...planBody, resetPlanHash };
      const prepared = prepareResetReplay(
        pinned.supportsTransactions,
        command,
        graph,
        path
      );
      const remaining = resetAttempt
        ? remainingResetReplay(graph, prepared, resetAttempt, plan, ledger)
        : prepared;
      const started = resetAttempt
        ? undefined
        : {
            format: "1" as const,
            attemptId: resetPlanHash,
            kind: "reset-started" as const,
            estateHash: graph.estateHash,
            snapshotHash: graph.states.get(target)!.snapshotHash,
            sqlHash: null,
            fromState: marker?.stateId ?? null,
            toState: target,
            transitionHash: null,
            direction: "reset" as const,
            operationId: null,
            dispatchId: null,
            effectState: "none" as const,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            toolVersion: "v1",
            resetPlan: plan,
            failure: null,
          };
      const begin =
        started || needsBootstrap
          ? async (producer: Parameters<typeof appendLedger>[0]) => {
              if (needsBootstrap) {
                await ensureControlTables(
                  producer,
                  command,
                  DEFAULT_CONTROL_BASE
                );
              }
              if (started) {
                await appendLedger(producer, command, DEFAULT_CONTROL_BASE, {
                  ...started,
                  eventId: eventIdFor(started),
                });
              }
            }
          : undefined;
      const finish = async (producer: Parameters<typeof appendLedger>[0]) => {
        const live = await introspectManaged(producer, command);
        const expected = graph.snapshots.get(
          graph.states.get(target)!.snapshotHash
        );
        if (
          !expected ||
          (await fingerprintLive(live, command, producer)) !==
            (await fingerprintLive(expected, command, producer))
        ) {
          throw new MigrationError(
            "Reset replay did not reach the target snapshot",
            VibORMErrorCode.MIGRATION_DRIFT
          );
        }
        const edges = path.map((stateId, index) => ({
          stateId,
          transitionHash: parentTransition(
            graph,
            index === 0 ? null : path[index - 1]!,
            stateId
          ).transitionHash,
          baselineBoundary: false,
        }));
        const next = markerFromPath(
          graph.estateHash,
          graph.states.get(target)!.snapshotHash,
          edges,
          (marker?.revision ?? 0) + 1
        );
        await casMarker(
          producer,
          command,
          DEFAULT_CONTROL_BASE,
          marker
            ? { revision: marker.revision, pathHash: marker.pathHash }
            : null,
          next
        );
        const applied = {
          format: "1" as const,
          attemptId: resetPlanHash,
          kind: "reset-applied" as const,
          estateHash: graph.estateHash,
          snapshotHash: next.snapshotHash,
          sqlHash: null,
          fromState: marker?.stateId ?? null,
          toState: target,
          transitionHash: null,
          direction: "reset" as const,
          operationId: null,
          dispatchId: null,
          effectState: "committed" as const,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          toolVersion: "v1",
          failure: null,
        };
        await appendLedger(producer, command, DEFAULT_CONTROL_BASE, {
          ...applied,
          eventId: eventIdFor(applied),
        });
      };
      const run = async (producer: Parameters<typeof appendLedger>[0]) => {
        await executeResetProgram(
          pinned,
          producer,
          command,
          graph,
          livePlan,
          plan,
          remaining,
          resetPlanHash,
          begin,
          finish
        );
      };
      if (command.target.dialect === "mysql") {
        await runSequentialProgram(pinned, command, run);
      } else {
        await run(pinned);
      }
      return { preview: false, path };
    }
  );
}

function matchingResetPlan(
  attempt: LedgerEventV1,
  graph: MigrationGraph,
  target: Sha256,
  path: readonly Sha256[],
  targetIdentity: string
): ResetPlanV1 {
  const targetState = graph.states.get(target);
  const plan = attempt.resetPlan;
  const sourceSnapshotHash =
    attempt.fromState === null
      ? graph.emptySnapshotHash
      : graph.states.get(attempt.fromState)?.snapshotHash;
  if (
    !(targetState && plan) ||
    attempt.direction !== "reset" ||
    attempt.attemptId !== plan.resetPlanHash ||
    attempt.estateHash !== graph.estateHash ||
    attempt.snapshotHash !== targetState.snapshotHash ||
    attempt.toState !== target ||
    plan.estateHash !== graph.estateHash ||
    plan.targetIdentity !== targetIdentity ||
    plan.sourceFingerprint !== sourceSnapshotHash ||
    !sameIds(plan.replayPath, path) ||
    !sameIds(plan.referencedStates, path)
  ) {
    throw new MigrationError(
      "The unfinished reset does not match the requested reset",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  return plan;
}

function resetMarkerProvesApplied(
  marker: MigrationMarkerV1,
  graph: MigrationGraph,
  target: Sha256,
  path: readonly Sha256[],
  plan: ResetPlanV1
): boolean {
  const targetState = graph.states.get(target);
  if (!targetState) return false;
  const edges = path.map((stateId, index) => ({
    stateId,
    transitionHash: parentTransition(
      graph,
      index === 0 ? null : path[index - 1]!,
      stateId
    ).transitionHash,
    baselineBoundary: false,
  }));
  const expected = markerFromPath(
    graph.estateHash,
    targetState.snapshotHash,
    edges,
    plan.sourceRevision + 1
  );
  return (
    marker.estateHash === expected.estateHash &&
    marker.stateId === expected.stateId &&
    marker.snapshotHash === expected.snapshotHash &&
    marker.pathHash === expected.pathHash &&
    marker.revision === expected.revision
  );
}

function resetSourceMarkerMatches(
  marker: MigrationMarkerV1 | null,
  attempt: LedgerEventV1,
  plan: ResetPlanV1,
  emptySnapshotHash: Sha256
): boolean {
  return marker
    ? marker.stateId === attempt.fromState &&
        marker.revision === plan.sourceRevision &&
        marker.snapshotHash === plan.sourceFingerprint
    : attempt.fromState === null &&
        plan.sourceRevision === 0 &&
        plan.sourceFingerprint === emptySnapshotHash;
}

function assertStoredResetPlan(
  stored: ResetPlanV1,
  live: Omit<ResetPlanV1, "resetPlanHash">
): void {
  if (stored.estateHash !== live.estateHash) {
    throw new MigrationError(
      "A stored reset plan does not match the current estate",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  if (stored.targetIdentity !== live.targetIdentity) {
    throw new MigrationError(
      "A stored reset plan does not match the current target",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  if (
    stored.sourceRevision !== live.sourceRevision ||
    stored.sourceFingerprint !== live.sourceFingerprint
  ) {
    throw new MigrationError(
      "A stored reset plan does not match the current marker",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  if (!sameIds(stored.replayPath, live.replayPath)) {
    throw new MigrationError(
      "A stored reset plan does not match the requested replay path",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  const storedIds = new Set(
    stored.clearDispatches.map((dispatch) => dispatch.dispatchId)
  );
  for (const dispatch of live.clearDispatches) {
    if (!storedIds.has(dispatch.dispatchId)) {
      throw new MigrationError(
        "Live remaining reset clears are not in the stored reset plan",
        VibORMErrorCode.MIGRATION_INVALID_STATE
      );
    }
  }
}

function sameIds(left: readonly Sha256[], right: readonly Sha256[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

function dispatchForClearSql(sql: string): MigrationDispatchV1 {
  const bytes = encodeSqlText(sql);
  const sqlHash = encodeSqlBlob(bytes);
  return {
    dispatchId: encodeDispatchIdentity(sqlHash, 0, bytes.length, []),
    sqlHash,
    offset: 0,
    length: bytes.length,
    parameters: [],
  };
}

async function executeResetClear(
  pinned: Parameters<typeof executeExactSql>[0],
  command: Parameters<typeof planLiveNamespaceReset>[1],
  livePlan: Awaited<ReturnType<typeof planLiveNamespaceReset>>,
  attemptId: Sha256,
  graph: MigrationGraph
): Promise<void> {
  for (const sql of livePlan.dropForeignKeys) {
    await executeExactSql(pinned, sql);
    await confirmResetStep(pinned, command, graph, attemptId, sql);
  }
  for (const table of livePlan.dropTables) {
    const pre = tableExistsProbe(command, table.name, true);
    const post = tableExistsProbe(command, table.name, false);
    if (!(await evaluateProbe(pinned, pre))) {
      await confirmResetStep(pinned, command, graph, attemptId, table.sql);
      continue;
    }
    await executeExactSql(pinned, table.sql);
    if (!(await evaluateProbe(pinned, post))) {
      throw new MigrationError(
        `Reset clear did not drop table ${table.name}`,
        VibORMErrorCode.MIGRATION_PARTIAL_EFFECT
      );
    }
    await confirmResetStep(pinned, command, graph, attemptId, table.sql);
  }
  for (const sql of livePlan.dropEnums) {
    await executeExactSql(pinned, sql);
    await confirmResetStep(pinned, command, graph, attemptId, sql);
  }
}

async function evaluateProbe(
  pinned: Parameters<typeof executeExactSql>[0],
  probe: ReturnType<typeof tableExistsProbe>
): Promise<boolean> {
  const result = await pinned._executeRaw<Record<string, unknown>>(
    probe.sql,
    probe.parameters.map((parameter) =>
      parameter.kind === "string" ? parameter.value : null
    )
  );
  const value = Object.values(result.rows[0] ?? {})[0];
  return (
    (value === true || value === 1 || value === "1" || value === "t") ===
    probe.equals
  );
}

async function confirmResetStep(
  pinned: Parameters<typeof appendLedger>[0],
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  attemptId: Sha256,
  sql: string
): Promise<void> {
  await confirmResetDispatch(
    pinned,
    command,
    graph,
    attemptId,
    dispatchForClearSql(sql)
  );
}

async function confirmResetDispatch(
  pinned: Parameters<typeof appendLedger>[0],
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  attemptId: Sha256,
  dispatch: MigrationDispatchV1
): Promise<void> {
  const event = {
    format: "1" as const,
    attemptId,
    kind: "reset-step-confirmed" as const,
    estateHash: graph.estateHash,
    snapshotHash: graph.emptySnapshotHash,
    sqlHash: dispatch.sqlHash,
    fromState: null,
    toState: null,
    transitionHash: null,
    direction: "reset" as const,
    operationId: null,
    dispatchId: dispatch.dispatchId,
    effectState: "committed" as const,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    toolVersion: "v1",
    failure: null,
  };
  await appendLedger(pinned, command, DEFAULT_CONTROL_BASE, {
    ...event,
    eventId: eventIdFor(event),
  });
}

interface PreparedResetReplayEdge {
  readonly from: Sha256 | null;
  readonly to: Sha256;
  readonly transition: ReturnType<typeof parentTransition>;
  readonly state: MigrationStateManifestV1;
  readonly blob: Uint8Array;
  readonly boundary: "transactional" | "stepwise";
  readonly operations: readonly MigrationOperationV1[];
}

function prepareResetReplay(
  supportsTransactions: boolean,
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  path: readonly Sha256[]
): readonly PreparedResetReplayEdge[] {
  return path.map((to, index) => {
    const from = index === 0 ? null : path[index - 1]!;
    const transition = parentTransition(graph, from, to);
    const state = graph.states.get(to);
    if (!state) {
      throw new MigrationError(
        "Reset replay target is missing",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    const blob = graph.sql.get(state.sqlHash);
    if (!blob) {
      throw new MigrationError(
        "Reset replay SQL blob is missing",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    const boundary = classifyStoredAtomicity(
      command,
      transition.requestedForwardBoundary,
      transition.operations,
      blob
    );
    assertTransactionalBoundaryHonored(
      supportsTransactions,
      transition.requestedForwardBoundary
    );
    return {
      from,
      to,
      transition,
      state,
      blob,
      boundary,
      operations: transition.operations,
    };
  });
}

function remainingResetReplay(
  graph: MigrationGraph,
  prepared: readonly PreparedResetReplayEdge[],
  attempt: LedgerEventV1,
  plan: ResetPlanV1,
  ledger: readonly LedgerEventV1[]
): readonly PreparedResetReplayEdge[] {
  const clearByDispatch = new Map(
    plan.clearDispatches.map((dispatch, index) => [dispatch.dispatchId, index])
  );
  const clearCommitted = new Set<number>();
  const steps = prepared.flatMap((edge, edgeIndex) =>
    edge.operations.flatMap((operation) =>
      operation.steps.map((step) => ({ edge, edgeIndex, operation, step }))
    )
  );
  const byDispatch = new Map(
    steps.map((entry, index) => [entry.step.execute.dispatchId, index])
  );
  const completed = new Set<number>();
  const announced = new Set<number>();
  let hasReplayEvidence = false;
  for (const event of ledger) {
    if (
      event.attemptId !== attempt.attemptId ||
      event.kind !== "reset-step-confirmed"
    ) {
      continue;
    }
    if (
      event.direction !== "reset" ||
      event.estateHash !== graph.estateHash ||
      !event.dispatchId
    ) {
      refuseResetProgress(
        "Reset progress does not match its authenticated plan"
      );
    }
    const isClear =
      event.fromState === null &&
      event.toState === null &&
      event.transitionHash === null &&
      event.operationId === null;
    if (isClear) {
      const clearIndex = clearByDispatch.get(event.dispatchId);
      if (
        clearIndex === undefined ||
        event.sqlHash !== plan.clearDispatches[clearIndex]!.sqlHash ||
        event.snapshotHash !== graph.emptySnapshotHash ||
        event.effectState !== "committed"
      ) {
        refuseResetProgress("Reset clear progress names an unknown dispatch");
      }
      clearCommitted.add(clearIndex);
      continue;
    }
    hasReplayEvidence = true;
    const index = byDispatch.get(event.dispatchId);
    if (index === undefined) {
      refuseResetProgress("Reset replay progress names an unknown dispatch");
    }
    const entry = steps[index];
    if (
      !entry ||
      event.fromState !== entry.edge.from ||
      event.toState !== entry.edge.to ||
      event.transitionHash !== entry.edge.transition.transitionHash ||
      event.snapshotHash !== entry.edge.state.snapshotHash ||
      event.sqlHash !== entry.edge.state.sqlHash ||
      event.operationId !== entry.operation.id
    ) {
      refuseResetProgress("Reset replay progress names an unknown dispatch");
    }
    if (event.effectState === "committed") {
      completed.add(index);
    } else if (event.effectState === "none") {
      if (entry.step.retry === "proven") completed.add(index);
      else announced.add(index);
    } else {
      throw new MigrationError(
        "Reset replay progress has an ambiguous commit outcome",
        VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT
      );
    }
  }
  assertContiguousPrefix(
    clearCommitted,
    "Reset clear progress is not a contiguous dispatch prefix"
  );
  if (
    hasReplayEvidence &&
    clearCommitted.size !== plan.clearDispatches.length
  ) {
    refuseResetProgress(
      "Reset replay progress exists before the clear prefix is complete"
    );
  }
  if (!hasReplayEvidence) return prepared;
  const completedCount = contiguousPrefixLength(completed);
  if ([...completed].some((index) => index >= completedCount)) {
    refuseResetProgress(
      "Reset replay progress is not a contiguous dispatch prefix"
    );
  }
  if (
    [...announced].some(
      (index) => !completed.has(index) && index !== completedCount
    )
  ) {
    refuseResetProgress("Reset replay progress is not contiguous");
  }
  const next = steps[completedCount];
  if (
    next?.step.retry === "opaque" &&
    next.edge.boundary === "stepwise" &&
    announced.has(completedCount)
  ) {
    throw new MigrationError(
      "The next reset dispatch has an ambiguous commit outcome",
      VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
      {
        meta: {
          lastConfirmedStep: next.step.execute.dispatchId,
          effectState: "may-have-committed",
          partial: true,
        },
      }
    );
  }
  const verificationEdge =
    completedCount === 0 ? undefined : steps[completedCount - 1]?.edgeIndex;
  let skipped = completedCount;
  return prepared.flatMap((edge, edgeIndex) => {
    const operationCount = edge.operations.reduce(
      (count, operation) => count + operation.steps.length,
      0
    );
    if (skipped >= operationCount) {
      skipped -= operationCount;
      return edgeIndex === verificationEdge
        ? [{ ...edge, operations: [] }]
        : [];
    }
    const operations = sliceOperations(edge.operations, skipped);
    skipped = 0;
    return [{ ...edge, operations }];
  });
}

function sliceOperations(
  operations: readonly MigrationOperationV1[],
  skip: number
): readonly MigrationOperationV1[] {
  let remaining = skip;
  return operations.flatMap((operation) => {
    if (remaining >= operation.steps.length) {
      remaining -= operation.steps.length;
      return [];
    }
    const steps = operation.steps.slice(remaining);
    remaining = 0;
    return [{ ...operation, steps }];
  });
}

function contiguousPrefixLength(indices: ReadonlySet<number>): number {
  let length = 0;
  while (indices.has(length)) length += 1;
  return length;
}

function assertContiguousPrefix(
  indices: ReadonlySet<number>,
  message: string
): void {
  const length = contiguousPrefixLength(indices);
  if ([...indices].some((index) => index >= length)) {
    refuseResetProgress(message);
  }
}

function refuseResetProgress(message: string): never {
  throw new MigrationError(message, VibORMErrorCode.MIGRATION_CORRUPTION);
}

async function executeResetProgram(
  pinned: Parameters<typeof executeOperations>[0],
  producer: Parameters<typeof executeOperations>[0],
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  livePlan: Awaited<ReturnType<typeof planLiveNamespaceReset>> | undefined,
  plan: ResetPlanV1,
  replay: readonly PreparedResetReplayEdge[],
  attemptId: Sha256,
  beforeFirstEffect:
    | ((producer: Parameters<typeof appendLedger>[0]) => Promise<void>)
    | undefined,
  finish: (producer: Parameters<typeof appendLedger>[0]) => Promise<void>
): Promise<void> {
  const groups = groupContiguousAtomicity(replay);
  const liveClearDispatches = new Set(
    livePlan
      ? [
          ...livePlan.dropForeignKeys,
          ...livePlan.dropTables.map((table) => table.sql),
          ...livePlan.dropEnums,
        ].map((sql) => dispatchForClearSql(sql).dispatchId)
      : []
  );
  let clearPending =
    livePlan &&
    (livePlan.dropForeignKeys.length > 0 ||
      livePlan.dropTables.length > 0 ||
      livePlan.dropEnums.length > 0)
      ? livePlan
      : undefined;
  let clearEvidencePending = livePlan !== undefined;
  let admissionPending = beforeFirstEffect;
  const runBoundary = async (
    boundary: "transactional" | "stepwise",
    body: (target: Parameters<typeof appendLedger>[0]) => Promise<void>
  ) => {
    if (
      mayWrapTransaction(
        pinned,
        command.target.dialect,
        boundary === "transactional"
      )
    ) {
      await pinned.withTransaction(body);
    } else {
      await body(producer);
    }
  };
  const completeClearEvidence = async (
    target: Parameters<typeof appendLedger>[0]
  ) => {
    for (const dispatch of plan.clearDispatches) {
      if (!liveClearDispatches.has(dispatch.dispatchId)) {
        await confirmResetDispatch(target, command, graph, attemptId, dispatch);
      }
    }
  };
  const admit = async (target: Parameters<typeof appendLedger>[0]) => {
    const pending = admissionPending;
    if (!pending) return;
    admissionPending = undefined;
    await pending(target);
  };
  if (clearPending && groups[0]?.boundary === "stepwise") {
    const clear = clearPending;
    clearPending = undefined;
    await runBoundary("transactional", async (target) => {
      await admit(target);
      await executeResetClear(target, command, clear, attemptId, graph);
      await completeClearEvidence(target);
      clearEvidencePending = false;
    });
  }
  if (!clearPending && groups[0]?.boundary === "stepwise" && admissionPending) {
    await runBoundary("transactional", admit);
  }
  if (groups.length === 0) {
    await runBoundary("transactional", async (target) => {
      await admit(target);
      if (clearPending) {
        await executeResetClear(
          target,
          command,
          clearPending,
          attemptId,
          graph
        );
      }
      if (clearEvidencePending) {
        await completeClearEvidence(target);
        clearEvidencePending = false;
      }
      await finish(target);
    });
    return;
  }
  for (const [index, group] of groups.entries()) {
    await runBoundary(group.boundary, async (target) => {
      await admit(target);
      if (clearPending) {
        await executeResetClear(
          target,
          command,
          clearPending,
          attemptId,
          graph
        );
        clearPending = undefined;
      }
      if (clearEvidencePending) {
        await completeClearEvidence(target);
        clearEvidencePending = false;
      }
      for (const edge of group.items) {
        await executeResetReplayEdge(target, command, graph, edge, attemptId);
      }
      if (index === groups.length - 1) await finish(target);
    });
  }
}

async function executeResetReplayEdge(
  pinned: Parameters<typeof executeOperations>[0],
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  edge: PreparedResetReplayEdge,
  attemptId: Sha256
): Promise<void> {
  const { from, to, transition, state, blob, boundary, operations } = edge;
  await executeOperations(
    pinned,
    blob,
    operations,
    boundary,
    async (progress, effect) => {
      const event = {
        format: "1" as const,
        attemptId,
        kind: "reset-step-confirmed" as const,
        estateHash: graph.estateHash,
        snapshotHash: state.snapshotHash,
        sqlHash: state.sqlHash,
        fromState: from,
        toState: to,
        transitionHash: transition.transitionHash,
        direction: "reset" as const,
        operationId: progress.operationId,
        dispatchId: progress.dispatchId,
        effectState: effect,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        toolVersion: "v1",
        failure: null,
      };
      await appendLedger(pinned, command, DEFAULT_CONTROL_BASE, {
        ...event,
        eventId: eventIdFor(event),
      });
    },
    command.namespace
  );
  if (
    state.destinationChecks.length > 0 &&
    !(await evaluateAllChecks(
      pinned,
      blob,
      state.destinationChecks,
      command.namespace
    ))
  ) {
    throw new MigrationError(
      "Reset replay failed destination checks",
      VibORMErrorCode.MIGRATION_DRIFT
    );
  }
}
