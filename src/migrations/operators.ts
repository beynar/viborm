/**
 * V1 operator commands: status, verify, log, baseline, down, resolve, reset.
 * Status/verify/log are read-only and never bootstrap missing control tables.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { admitLiveMigrationCapability } from "./admission";
import { assertNoDrift } from "./apply-v1";
import { classifyStoredAtomicity } from "./compile";
import {
  appendLedger,
  casMarker,
  DEFAULT_CONTROL_BASE,
  ensureControlTables,
  inspectControlPresence,
  markerFromPath,
  readLedger,
  readMarker,
  refusePartialControl,
  unfinishedAttempts,
} from "./control";
import { emptyManagedSnapshot } from "./empty-snapshot";
import { evaluateAllChecks, executeOperations } from "./execute-dispatch";
import {
  loadMigrationGraph,
  type MigrationGraph,
  parentTransition,
  resolveStateSelector,
  selectRoute,
} from "./graph";
import type { Sha256 } from "./identity";
import { withLockedMigrationProducer } from "./pinned-session";
import { getPushMigrationDriver, type MigrationClient } from "./push/planner";
import { fingerprintLive } from "./push-fingerprint";
import { introspectManaged } from "./push-plan";
import type { MigrationStorageReader } from "./storage/contract";
import { assertEstateTargetMatches } from "./target";
import { eventIdFor } from "./v1-parse";
import type {
  BaselineOptions,
  DownV1Options,
  LedgerEventV1,
  MarkerPathEdgeV1,
  MigrationMarkerV1,
  ResolveV1Options,
} from "./v1-types";

export { resetV1 } from "./reset-v1";

export interface StatusV1Result {
  readonly control: "absent" | "present";
  readonly marker: Awaited<ReturnType<typeof readMarker>>;
  readonly pending: readonly Sha256[];
  readonly unfinished: boolean;
}

export async function statusV1(
  client: MigrationClient,
  storage: MigrationStorageReader
): Promise<StatusV1Result> {
  const graph = await loadMigrationGraph(storage);
  const driver = getPushMigrationDriver(client);
  assertEstateTargetMatches(graph.descriptor.target, driver.target);
  admitLiveMigrationCapability(driver, "read-only", "status()");
  const presence = await inspectControlPresence(
    client.$driver,
    driver,
    DEFAULT_CONTROL_BASE
  );
  if (presence.kind === "missing-table") {
    refusePartialControl(presence);
    return {
      control: "absent",
      marker: null,
      pending: [...graph.roots],
      unfinished: false,
    };
  }
  const marker = await readMarker(client.$driver, driver, DEFAULT_CONTROL_BASE);
  const ledger = await readLedger(client.$driver, driver, DEFAULT_CONTROL_BASE);
  const unfinished = unfinishedAttempts(ledger).length > 0;
  let pending: Sha256[] = [];
  if (graph.leaves.length === 1) {
    const leaf = graph.leaves[0]!;
    if ((marker?.stateId ?? null) !== leaf) {
      pending = [...selectRoute(graph, marker?.stateId ?? null, leaf)];
    }
  }
  return { control: "present", marker, pending, unfinished };
}

export async function verifyV1(
  client: MigrationClient,
  storage: MigrationStorageReader
): Promise<{ readonly ok: boolean }> {
  const graph = await loadMigrationGraph(storage);
  const driver = getPushMigrationDriver(client);
  assertEstateTargetMatches(graph.descriptor.target, driver.target);
  admitLiveMigrationCapability(driver, "effectful", "verify()");
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const presence = await inspectControlPresence(
        pinned,
        command,
        DEFAULT_CONTROL_BASE
      );
      if (presence.kind === "missing-table") {
        refusePartialControl(presence);
        throw new MigrationError(
          "verify requires present control tables",
          VibORMErrorCode.MIGRATION_NOT_FOUND
        );
      }
      const marker = await readMarker(pinned, command, DEFAULT_CONTROL_BASE);
      if (!marker) {
        throw new MigrationError(
          "verify requires a migration marker",
          VibORMErrorCode.MIGRATION_NOT_FOUND
        );
      }
      await assertNoDrift(pinned, command, graph, marker);
      return { ok: true };
    }
  );
}

export async function logV1(
  client: MigrationClient
): Promise<readonly LedgerEventV1[]> {
  const driver = getPushMigrationDriver(client);
  admitLiveMigrationCapability(driver, "read-only", "log()");
  const presence = await inspectControlPresence(
    client.$driver,
    driver,
    DEFAULT_CONTROL_BASE
  );
  if (presence.kind === "missing-table") {
    refusePartialControl(presence);
    throw new MigrationError(
      "log requires present control tables",
      VibORMErrorCode.MIGRATION_NOT_FOUND
    );
  }
  return readLedger(client.$driver, driver, DEFAULT_CONTROL_BASE);
}

export async function baselineV1(
  client: MigrationClient,
  storage: MigrationStorageReader,
  options: BaselineOptions
): Promise<{ readonly stateId: Sha256 }> {
  const graph = await loadMigrationGraph(storage);
  const driver = getPushMigrationDriver(client);
  assertEstateTargetMatches(graph.descriptor.target, driver.target);
  admitLiveMigrationCapability(driver, "effectful", "baseline()");
  const target = resolveStateSelector(graph, options.to);
  const path = selectRoute(graph, null, target, options.via);
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const presence = await inspectControlPresence(
        pinned,
        command,
        DEFAULT_CONTROL_BASE
      );
      if (presence.kind === "missing-table") {
        refusePartialControl(presence);
      }
      await ensureControlTables(pinned, command, DEFAULT_CONTROL_BASE);
      const marker = await readMarker(pinned, command, DEFAULT_CONTROL_BASE);
      const ledger = await readLedger(pinned, command, DEFAULT_CONTROL_BASE);
      if (marker || ledger.length > 0) {
        throw new MigrationError(
          "baseline requires an unmarked database with an empty ledger",
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }
      for (const [index, stateId] of path.entries()) {
        const from = index === 0 ? null : path[index - 1]!;
        const transition = parentTransition(graph, from, stateId);
        const parentSnapshot =
          from === null
            ? graph.emptySnapshotHash
            : graph.states.get(from)?.snapshotHash;
        const childSnapshot = graph.states.get(stateId)?.snapshotHash;
        if (
          transition.operations.some(
            (operation) =>
              operation.origin === "manual" || operation.risk === "opaque"
          ) ||
          parentSnapshot === childSnapshot
        ) {
          throw new MigrationError(
            "baseline refuses a path containing manual, opaque, or data-only transitions",
            VibORMErrorCode.MIGRATION_INVALID_STATE
          );
        }
      }
      const live = await introspectManaged(pinned, command);
      const expected = graph.snapshots.get(
        graph.states.get(target)!.snapshotHash
      );
      if (
        !expected ||
        (await fingerprintLive(live, command, pinned)) !==
          (await fingerprintLive(expected, command, pinned))
      ) {
        throw new MigrationError(
          "baseline requires exact live equality with the target snapshot",
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
        baselineBoundary: index === 0,
      }));
      const next = markerFromPath(
        graph.estateHash,
        graph.states.get(target)!.snapshotHash,
        edges,
        1
      );
      await casMarker(pinned, command, DEFAULT_CONTROL_BASE, null, next);
      const event = {
        format: "1" as const,
        attemptId: next.pathHash,
        kind: "baselined" as const,
        estateHash: graph.estateHash,
        snapshotHash: next.snapshotHash,
        sqlHash: null,
        fromState: null,
        toState: target,
        transitionHash: null,
        direction: "baseline" as const,
        operationId: null,
        dispatchId: null,
        effectState: "none" as const,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        toolVersion: "v1",
        failure: null,
      };
      await appendLedger(pinned, command, DEFAULT_CONTROL_BASE, {
        ...event,
        eventId: eventIdFor(event),
      });
      return { stateId: target };
    }
  );
}

export async function downV1(
  client: MigrationClient,
  storage: MigrationStorageReader,
  options: DownV1Options = {}
): Promise<{ readonly path: readonly Sha256[]; readonly preview: boolean }> {
  const graph = await loadMigrationGraph(storage);
  const driver = getPushMigrationDriver(client);
  assertEstateTargetMatches(graph.descriptor.target, driver.target);
  const dryRun = options.dryRun === true;
  admitLiveMigrationCapability(
    driver,
    dryRun ? "read-only" : "effectful",
    "down()"
  );
  if (dryRun) {
    const marker = await readMarker(
      client.$driver,
      driver,
      DEFAULT_CONTROL_BASE
    );
    if (!marker) {
      throw new MigrationError(
        "Nothing to roll back",
        VibORMErrorCode.MIGRATION_NOT_FOUND
      );
    }
    const removed = rollbackSlice(graph, marker, options);
    return { path: removed.map((edge) => edge.stateId), preview: true };
  }
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const marker = await readMarker(pinned, command, DEFAULT_CONTROL_BASE);
      if (!marker) {
        throw new MigrationError(
          "Nothing to roll back",
          VibORMErrorCode.MIGRATION_NOT_FOUND
        );
      }
      const removed = rollbackSlice(graph, marker, options);
      if (removed.length === 0) return { path: [], preview: false };
      const unfinished = unfinishedAttempts(
        await readLedger(pinned, command, DEFAULT_CONTROL_BASE)
      );
      if (unfinished.length > 0) {
        throw new MigrationError(
          "An unfinished migration attempt is blocking ordinary work",
          VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT
        );
      }
      await assertNoDrift(pinned, command, graph, marker);
      const reverse = [...removed].reverse();
      for (const edge of reverse) {
        assertReversibleEdge(graph, edge);
      }
      let current = marker;
      for (const edge of reverse) {
        const state = graph.states.get(edge.stateId)!;
        const parent = state.parents.find(
          (item) => item.transitionHash === edge.transitionHash
        )!;
        const blob = graph.sql.get(state.sqlHash)!;
        const rollback = parent.rollback;
        if (rollback.kind === "irreversible") {
          throw new MigrationError(
            rollback.reason,
            VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
          );
        }
        const boundary =
          rollback.kind === "manual"
            ? classifyStoredAtomicity(
                command,
                rollback.requestedBoundary,
                rollback.operations,
                blob
              )
            : classifyStoredAtomicity(command, null, rollback.operations, blob);
        await executeOperations(pinned, blob, rollback.operations, boundary);
        if (
          parent.originChecks.length > 0 &&
          !(await evaluateAllChecks(pinned, blob, parent.originChecks))
        ) {
          throw new MigrationError(
            "Origin checks failed after rollback",
            VibORMErrorCode.MIGRATION_DRIFT
          );
        }
        const nextPath = current.path.slice(0, -1);
        const nextState = nextPath.at(-1)?.stateId ?? null;
        const snapshotHash = nextState
          ? graph.states.get(nextState)!.snapshotHash
          : graph.emptySnapshotHash;
        const next = markerFromPath(
          graph.estateHash,
          snapshotHash,
          nextPath,
          current.revision + 1
        );
        await casMarker(
          pinned,
          command,
          DEFAULT_CONTROL_BASE,
          {
            revision: current.revision,
            pathHash: current.pathHash,
          },
          next
        );
        const event = {
          format: "1" as const,
          attemptId: next.pathHash,
          kind: "rolled-back" as const,
          estateHash: graph.estateHash,
          snapshotHash,
          sqlHash: state.sqlHash,
          fromState: edge.stateId,
          toState: nextState,
          transitionHash: edge.transitionHash,
          direction: "rollback" as const,
          operationId: null,
          dispatchId: null,
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
        current = next;
      }
      return { path: removed.map((edge) => edge.stateId), preview: false };
    }
  );
}

export async function resolveV1(
  client: MigrationClient,
  storage: MigrationStorageReader,
  options: ResolveV1Options
): Promise<{ readonly outcome: ResolveV1Options["outcome"] }> {
  const graph = await loadMigrationGraph(storage);
  const driver = getPushMigrationDriver(client);
  assertEstateTargetMatches(graph.descriptor.target, driver.target);
  admitLiveMigrationCapability(driver, "effectful", "resolve()");
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const ledger = await readLedger(pinned, command, DEFAULT_CONTROL_BASE);
      const open = unfinishedAttempts(ledger);
      if (open.length === 0) {
        throw new MigrationError(
          "resolve requires an unfinished attempt",
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }
      const attempt = open[0]!;
      if (attempt.kind === "reset-started") {
        throw new MigrationError(
          "An unfinished reset can only be resumed by reset()",
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }
      const to = attempt.toState;
      const from = attempt.fromState;
      if (!to) {
        throw new MigrationError(
          "Unfinished attempt is missing its target state",
          VibORMErrorCode.MIGRATION_CORRUPTION
        );
      }
      const state = graph.states.get(to);
      if (!state) {
        throw new MigrationError(
          "Unfinished attempt target is absent from the estate",
          VibORMErrorCode.MIGRATION_CORRUPTION
        );
      }
      const blob = graph.sql.get(state.sqlHash);
      if (!blob) {
        throw new MigrationError(
          "SQL blob is missing",
          VibORMErrorCode.MIGRATION_CORRUPTION
        );
      }
      const transition = parentTransition(graph, from, to);
      const live = await introspectManaged(pinned, command);
      const destSnapshot = graph.snapshots.get(state.snapshotHash);
      const originSnapshot =
        from === null
          ? emptyManagedSnapshot()
          : graph.snapshots.get(graph.states.get(from)!.snapshotHash);
      const destHolds =
        destSnapshot !== undefined &&
        (await fingerprintLive(live, command, pinned)) ===
          (await fingerprintLive(destSnapshot, command, pinned)) &&
        (await evaluateAllChecks(pinned, blob, state.destinationChecks));
      const originHolds =
        originSnapshot !== undefined &&
        (await fingerprintLive(live, command, pinned)) ===
          (await fingerprintLive(originSnapshot, command, pinned)) &&
        (await evaluateAllChecks(pinned, blob, transition.originChecks));
      const opaque = transition.operations.some((operation) =>
        operation.steps.some((step) => step.retry === "opaque")
      );
      if (options.outcome === "complete") {
        if (!destHolds || (opaque && state.destinationChecks.length === 0)) {
          throw new MigrationError(
            "resolve cannot mark complete without destination proof",
            VibORMErrorCode.MIGRATION_INVALID_STATE
          );
        }
        await finishResolve(pinned, command, graph, attempt, "applied", to);
        return { outcome: "complete" };
      }
      if (options.outcome === "rolled-back") {
        if (!originHolds || (opaque && transition.originChecks.length === 0)) {
          throw new MigrationError(
            "resolve cannot mark rolled back without origin proof",
            VibORMErrorCode.MIGRATION_INVALID_STATE
          );
        }
        await finishResolve(
          pinned,
          command,
          graph,
          attempt,
          "rolled-back",
          from
        );
        return { outcome: "rolled-back" };
      }
      if (opaque) {
        throw new MigrationError(
          "resolve cannot retry an opaque dispatch without origin or destination proof",
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }
      const boundary = classifyStoredAtomicity(
        command,
        transition.requestedForwardBoundary,
        transition.operations,
        blob
      );
      await executeOperations(pinned, blob, transition.operations, boundary);
      if (!(await evaluateAllChecks(pinned, blob, state.destinationChecks))) {
        throw new MigrationError(
          "Retry did not reach the destination",
          VibORMErrorCode.MIGRATION_DRIFT
        );
      }
      const liveAfter = await introspectManaged(pinned, command);
      if (
        !destSnapshot ||
        (await fingerprintLive(liveAfter, command, pinned)) !==
          (await fingerprintLive(destSnapshot, command, pinned))
      ) {
        throw new MigrationError(
          "Retry did not reach the destination",
          VibORMErrorCode.MIGRATION_DRIFT
        );
      }
      await finishResolve(pinned, command, graph, attempt, "applied", to);
      return { outcome: "retry" };
    }
  );
}

async function finishResolve(
  pinned: Parameters<typeof appendLedger>[0],
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  attempt: LedgerEventV1,
  kind: "applied" | "rolled-back",
  to: Sha256 | null
): Promise<void> {
  const marker = await readMarker(pinned, command, DEFAULT_CONTROL_BASE);
  if (kind === "applied" && to && marker?.stateId !== to) {
    const transition = parentTransition(graph, attempt.fromState, to);
    const nextPath = [
      ...(marker?.path ?? []),
      {
        stateId: to,
        transitionHash: attempt.transitionHash ?? transition.transitionHash,
        baselineBoundary: false,
      },
    ];
    const next = markerFromPath(
      graph.estateHash,
      graph.states.get(to)!.snapshotHash,
      nextPath,
      (marker?.revision ?? 0) + 1
    );
    await casMarker(
      pinned,
      command,
      DEFAULT_CONTROL_BASE,
      marker ? { revision: marker.revision, pathHash: marker.pathHash } : null,
      next
    );
  }
  if (kind === "rolled-back" && marker && marker.stateId === attempt.toState) {
    const nextPath = marker.path.slice(0, -1);
    const nextState = nextPath.at(-1)?.stateId ?? null;
    const snapshotHash = nextState
      ? graph.states.get(nextState)!.snapshotHash
      : graph.emptySnapshotHash;
    const next = markerFromPath(
      graph.estateHash,
      snapshotHash,
      nextPath,
      marker.revision + 1
    );
    await casMarker(
      pinned,
      command,
      DEFAULT_CONTROL_BASE,
      {
        revision: marker.revision,
        pathHash: marker.pathHash,
      },
      next
    );
  }
  const event = {
    format: "1" as const,
    attemptId: attempt.attemptId,
    kind: "resolved" as const,
    estateHash: graph.estateHash,
    snapshotHash: to
      ? graph.states.get(to)!.snapshotHash
      : graph.emptySnapshotHash,
    sqlHash: attempt.sqlHash,
    fromState: attempt.fromState,
    toState: to,
    transitionHash: attempt.transitionHash,
    direction: "resolve" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
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

function assertReversibleEdge(
  graph: MigrationGraph,
  edge: MarkerPathEdgeV1
): void {
  const state = graph.states.get(edge.stateId);
  if (!state) {
    throw new MigrationError(
      "Rollback target is missing from the estate",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  const parent = state.parents.find(
    (item) => item.transitionHash === edge.transitionHash
  );
  if (!parent) {
    throw new MigrationError(
      "Rollback cannot find the arrival transition",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  if (parent.rollback.kind === "irreversible") {
    throw new MigrationError(
      parent.rollback.reason,
      VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
    );
  }
  if (!graph.sql.get(state.sqlHash)) {
    throw new MigrationError(
      "Rollback SQL blob is missing",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
}

function rollbackSlice(
  graph: MigrationGraph,
  marker: MigrationMarkerV1,
  options: DownV1Options
): MigrationMarkerV1["path"] {
  if (marker.path.length === 0) {
    throw new MigrationError(
      "Nothing to roll back",
      VibORMErrorCode.MIGRATION_NOT_FOUND
    );
  }
  const steps =
    "to" in options && options.to
      ? distanceTo(
          marker.path.map((edge) => edge.stateId),
          resolveStateSelector(graph, options.to)
        )
      : (options.steps ?? 1);
  if (steps <= 0) return [];
  const removed = marker.path.slice(-steps);
  if (removed.some((edge) => edge.baselineBoundary)) {
    throw new MigrationError(
      "down cannot cross a baseline boundary",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  return removed;
}

function distanceTo(path: readonly Sha256[], target: Sha256): number {
  const index = path.lastIndexOf(target);
  if (index < 0) {
    throw new MigrationError(
      "down target is not on the arrival path",
      VibORMErrorCode.MIGRATION_NOT_FOUND
    );
  }
  return path.length - 1 - index;
}
