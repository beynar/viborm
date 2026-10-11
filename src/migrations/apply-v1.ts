/**
 * Apply V1: authenticate the graph, lock, refuse drift, execute exact slices,
 * then CAS the marker. Production never evaluates TypeScript.
 */

import { isVibORMError, MigrationError, VibORMErrorCode } from "../errors";
import { admitLiveMigrationCapability } from "./admission";
import {
  assertTransactionalBoundaryHonored,
  classifyStoredAtomicity,
  groupContiguousAtomicity,
  stepStatements,
} from "./compile";
import {
  appendLedger,
  casMarker,
  DEFAULT_CONTROL_BASE,
  ensureControlTables,
  markerFromPath,
  readControlState,
  refuseIncompatibleHistory,
  refusePartialControl,
  unfinishedAttempts,
} from "./control";
import { diff } from "./differ";
import type { BoundMigrationDriver } from "./drivers";
import { emptyManagedSnapshot } from "./empty-snapshot";
import { evaluateAllChecks, executeOperations } from "./execute-dispatch";
import { liftForeignKeyPragmas, withForeignKeysLifted } from "./foreign-keys";
import {
  loadMigrationGraph,
  type MigrationGraph,
  parentTransition,
  requireStateSnapshot,
  resolveStateSelector,
  selectRoute,
} from "./graph";
import type { Sha256 } from "./identity";
import {
  lockedSinceDecision,
  mayWrapTransaction,
  runSequentialProgram,
  withLockedMigrationProducer,
} from "./pinned-session";
import { getPushMigrationDriver, type MigrationClient } from "./push/planner";
import { fingerprintLive } from "./push-fingerprint";
import { introspectManaged } from "./push-plan";
import { canonicalizeSqliteStorage } from "./sqlite-storage-audit";
import type { MigrationStorageReader } from "./storage/contract";
import { assertEstateTargetMatches } from "./target";
import { eventIdFor } from "./v1-parse";
import type {
  ApplyV1Options,
  LedgerEventV1,
  MarkerPathEdgeV1,
  MigrationMarkerV1,
  MigrationStateManifestV1,
} from "./v1-types";

export interface ApplyV1Result {
  readonly outcome: "applied" | "noop" | "preview";
  readonly path: readonly Sha256[];
  readonly statements: readonly string[];
  /**
   * Present only when the migration committed but releasing a session lock
   * failed after it (MySQL, PostgreSQL). The session was discarded, so the
   * lock does not outlive it.
   */
  readonly warnings?: readonly string[];
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
    const control = await readControlState(
      client.$driver,
      driver,
      DEFAULT_CONTROL_BASE
    );
    refusePartialControl(control.presence);
    const { marker } = control;
    if (followsAheadPolicy(graph, marker, options)) {
      return { outcome: "noop", path: [], statements: [] };
    }
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

  // Set once the path committed: a failure after it is the lock's release.
  const committed: { result?: ApplyV1Result } = {};
  const locked = withLockedMigrationProducer<ApplyV1Result>(
    client.$driver,
    driver,
    async (pinned, command) => {
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
      refuseIncompatibleHistory(marker, ledger);
      const unfinished = unfinishedAttempts(ledger);
      if (unfinished.length > 0) {
        throw new MigrationError(
          "An unfinished migration attempt is blocking ordinary work",
          VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT
        );
      }
      if (followsAheadPolicy(graph, marker, options)) {
        return { outcome: "noop", path: [], statements: [] };
      }
      const origin = marker?.stateId ?? null;
      const path =
        origin === target
          ? []
          : selectRoute(graph, origin, target, options.via);
      assertPathArtifacts(graph, origin, path);
      const statements = previewStatements(graph, origin, path);
      await command.preflightSchemaRequirements(
        [
          requireStateSnapshot(graph, origin),
          ...path.map((stateId) => requireStateSnapshot(graph, stateId)),
        ],
        (sql, params) => pinned._executeRaw(sql, params),
        statements
      );
      if (marker) {
        await assertNoDrift(pinned, command, graph, marker);
      } else {
        await assertEmptyManaged(pinned, command);
      }
      if (origin === target) {
        return { outcome: "noop", path: [], statements: [] };
      }
      const run = async (producer: Parameters<typeof appendLedger>[0]) => {
        await applyPathUnderLock(
          producer,
          command,
          graph,
          marker,
          origin,
          path,
          client.$schema,
          needsBootstrap
        );
      };
      if (command.target.dialect === "mysql") {
        await runSequentialProgram(pinned, command, run);
      } else {
        await run(pinned);
      }
      committed.result = { outcome: "applied", path, statements };
      return committed.result;
    }
  );
  return keepCommittedOutcome(committed, locked);
}

