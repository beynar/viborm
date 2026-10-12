/**
 * History-aware reset. One lock. Clear, replay from null, then one marker CAS.
 * Never re-enters applyV1.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { canonicalizeJson } from "./canonical-json";
import { tableExistsProbe } from "./catalog-probes";
import {
  assertTransactionalBoundaryHonored,
  classifyStoredAtomicity,
  groupContiguousAtomicity,
  stepStatements,
} from "./compile";
import {
  advanceMarker,
  appendLedger,
  controlTableNames,
  DEFAULT_CONTROL_BASE,
  ensureControlTables,
  ledgerEvent,
  markerFromPath,
  refuseIncompatibleHistory,
  sameMarker,
  unfinishedAttempts,
} from "./control";
import type { BoundMigrationDriver } from "./drivers";
import {
  assertAllChecks,
  executeExactSql,
  executeOperations,
} from "./execute-dispatch";
import {
  loadMigrationGraph,
  type MigrationGraph,
  parentTransition,
  requireStateSnapshot,
  resolveStateSelector,
  selectRoute,
} from "./graph";
import { domainHash, HASH_DOMAIN, type Sha256 } from "./identity";
import { planLiveNamespaceReset } from "./live-reset";
import {
  mayWrapTransaction,
  resolveCommandDriver,
  runProgram,
  withLockedMigrationProducer,
} from "./pinned-session";
import { assertLockedSinceDecision, proveLive } from "./proof";
import type { MigrationClient } from "./push/planner";
import { fingerprintLive } from "./push-fingerprint";
import { introspectManaged } from "./push-plan";
import {
  confirmedPrefix,
  openCommand,
  readCommandControl,
  refuseAmbiguousNext,
  sliceOperations,
} from "./resume";
import { encodeSqlText } from "./sql-blob";
import { canonicalizeSqliteStorage } from "./sqlite-storage-audit";
import type { MigrationStorageWriter } from "./storage/contract";
import { encodeDispatchIdentity, encodeSqlBlob } from "./v1-parse";
import type {
  LedgerEventV1,
  MarkerPathEdgeV1,
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
): Promise<{
  readonly preview: boolean;
  readonly path: readonly Sha256[];
  readonly tables?: readonly string[];
}> {
  const graph = await loadMigrationGraph(storage);
  const target = resolveStateSelector(graph, options.to);
  const path = selectRoute(graph, null, target, options.via);
  const dryRun = options.dryRun === true;
  const driver = openCommand(
    client,
    graph,
    dryRun ? "read-only" : "effectful",
    "reset()"
  );
  if (dryRun) {
    const command = await resolveCommandDriver(client.$driver, driver);
    await command.preflightSchemaRequirements(
      path.map((stateId) => requireStateSnapshot(graph, stateId)),
      (sql, params) => client.$driver._executeRaw(sql, params)
    );
    const names = controlTableNames(DEFAULT_CONTROL_BASE);
    const plan = await planLiveNamespaceReset(client.$driver, command, {
      trackingTable: "preserve",
      trackingTableName: names.state,
      preserveTables: [names.log],
    });
    return {
      preview: true,
      path,
      tables: plan.dropTables.map((table) => table.name),
    };
  }
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const names = controlTableNames(DEFAULT_CONTROL_BASE);
      const control = await readCommandControl(pinned, command, true);
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
      const targetSnapshot = requireStateSnapshot(graph, target);
      const targetSnapshotHash = graph.states.get(target)!.snapshotHash;
      await command.preflightSchemaRequirements(
        [
          requireStateSnapshot(graph, marker?.stateId ?? null),
          ...path.map((stateId) => requireStateSnapshot(graph, stateId)),
        ],
        (sql, params) => pinned._executeRaw(sql, params)
      );
      const edges: MarkerPathEdgeV1[] = path.map((stateId, index) => ({
        stateId,
        transitionHash: parentTransition(
          graph,
          index === 0 ? null : path[index - 1]!,
          stateId
        ).transitionHash,
        baselineBoundary: false,
      }));
      const resetEvent = {
        estateHash: graph.estateHash,
        snapshotHash: targetSnapshotHash,
        sqlHash: null,
        fromState: marker?.stateId ?? null,
        toState: target,
        transitionHash: null,
        direction: "reset",
        operationId: null,
        dispatchId: null,
      } as const;
      if (
        resetAttempt &&
        storedResetPlan &&
        marker &&
        resetMarkerProvesApplied(
          marker,
          graph,
          edges,
          targetSnapshotHash,
          storedResetPlan
        ) &&
        (await fingerprintLive(
          await introspectManaged(pinned, command),
          command,
          pinned
        )) === (await fingerprintLive(targetSnapshot, command, pinned))
      ) {
        await appendLedger(
          pinned,
          command,
          DEFAULT_CONTROL_BASE,
          ledgerEvent({
            ...resetEvent,
            attemptId: resetAttempt.attemptId,
            kind: "reset-applied",
            fromState: resetAttempt.fromState,
            effectState: "committed",
          })
        );
        return { preview: false, path };
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
      const begin =
        !resetAttempt || needsBootstrap
          ? async (producer: Parameters<typeof appendLedger>[0]) => {
              if (needsBootstrap) {
                await ensureControlTables(
                  producer,
                  command,
                  DEFAULT_CONTROL_BASE
                );
              }
              if (!resetAttempt) {
                await appendLedger(
                  producer,
                  command,
                  DEFAULT_CONTROL_BASE,
                  ledgerEvent({
                    ...resetEvent,
                    attemptId: resetPlanHash,
                    kind: "reset-started",
                    effectState: "none",
                    resetPlan: plan,
                    open: true,
                  })
                );
              }
            }
          : undefined;
      const finish = async (producer: Parameters<typeof appendLedger>[0]) => {
        await proveLive(
          producer,
          command,
          graph,
          targetSnapshotHash,
          () => "Reset replay did not reach the target snapshot"
        );
        await advanceMarker(
          producer,
          command,
          graph.estateHash,
          marker,
          edges,
          targetSnapshotHash
        );
        await appendLedger(
          producer,
          command,
          DEFAULT_CONTROL_BASE,
          ledgerEvent({
            ...resetEvent,
            attemptId: resetPlanHash,
            kind: "reset-applied",
            effectState: "committed",
          })
        );
      };
      await runProgram(pinned, command, undefined, (producer) =>
        executeResetProgram(
          pinned,
          producer,
          command,
          marker,
          graph,
          livePlan,
          plan,
          remaining,
          resetPlanHash,
          begin,
          finish,
          client.$schema
        )
      );
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
  edges: MigrationMarkerV1["path"],
  snapshotHash: Sha256,
  plan: ResetPlanV1
): boolean {
  const expected = markerFromPath(
    graph.estateHash,
    snapshotHash,
    edges,
    plan.sourceRevision + 1
  );
  return (
    marker.estateHash === expected.estateHash &&
    marker.stateId === expected.stateId &&
    marker.snapshotHash === expected.snapshotHash &&
    sameMarker(marker, expected)
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
  await appendLedger(
    pinned,
    command,
    DEFAULT_CONTROL_BASE,
    ledgerEvent({
      attemptId,
      kind: "reset-step-confirmed",
      estateHash: graph.estateHash,
      snapshotHash: graph.emptySnapshotHash,
      sqlHash: dispatch.sqlHash,
      fromState: null,
      toState: null,
      transitionHash: null,
      direction: "reset",
      operationId: null,
      dispatchId: dispatch.dispatchId,
      effectState: "committed",
    })
  );
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
  confirmedPrefix(
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
  const completedCount = confirmedPrefix(
    completed,
    "Reset replay progress is not a contiguous dispatch prefix"
  );
  if (
    [...announced].some(
      (index) => !completed.has(index) && index !== completedCount
    )
  ) {
    refuseResetProgress("Reset replay progress is not contiguous");
  }
  const next = steps[completedCount];
  refuseAmbiguousNext(
    next?.step,
    next?.edge.boundary,
    announced.has(completedCount),
    "The next reset dispatch has an ambiguous commit outcome"
  );
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

function refuseResetProgress(message: string): never {
  throw new MigrationError(message, VibORMErrorCode.MIGRATION_CORRUPTION);
}

async function executeResetProgram(
  pinned: Parameters<typeof executeOperations>[0],
  producer: Parameters<typeof executeOperations>[0],
  command: BoundMigrationDriver,
  marker: MigrationMarkerV1 | null,
  graph: MigrationGraph,
  livePlan: Awaited<ReturnType<typeof planLiveNamespaceReset>> | undefined,
  plan: ResetPlanV1,
  replay: readonly PreparedResetReplayEdge[],
  attemptId: Sha256,
  beforeFirstEffect:
    | ((producer: Parameters<typeof appendLedger>[0]) => Promise<void>)
    | undefined,
  finish: (producer: Parameters<typeof appendLedger>[0]) => Promise<void>,
  models: MigrationClient["$schema"]
): Promise<void> {
  const groups = groupContiguousAtomicity(replay, ({ blob, operations }) =>
    stepStatements(blob, operations)
  );
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
    const guarded = async (target: Parameters<typeof appendLedger>[0]) => {
      await assertLockedSinceDecision(pinned, target, command, marker, true);
      await body(target);
    };
    if (
      mayWrapTransaction(
        pinned,
        command.target.dialect,
        boundary === "transactional"
      )
    ) {
      await pinned.withTransaction(guarded);
    } else {
      await guarded(producer);
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
        await executeResetReplayEdge(
          target,
          command,
          graph,
          edge,
          attemptId,
          models
        );
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
  attemptId: Sha256,
  models: MigrationClient["$schema"]
): Promise<void> {
  const { from, to, transition, state, blob, boundary, operations } = edge;
  await executeOperations(
    pinned,
    blob,
    operations,
    boundary,
    (progress, effect) =>
      appendLedger(
        pinned,
        command,
        DEFAULT_CONTROL_BASE,
        ledgerEvent({
          attemptId,
          kind: "reset-step-confirmed",
          estateHash: graph.estateHash,
          snapshotHash: state.snapshotHash,
          sqlHash: state.sqlHash,
          fromState: from,
          toState: to,
          transitionHash: transition.transitionHash,
          direction: "reset",
          operationId: progress.operationId,
          dispatchId: progress.dispatchId,
          effectState: effect,
        })
      ),
    command.namespace
  );
  // Replayed manual SQL is canonicalized exactly as apply canonicalizes it.
  await canonicalizeSqliteStorage(
    pinned,
    operations,
    models,
    requireStateSnapshot(graph, to)
  );
  await assertAllChecks(
    pinned,
    blob,
    state.destinationChecks,
    command.namespace,
    "Reset replay failed destination checks"
  );
}
