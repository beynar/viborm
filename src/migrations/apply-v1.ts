/**
 * Apply V1: authenticate the graph, lock, refuse drift, execute exact slices,
 * then CAS the marker. Production never evaluates TypeScript.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { admitLiveMigrationCapability } from "./admission";
import {
  assertTransactionalBoundaryHonored,
  classifyStoredAtomicity,
} from "./compile";
import {
  appendLedger,
  casMarker,
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
import { emptyManagedSnapshot } from "./empty-snapshot";
import { evaluateAllChecks, executeOperations } from "./execute-dispatch";
import {
  assertForeignKeysIntact,
  liftForeignKeyPragmas,
  withForeignKeysLifted,
} from "./foreign-keys";
import {
  loadMigrationGraph,
  type MigrationGraph,
  parentTransition,
  resolveStateSelector,
  selectRoute,
} from "./graph";
import type { Sha256 } from "./identity";
import {
  mayWrapTransaction,
  withLockedMigrationProducer,
} from "./pinned-session";
import { getPushMigrationDriver, type MigrationClient } from "./push/planner";
import { fingerprintLive } from "./push-fingerprint";
import { introspectManaged } from "./push-plan";
import { sliceDispatch } from "./sql-blob";
import type { MigrationStorageReader } from "./storage/contract";
import { assertEstateTargetMatches } from "./target";
import { eventIdFor } from "./v1-parse";
import type {
  ApplyV1Options,
  LedgerEventV1,
  MigrationMarkerV1,
} from "./v1-types";

export interface ApplyV1Result {
  readonly outcome: "applied" | "noop" | "preview";
  readonly path: readonly Sha256[];
  readonly statements: readonly string[];
}

export async function applyV1(
  client: MigrationClient,
  storage: MigrationStorageReader,
  options: ApplyV1Options = {}
): Promise<ApplyV1Result> {
  const graph = await loadMigrationGraph(storage);
  const driver = getPushMigrationDriver(client);
  assertEstateTargetMatches(graph.descriptor.target, driver.target);
  const target = resolveStateSelector(graph, options.to);
  const dryRun = options.dryRun === true;
  admitLiveMigrationCapability(
    driver,
    dryRun ? "read-only" : "effectful",
    dryRun ? "apply({ dryRun: true })" : "apply()"
  );

  if (dryRun) {
    const marker = await readMarker(
      client.$driver,
      driver,
      DEFAULT_CONTROL_BASE
    );
    const origin = marker?.stateId ?? null;
    if (origin === target) return { outcome: "noop", path: [], statements: [] };
    const path = selectRoute(graph, origin, target, options.via);
    assertPathArtifacts(graph, origin, path);
    return {
      outcome: "preview",
      path,
      statements: previewStatements(graph, origin, path),
    };
  }

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
        await ensureControlTables(pinned, command, DEFAULT_CONTROL_BASE);
      }
      const marker = await readMarker(pinned, command, DEFAULT_CONTROL_BASE);
      const ledger = await readLedger(pinned, command, DEFAULT_CONTROL_BASE);
      refuseIncompatibleHistory(marker, ledger);
      const unfinished = unfinishedAttempts(ledger);
      if (unfinished.length > 0) {
        throw new MigrationError(
          "An unfinished migration attempt is blocking ordinary work",
          VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT
        );
      }
      const origin = marker?.stateId ?? null;
      if (marker) {
        await assertNoDrift(pinned, command, graph, marker);
      } else {
        await assertEmptyManaged(pinned, command);
      }
      if (origin === target) {
        return { outcome: "noop", path: [], statements: [] };
      }
      const path = selectRoute(graph, origin, target, options.via);
      assertPathArtifacts(graph, origin, path);
      const statements = previewStatements(graph, origin, path);
      await applyPathUnderLock(pinned, command, graph, marker, origin, path);
      return { outcome: "applied", path, statements };
    }
  );
}

export async function applyPathUnderLock(
  pinned: import("../drivers/driver").AnyDriver,
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  marker: MigrationMarkerV1 | null,
  origin: Sha256 | null,
  path: readonly Sha256[]
): Promise<void> {
  const transactional = path.every((to, index) => {
    const from = index === 0 ? origin : path[index - 1]!;
    const transition = parentTransition(graph, from, to);
    assertTransactionalBoundaryHonored(
      pinned.supportsTransactions,
      transition.requestedForwardBoundary
    );
    return (
      classifyStoredAtomicity(
        command,
        transition.requestedForwardBoundary,
        transition.operations,
        graph.sql.get(graph.states.get(to)!.sqlHash)
      ) === "transactional"
    );
  });
  const run = async (producer: Parameters<typeof appendLedger>[0]) => {
    let from = origin;
    let current = marker;
    const nextPath = marker ? [...marker.path] : [];
    for (const to of path) {
      const transition = parentTransition(graph, from, to);
      const state = graph.states.get(to)!;
      const blob = graph.sql.get(state.sqlHash);
      if (!blob) {
        throw new MigrationError(
          "Selected transition is missing its SQL blob",
          VibORMErrorCode.MIGRATION_CORRUPTION
        );
      }
      const attemptId = eventIdFor({
        format: "1",
        attemptId: "0".repeat(64),
        kind: "started",
        estateHash: graph.estateHash,
        snapshotHash: state.snapshotHash,
        sqlHash: state.sqlHash,
        fromState: from,
        toState: to,
        transitionHash: transition.transitionHash,
        direction: "forward",
        operationId: null,
        dispatchId: null,
        effectState: "none",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        toolVersion: "v1",
        failure: null,
      });
      await appendLedger(
        producer,
        command,
        DEFAULT_CONTROL_BASE,
        ledgerEvent(
          graph,
          attemptId,
          "started",
          from,
          to,
          "none",
          null,
          null,
          transition.transitionHash
        )
      );
      const boundary = classifyStoredAtomicity(
        command,
        transition.requestedForwardBoundary,
        transition.operations,
        blob
      );
      if (!(await evaluateAllChecks(producer, blob, transition.originChecks))) {
        throw new MigrationError(
          "Origin checks failed before the first dispatch",
          VibORMErrorCode.MIGRATION_DRIFT
        );
      }
      await executeOperations(
        producer,
        blob,
        transition.operations,
        boundary,
        async (progress, effect) => {
          await appendLedger(
            producer,
            command,
            DEFAULT_CONTROL_BASE,
            ledgerEvent(
              graph,
              attemptId,
              "step-confirmed",
              from,
              to,
              effect,
              progress.operationId,
              progress.dispatchId,
              transition.transitionHash
            )
          );
        }
      );
      if (!(await evaluateAllChecks(producer, blob, state.destinationChecks))) {
        throw new MigrationError(
          "Destination checks failed before the marker could advance",
          VibORMErrorCode.MIGRATION_DRIFT
        );
      }
      await assertFingerprint(producer, command, graph, state.snapshotHash);
      nextPath.push({
        stateId: to,
        transitionHash: transition.transitionHash,
        baselineBoundary: false,
      });
      const next = markerFromPath(
        graph.estateHash,
        state.snapshotHash,
        nextPath,
        (current?.revision ?? 0) + 1
      );
      await casMarker(
        producer,
        command,
        DEFAULT_CONTROL_BASE,
        current
          ? { revision: current.revision, pathHash: current.pathHash }
          : null,
        next
      );
      await appendLedger(
        producer,
        command,
        DEFAULT_CONTROL_BASE,
        ledgerEvent(
          graph,
          attemptId,
          "applied",
          from,
          to,
          "committed",
          null,
          null,
          transition.transitionHash
        )
      );
      current = next;
      from = to;
    }
  };

  const lifted = liftForeignKeyPragmas(
    pinned,
    previewStatements(graph, origin, path)
  );
  if (mayWrapTransaction(pinned, command.target.dialect, transactional)) {
    await withForeignKeysLifted(pinned, lifted.bracket, () =>
      pinned.withTransaction(async (transaction) => {
        await run(transaction);
        await assertForeignKeysIntact(transaction, lifted.bracket);
      })
    );
  } else {
    await run(pinned);
  }
}

function assertPathArtifacts(
  graph: MigrationGraph,
  origin: Sha256 | null,
  path: readonly Sha256[]
): void {
  let from = origin;
  for (const to of path) {
    parentTransition(graph, from, to);
    const state = graph.states.get(to);
    if (!(state && graph.sql.has(state.sqlHash))) {
      throw new MigrationError(
        "Selected path references a state or SQL blob that is not authenticated",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    from = to;
  }
}

function previewStatements(
  graph: MigrationGraph,
  origin: Sha256 | null,
  path: readonly Sha256[]
): string[] {
  const statements: string[] = [];
  let from = origin;
  for (const to of path) {
    const transition = parentTransition(graph, from, to);
    const blob = graph.sql.get(graph.states.get(to)!.sqlHash);
    if (!blob) continue;
    for (const operation of transition.operations) {
      for (const step of operation.steps) {
        statements.push(sliceDispatch(blob, step.execute));
      }
    }
    from = to;
  }
  return statements;
}

export async function assertNoDrift(
  producer: Parameters<typeof introspectManaged>[0],
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  marker: MigrationMarkerV1
): Promise<void> {
  if (marker.estateHash !== graph.estateHash) {
    throw new MigrationError(
      "Live marker estate does not match storage",
      VibORMErrorCode.MIGRATION_DRIFT,
      { meta: { estateHash: marker.estateHash } }
    );
  }
  if (marker.stateId) {
    const state = graph.states.get(marker.stateId);
    if (!state) {
      throw new MigrationError(
        "Marker state is missing from the estate",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    if (state.snapshotHash !== marker.snapshotHash) {
      throw new MigrationError(
        "Marker snapshot does not match the authenticated state",
        VibORMErrorCode.MIGRATION_DRIFT
      );
    }
  } else if (marker.snapshotHash !== graph.emptySnapshotHash) {
    throw new MigrationError(
      "An empty-path marker must name the empty managed snapshot",
      VibORMErrorCode.MIGRATION_DRIFT
    );
  }
  if (marker.path.length === 0) {
    if (marker.stateId !== null) {
      throw new MigrationError(
        "Marker path does not end at the marked state",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
  } else {
    if (marker.path.at(-1)!.stateId !== marker.stateId) {
      throw new MigrationError(
        "Marker path does not end at the marked state",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    let from: Sha256 | null = null;
    for (const edge of marker.path) {
      const state = graph.states.get(edge.stateId);
      const parent = state?.parents.find(
        (item) =>
          item.transitionHash === edge.transitionHash && item.fromState === from
      );
      if (!(state && parent)) {
        throw new MigrationError(
          "Marker path is not an authenticated arrival route",
          VibORMErrorCode.MIGRATION_CORRUPTION
        );
      }
      from = edge.stateId;
    }
  }
  const snapshotHash = marker.stateId
    ? graph.states.get(marker.stateId)!.snapshotHash
    : graph.emptySnapshotHash;
  if (!graph.snapshots.get(snapshotHash)) {
    throw new MigrationError(
      "Marker snapshot is missing from the estate",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  await assertFingerprint(producer, command, graph, snapshotHash);
}

async function assertFingerprint(
  producer: Parameters<typeof introspectManaged>[0],
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  snapshotHash: Sha256
): Promise<void> {
  const live = await introspectManaged(producer, command);
  const expected =
    graph.snapshots.get(snapshotHash) ??
    (snapshotHash === graph.emptySnapshotHash ? emptyManagedSnapshot() : null);
  if (
    !expected ||
    (await fingerprintLive(live, command, producer)) !==
      (await fingerprintLive(expected, command, producer))
  ) {
    throw new MigrationError(
      "Live managed schema drifted from the authenticated snapshot",
      VibORMErrorCode.MIGRATION_DRIFT
    );
  }
}

async function assertEmptyManaged(
  producer: Parameters<typeof introspectManaged>[0],
  command: BoundMigrationDriver
): Promise<void> {
  const live = await introspectManaged(producer, command);
  if (live.tables.length > 0 || (live.enums?.length ?? 0) > 0) {
    throw new MigrationError(
      "Ordinary apply requires an empty managed target; use baseline to adopt an existing schema",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
}

function ledgerEvent(
  graph: MigrationGraph,
  attemptId: Sha256,
  kind: LedgerEventV1["kind"],
  from: Sha256 | null,
  to: Sha256,
  effectState: LedgerEventV1["effectState"],
  operationId: string | null = null,
  dispatchId: string | null = null,
  transitionHash: Sha256 | null = null
): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId,
    kind,
    estateHash: graph.estateHash,
    snapshotHash: graph.states.get(to)!.snapshotHash,
    sqlHash: graph.states.get(to)!.sqlHash,
    fromState: from,
    toState: to,
    transitionHash,
    direction: "forward" as const,
    operationId,
    dispatchId,
    effectState,
    startedAt: new Date().toISOString(),
    finishedAt: kind === "started" ? null : new Date().toISOString(),
    toolVersion: "v1",
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}