/**
 * The outcome of a command whose work committed, even when ending its session
 * afterwards failed (releasing a session lock, or closing a locked read): the
 * marker already proves the commit (plan S3).
 */
async function keepCommittedOutcome(
  committed: { readonly result?: ApplyV1Result },
  command: Promise<ApplyV1Result>
): Promise<ApplyV1Result> {
  try {
    return await command;
  } catch (failure) {
    if (committed.result === undefined) throw failure;
    return {
      ...committed.result,
      warnings: [
        `The migration committed, but ending its session failed (${describeFailure(failure)}).`,
      ],
    };
  }
}

/**
 * Where the live marker stands relative to this history. A marker naming a
 * state the graph holds — or no state — is `known`, and `assertNoDrift` proves
 * the rest. Otherwise its arrival path tells version skew from a stranger: the
 * marker is `ahead` when that path passes through a state of this estate
 * before leaving it (newer code applied the rest), and `unknown` when nothing
 * on it belongs here.
 */
export function markerStanding(
  graph: MigrationGraph,
  marker: MigrationMarkerV1 | null
): "known" | "ahead" | "unknown" {
  if (!marker?.stateId || graph.states.has(marker.stateId)) return "known";
  return marker.estateHash === graph.estateHash &&
    marker.path.some((edge) => graph.states.has(edge.stateId))
    ? "ahead"
    : "unknown";
}

/** True when `ifAhead: "noop"` applies; refuses every other marker this history does not hold. */
function followsAheadPolicy(
  graph: MigrationGraph,
  marker: MigrationMarkerV1 | null,
  options: ApplyV1Options
): boolean {
  const standing = markerStanding(graph, marker);
  if (standing === "known") return false;
  if (standing === "ahead" && options.ifAhead === "noop") return true;
  throw new MigrationError(
    standing === "ahead"
      ? `The database marker is ahead of this migration history: it names state ${marker?.stateId}, which newer code applied after a state this estate holds. Deploy that code, or pass apply({ ifAhead: "noop" }) to run against the newer schema without migrating.`
      : `The database marker names state ${marker?.stateId}, which is unknown to this migration estate: no state on its arrival path belongs to this history.`,
    VibORMErrorCode.MIGRATION_NOT_FOUND
  );
}

