/**
 * History-aware reset. One lock. Clear, replay from null, then one marker CAS.
 * Never re-enters applyV1.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { admitLiveMigrationCapability } from "./admission";
import { canonicalizeJson } from "./canonical-json";
import { tableExistsProbe } from "./catalog-probes";
import { classifyStoredAtomicity } from "./compile";
import {
  appendLedger,
  casMarker,
  controlTableNames,
  DEFAULT_CONTROL_BASE,
  ensureControlTables,
  inspectControlPresence,
  markerFromPath,
  readLedger,
  readMarker,
  refuseIncompatibleHistory,
  refusePartialControl,
  unfinishedAttempts,
} from "./control";
import type { BoundMigrationDriver } from "./drivers";
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
import { withLockedMigrationProducer } from "./pinned-session";
import { getPushMigrationDriver, type MigrationClient } from "./push/planner";
import { fingerprintLive } from "./push-fingerprint";
import { introspectManaged } from "./push-plan";
import { encodeSqlText } from "./sql-blob";
import type { MigrationStorageWriter } from "./storage/contract";
import { assertEstateTargetMatches } from "./target";
import { encodeDispatchIdentity, encodeSqlBlob, eventIdFor } from "./v1-parse";
import type {
  MigrationDispatchV1,
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
      const presence = await inspectControlPresence(
        pinned,
        command,
        DEFAULT_CONTROL_BASE
      );
      if (presence.kind === "missing-table") {
        refusePartialControl(presence);
      }
      const marker = await readMarker(pinned, command, DEFAULT_CONTROL_BASE);
      const ledger = await readLedger(pinned, command, DEFAULT_CONTROL_BASE);
      const open = unfinishedAttempts(ledger);
      const resetAttempt = open.find((event) => event.kind === "reset-started");
      if (open.length > 0 && !resetAttempt) {
        throw new MigrationError(
          "An unfinished migration attempt is blocking reset",
          VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT
        );
      }
      if (!resetAttempt) {
        refuseIncompatibleHistory(marker, ledger);
      }
      const livePlan = await planLiveNamespaceReset(pinned, command, {
        trackingTable: "preserve",
        trackingTableName: names.state,
        preserveTables: [names.log],
      });
      if (presence.kind === "missing-table" && presence.table === "both") {
        await ensureControlTables(pinned, command, DEFAULT_CONTROL_BASE);
      }
      const clearSql = [
        ...livePlan.dropForeignKeys,
        ...livePlan.dropTables.map((table) => table.sql),
        ...livePlan.dropEnums,
      ];
      const clearDispatches = clearSql.map((sql) => dispatchForClearSql(sql));
      if (
        command.target.dialect === "mysql" &&
        (livePlan.dropForeignKeys.length > 0 || livePlan.dropEnums.length > 0)
      ) {
        throw new MigrationError(
          "Stepwise reset refuses clear dispatches without driver-owned pre/post proof",
          VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER
        );
      }
      const targetIdentity = `${command.target.dialect}:${command.namespace ?? ""}`;
      const planBody = {
        estateHash: graph.estateHash,
        targetIdentity,
        sourceRevision: marker?.revision ?? 0,
        sourceFingerprint: marker?.snapshotHash ?? graph.emptySnapshotHash,
        replayPath: path,
        clearDispatches,
        referencedStates: path,
      };
      const stored = resetAttempt?.resetPlan;
      if (stored) {
        assertStoredResetPlan(stored, planBody);
      }
      const resetPlanHash = stored
        ? stored.resetPlanHash
        : domainHash(HASH_DOMAIN.resetPlan, canonicalizeJson(planBody));
      const plan: ResetPlanV1 = stored ?? { ...planBody, resetPlanHash };
      const transactional =
        command.target.dialect !== "mysql" &&
        path.every((to, index) => {
          const from = index === 0 ? null : path[index - 1]!;
          const transition = parentTransition(graph, from, to);
          return (
            classifyStoredAtomicity(
              command,
              transition.requestedForwardBoundary,
              transition.operations,
              graph.sql.get(graph.states.get(to)!.sqlHash)
            ) === "transactional"
          );
        });
      if (!resetAttempt) {
        const started = {
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
        await appendLedger(pinned, command, DEFAULT_CONTROL_BASE, {
          ...started,
          eventId: eventIdFor(started),
        });
      }
      const run = async (producer: Parameters<typeof appendLedger>[0]) => {
        await executeResetClear(
          producer,
          command,
          livePlan,
          resetPlanHash,
          graph
        );
        await replayResetPath(producer, command, graph, path, resetPlanHash);
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
      if (transactional && pinned.supportsTransactions) {
        await pinned.withTransaction((transaction) => run(transaction));
      } else {
        await run(pinned);
      }
      return { preview: false, path };
    }
  );
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
  const dispatch = dispatchForClearSql(sql);
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

async function replayResetPath(
  pinned: Parameters<typeof executeOperations>[0],
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  path: readonly Sha256[],
  attemptId: Sha256
): Promise<void> {
  let from: Sha256 | null = null;
  for (const to of path) {
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
    await executeOperations(
      pinned,
      blob,
      transition.operations,
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
      }
    );
    if (
      state.destinationChecks.length > 0 &&
      !(await evaluateAllChecks(pinned, blob, state.destinationChecks))
    ) {
      throw new MigrationError(
        "Reset replay failed destination checks",
        VibORMErrorCode.MIGRATION_DRIFT
      );
    }
    from = to;
  }
}