export async function applyPathUnderLock(
  pinned: import("../drivers/driver").AnyDriver,
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  marker: MigrationMarkerV1 | null,
  origin: Sha256 | null,
  path: readonly Sha256[],
  models: MigrationClient["$schema"],
  needsBootstrap = false
): Promise<void> {
  const prepared = path.map((to, index) => {
    const from = index === 0 ? origin : path[index - 1]!;
    const transition = parentTransition(graph, from, to);
    const state = graph.states.get(to)!;
    const blob = graph.sql.get(state.sqlHash);
    if (!blob) {
      throw new MigrationError(
        "Selected transition is missing its SQL blob",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    assertTransactionalBoundaryHonored(
      pinned.supportsTransactions,
      transition.requestedForwardBoundary
    );
    // Plan S5: only a transaction holds SQLite's write lock, under which a
    // transition applies exactly once, and every SQLite statement can run in
    // one. Refused while the path is prepared, before any of it runs.
    if (
      command.target.dialect === "sqlite" &&
      transition.requestedForwardBoundary === "stepwise"
    ) {
      throw new MigrationError(
        'SQLite applies no stepwise transition: only a transaction holds the write lock under which a migration applies exactly once, and every SQLite statement can run in one. Nothing ran. Apply it with VibORM 1.1.0, or, if no database applied it, remove its state from migration storage and generate it again with `execution: "transactional"`.',
        VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
        {
          meta: {
            dialect: "sqlite",
            toState: to,
            feature: "stepwise execution",
          },
        }
      );
    }
    return {
      from,
      to,
      transition,
      state,
      blob,
      boundary: classifyStoredAtomicity(
        command,
        transition.requestedForwardBoundary,
        transition.operations,
        blob
      ),
    };
  });

  let current = marker;
  const nextPath = marker ? [...marker.path] : [];
  let bootstrapPending = needsBootstrap;
  const statementsOf = ({ transition, blob }: PreparedForwardEdge) =>
    stepStatements(blob, transition.operations);
  for (const group of groupContiguousAtomicity(prepared, statementsOf)) {
    const statements = group.items.flatMap(statementsOf);
    const lifted = liftForeignKeyPragmas(pinned, statements);
    const running: { attempt?: ForwardAttempt } = {};
    const run = async (producer: Parameters<typeof appendLedger>[0]) => {
      await assertLockedSinceDecision(pinned, producer, command, current);
      if (bootstrapPending) {
        await ensureControlTables(producer, command, DEFAULT_CONTROL_BASE);
        bootstrapPending = false;
      }
      for (const item of group.items) {
        running.attempt = { item, attemptId: forwardAttemptId(graph, item) };
        current = await executeForwardEdge(
          producer,
          command,
          graph,
          running.attempt,
          current,
          nextPath,
          models
        );
      }
    };
    if (
      mayWrapTransaction(
        pinned,
        command.target.dialect,
        group.boundary === "transactional"
      )
    ) {
      let committing = false;
      let committed = false;
      try {
        await withForeignKeysLifted(pinned, lifted.bracket, async (inside) => {
          await pinned.withTransaction(async (transaction) => {
            await inside(transaction, run);
            committing = true;
          });
          committed = true;
        });
      } catch (failure) {
        // Past the commit only the foreign-key restore can fail: it is reported.
        if (committed) throw failure;
        if (
          committing &&
          (await commitLanded(pinned, command, group.items, current, failure))
        ) {
          continue;
        }
        await recordFailedAttempt(pinned, command, graph, running, failure);
        throw failure;
      }
    } else {
      await run(pinned);
    }
  }
}

/**
 * Refuses a group whose decision was taken under a lock the command has since
 * let go (plans D1, S5): an earlier group committed, or SQLite committed the
 * decision's transaction to switch foreign keys. Read as the group's first
 * statements, under its own lock: if another command moved the marker in
 * between, nothing of this group runs. Apply never leaves an attempt of its own
 * open between two groups, so an unfinished one is another command's; `down`
 * and `reset` carry theirs across groups and pass `ownAttempt`.
 */
export async function assertLockedSinceDecision(
  pinned: Parameters<typeof appendLedger>[0],
  producer: Parameters<typeof appendLedger>[0],
  command: BoundMigrationDriver,
  expected: MigrationMarkerV1 | null,
  ownAttempt = false
): Promise<void> {
  if (lockedSinceDecision(pinned)) return;
  const { marker, ledger } = await readControlState(
    producer,
    command,
    DEFAULT_CONTROL_BASE
  );
  if (
    marker?.revision === expected?.revision &&
    marker?.pathHash === expected?.pathHash &&
    (ownAttempt || unfinishedAttempts(ledger).length === 0)
  ) {
    return;
  }
  throw new MigrationError(
    "Another migration command moved the marker between two of this command's transactions. Nothing of the remaining path ran; running the command again re-reads the marker.",
    VibORMErrorCode.MIGRATION_MARKER_CONFLICT
  );
}

interface ForwardAttempt {
  readonly item: PreparedForwardEdge;
  readonly attemptId: Sha256;
}

/**
 * Whether a transaction whose COMMIT was sent, and then failed, committed.
 * The marker it compare-and-swapped answers: it commits with the transition
 * or not at all. When even the marker cannot be read, the outcome is the
 * ambiguous commit V11020 it is (plan S3).
 */
async function commitLanded(
  pinned: Parameters<typeof appendLedger>[0],
  command: BoundMigrationDriver,
  items: readonly PreparedForwardEdge[],
  expected: MigrationMarkerV1 | null,
  failure: unknown
): Promise<boolean> {
  let marker: MigrationMarkerV1 | null;
  try {
    // On a lost connection the pinned view refuses this read (plan S2).
    ({ marker } = await readControlState(
      pinned,
      command,
      DEFAULT_CONTROL_BASE
    ));
  } catch {
    const fromState = items[0]?.from ?? null;
    throw new MigrationError(
      "The migration's COMMIT was sent but its reply was lost, and the marker cannot be re-read: the transition may have committed. status() and apply() re-read the marker.",
      VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
      {
        cause: failure instanceof Error ? failure : undefined,
        meta: {
          ...(fromState === null ? {} : { fromState }),
          toState: items.at(-1)?.to,
          effectState: "may-have-committed",
          commitCertainty: "may-have-committed",
        },
      }
    );
  }
  return (
    marker !== null &&
    marker.revision === expected?.revision &&
    marker.pathHash === expected.pathHash
  );
}

/**
 * Leaves the durable record of a rolled-back attempt, whose own events the
 * rollback took with it: a `failed` event, in a transaction of its own, after
 * bootstrapping the control tables a failed first apply rolled back. The pinned
 * view sends nothing on a lost connection (plan S2), and a record that cannot be written
 * never replaces the failure it records.
 */
async function recordFailedAttempt(
  pinned: Parameters<typeof appendLedger>[0],
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  running: { readonly attempt?: ForwardAttempt },
  failure: unknown
): Promise<void> {
  const { attempt } = running;
  if (attempt === undefined) return;
  const { item, attemptId } = attempt;
  const meta = isVibORMError(failure) ? failure.meta : {};
  const event = ledgerEvent(
    graph,
    attemptId,
    "failed",
    item.from,
    item.to,
    "none",
    typeof meta.operationId === "string" ? meta.operationId : null,
    typeof meta.dispatchId === "string" ? meta.dispatchId : null,
    item.transition.transitionHash,
    describeFailure(failure)
  );
  try {
    await pinned.withTransaction(async (transaction) => {
      await ensureControlTables(transaction, command, DEFAULT_CONTROL_BASE);
      await appendLedger(transaction, command, DEFAULT_CONTROL_BASE, event);
    });
  } catch {
    // Best effort: the caller is owed the failure itself, not this one.
  }
}

function describeFailure(failure: unknown): string {
  if (isVibORMError(failure)) return `${failure.code}: ${failure.message}`;
  return failure instanceof Error ? failure.name : "a non-error value";
}

interface PreparedForwardEdge {
  readonly from: Sha256 | null;
  readonly to: Sha256;
  readonly transition: ReturnType<typeof parentTransition>;
  readonly state: MigrationStateManifestV1;
  readonly blob: Uint8Array;
  readonly boundary: "transactional" | "stepwise";
}

function forwardAttemptId(
  graph: MigrationGraph,
  { from, to, transition, state }: PreparedForwardEdge
): Sha256 {
  return eventIdFor({
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
}

async function executeForwardEdge(
  producer: Parameters<typeof appendLedger>[0],
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  { item, attemptId }: ForwardAttempt,
  current: MigrationMarkerV1 | null,
  nextPath: MarkerPathEdgeV1[],
  models: MigrationClient["$schema"]
): Promise<MigrationMarkerV1> {
  const { from, to, transition, state, blob, boundary } = item;
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
  if (
    !(await evaluateAllChecks(
      producer,
      blob,
      transition.originChecks,
      command.namespace
    ))
  ) {
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
    },
    command.namespace,
    { fromState: from, toState: to }
  );
  // Manual SQL may store text typed queries cannot compare (`datetime('now')`).
  await canonicalizeSqliteStorage(
    producer,
    transition.operations,
    models,
    requireStateSnapshot(graph, to)
  );
  if (
    !(await evaluateAllChecks(
      producer,
      blob,
      state.destinationChecks,
      command.namespace
    ))
  ) {
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
    current ? { revision: current.revision, pathHash: current.pathHash } : null,
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
  return next;
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
    if (blob) statements.push(...stepStatements(blob, transition.operations));
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
      `Live managed schema drifted from the authenticated snapshot. Differences: ${expected ? JSON.stringify(await diff(live, expected)) : "authenticated snapshot is missing"}`,
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
  transitionHash: Sha256 | null = null,
  failure: string | null = null
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
    failure,
  };
  return { ...event, eventId: eventIdFor(event) };
}
