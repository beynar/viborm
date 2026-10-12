/**
 * V1 operator commands: status, verify, log, baseline, reanchor, prune,
 * down, resolve, reset.
 * Status/verify/log are read-only and never bootstrap missing control tables.
 */

import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import { renderQualifiedIdentifier } from "../sql/identifiers";
import { admitLiveMigrationCapability } from "./admission";
import {
  boundNamespace,
  type InvalidIndex,
  readInvalidIndexes,
} from "./catalog-probes";
import {
  assertTransactionalBoundaryHonored,
  classifyStoredAtomicity,
  groupContiguousAtomicity,
  stepStatements,
} from "./compile";
import {
  advanceMarker,
  appendLedger,
  attemptIdFor,
  DEFAULT_CONTROL_BASE,
  ensureControlTables,
  isTableMissing,
  ledgerEvent,
  type MigrationControlRead,
  readControlState,
  refuseIncompatibleHistory,
  refusePartialControl,
  unfinishedAttempts,
} from "./control";
import { diff, isDestructiveOperation } from "./differ";
import { type NormalizedDownOptions, normalizeDownOptions } from "./down-input";
import {
  assertAllChecks,
  evaluateAllChecks,
  executeOperations,
} from "./execute-dispatch";
import {
  loadMigrationGraph,
  type MigrationGraph,
  parentTransition,
  requireStateSnapshot,
  resolveStateSelector,
  selectRoute,
  statesFrom,
} from "./graph";
import type { Sha256 } from "./identity";
import {
  commitControlBootstrap,
  resolveCommandDriver,
  runProgram,
  withLockedMigrationProducer,
} from "./pinned-session";
import {
  assertLockedSinceDecision,
  assertNoDrift,
  markerStanding,
  proveLive,
} from "./proof";
import { renderMigrationReview } from "./public-view";
import { getPushMigrationDriver, type MigrationClient } from "./push/planner";
import { fingerprintLive } from "./push-fingerprint";
import { introspectManaged } from "./push-plan";
import { approveDestructiveOperations } from "./resolver";
import {
  confirmedPrefix,
  openCommand,
  readCommandControl,
  refuseAmbiguousNext,
  sliceOperations,
} from "./resume";
import { sliceDispatch } from "./sql-blob";
import { canonicalizeSqliteStorage } from "./sqlite-storage-audit";
import type {
  MigrationStorageReader,
  MigrationStorageWriter,
} from "./storage/contract";
import type {
  AmbiguousChange,
  DiffOperation,
  ResolveCallback,
  SchemaSnapshot,
} from "./types";
import type {
  BaselineOptions,
  DownPreviewEdgeV1,
  DownV1Options,
  DownV1Result,
  LedgerEventV1,
  MarkerPathEdgeV1,
  MigrationMarkerV1,
  ReanchorOptions,
  ResolveV1Options,
  StateSelector,
} from "./v1-types";

export { resetV1 } from "./reset-v1";

export interface StatusV1Result {
  readonly control: "absent" | "present";
  readonly marker: MigrationMarkerV1 | null;
  readonly pending: readonly Sha256[];
  readonly unfinished: boolean;
  /**
   * Present only when the marker names a state this estate does not hold:
   * `"ahead"` when its arrival path leaves this history after a state it holds
   * (newer code migrated the database), `"unknown"` when nothing on that path
   * belongs here. `pending` is then empty.
   */
  readonly markerState?: "ahead" | "unknown";
  /** Present only when a managed table carries an INVALID index (PostgreSQL). */
  readonly invalidIndexes?: readonly InvalidIndex[];
  /**
   * The latest `failed` ledger event, present once a rolled-back attempt left
   * one: its `toState`, `dispatchId` and `failure` say what failed and why.
   */
  readonly lastFailure?: LedgerEventV1;
}

export async function statusV1(
  client: MigrationClient,
  storage: MigrationStorageReader
): Promise<StatusV1Result> {
  const graph = await loadMigrationGraph(storage);
  const driver = openCommand(client, graph, "read-only", "status()");
  const command = await resolveCommandDriver(client.$driver, driver);
  const control = await readControlState(
    client.$driver,
    command,
    DEFAULT_CONTROL_BASE,
    { ledger: "open" }
  );
  const invalidIndexes = await readInvalidIndexes(client.$driver, command);
  const listed = invalidIndexes.length === 0 ? {} : { invalidIndexes };
  if (control.presence.kind !== "present") {
    refusePartialControl(control.presence);
    return {
      control: "absent",
      marker: null,
      pending: [...graph.roots],
      unfinished: false,
      ...listed,
    };
  }
  const { marker, ledger } = control;
  const unfinished = unfinishedAttempts(ledger).length > 0;
  let lastFailure: LedgerEventV1 | undefined;
  for (const event of ledger) {
    if (event.kind === "failed") lastFailure = event;
  }
  const standing = markerStanding(graph, marker);
  let pending: Sha256[] = [];
  if (standing === "known" && graph.leaves.length === 1) {
    const leaf = graph.leaves[0]!;
    if ((marker?.stateId ?? null) !== leaf) {
      pending = [...selectRoute(graph, marker?.stateId ?? null, leaf)];
    }
  }
  return {
    control: "present",
    marker,
    pending,
    unfinished,
    ...(standing === "known" ? {} : { markerState: standing }),
    ...listed,
    ...(lastFailure ? { lastFailure } : {}),
  };
}

export interface VerifyV1Result {
  readonly ok: boolean;
  /** Present, with `ok: false`, when the marker names a state this estate does not hold. */
  readonly markerState?: "ahead" | "unknown";
}

export async function verifyV1(
  client: MigrationClient,
  storage: MigrationStorageReader
): Promise<VerifyV1Result> {
  const graph = await loadMigrationGraph(storage);
  const driver = openCommand(client, graph, "effectful", "verify()");
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const control = await readCommandControl(pinned, command);
      if (control.presence.kind !== "present") {
        throw new MigrationError(
          "verify requires present control tables",
          VibORMErrorCode.MIGRATION_NOT_FOUND
        );
      }
      const { marker } = control;
      if (!marker) {
        throw new MigrationError(
          "verify requires a migration marker",
          VibORMErrorCode.MIGRATION_NOT_FOUND
        );
      }
      const standing = markerStanding(graph, marker);
      if (standing !== "known") return { ok: false, markerState: standing };
      const markedSnapshot = requireStateSnapshot(graph, marker.stateId);
      await command.preflightSchemaRequirements(
        [markedSnapshot],
        (sql, params) => pinned._executeRaw(sql, params)
      );
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
  const command = await resolveCommandDriver(client.$driver, driver);
  const control = await readControlState(
    client.$driver,
    command,
    DEFAULT_CONTROL_BASE
  );
  if (control.presence.kind !== "present") {
    refusePartialControl(control.presence);
    throw new MigrationError(
      "log requires present control tables",
      VibORMErrorCode.MIGRATION_NOT_FOUND
    );
  }
  return control.ledger;
}

export async function baselineV1(
  client: MigrationClient,
  storage: MigrationStorageReader,
  options: BaselineOptions
): Promise<{ readonly stateId: Sha256 }> {
  const graph = await loadMigrationGraph(storage);
  const driver = openCommand(client, graph, "effectful", "baseline()");
  const target = resolveStateSelector(graph, options.to);
  const path = selectRoute(graph, null, target, options.via);
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const control = await readCommandControl(pinned, command, true);
      const { marker, ledger } = control;
      if (marker || unfinishedAttempts(ledger).length > 0) {
        throw new MigrationError(
          "baseline requires an unmarked database without an unfinished attempt",
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }
      refuseIncompatibleHistory(marker, ledger);
      assertStructuralRoute(graph, path, "baseline");
      await command.preflightSchemaRequirements(
        [requireStateSnapshot(graph, target)],
        (sql, params) => pinned._executeRaw(sql, params)
      );
      // Committed before the proof, which then runs under the lock taken
      // again, as does the marker it publishes.
      if (control.presence.kind !== "present") {
        await ensureControlTables(pinned, command, DEFAULT_CONTROL_BASE);
        await commitControlBootstrap(pinned, command);
        await assertLockedSinceDecision(pinned, pinned, command, null);
      }
      await proveLive(
        pinned,
        command,
        graph,
        graph.states.get(target)!.snapshotHash,
        async (differences) =>
          `baseline requires exact live equality with the target snapshot. Differences: ${await differences()}`
      );
      await adoptRoute(pinned, command, graph, path, null);
      return { stateId: target };
    }
  );
}

/**
 * Plan T3: after a restore left this history older than the database, moves
 * a marker naming a state the history lacks onto the one known state the live
 * schema matches, with baseline's proof and a baseline boundary. `to` adopts
 * the state it names instead: the consent several matching states need.
 */
export async function reanchorV1(
  client: MigrationClient,
  storage: MigrationStorageReader,
  options: ReanchorOptions = {}
): Promise<{ readonly stateId: Sha256 }> {
  const graph = await loadMigrationGraph(storage);
  const driver = openCommand(client, graph, "effectful", "reanchor()");
  const named = options.to && resolveStateSelector(graph, options.to);
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const { marker, ledger } = await readCommandControl(pinned, command);
      if (!marker || markerStanding(graph, marker) === "known") {
        throw new MigrationError(
          "reanchor moves only a marker naming a state this history does not hold; apply, verify and baseline handle the others",
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }
      if (unfinishedAttempts(ledger).length > 0) {
        throw new MigrationError(
          "reanchor refuses while an attempt is unfinished: resolve it first",
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }
      const live = await introspectManaged(pinned, command);
      const liveHash = await fingerprintLive(live, command, pinned);
      const matches: Sha256[] = [];
      for (const stateId of named ? [named] : graph.states.keys()) {
        const snapshot = requireStateSnapshot(graph, stateId);
        if ((await fingerprintLive(snapshot, command, pinned)) === liveHash) {
          matches.push(stateId);
        }
      }
      const reference =
        named ?? (graph.leaves.length === 1 ? graph.leaves[0] : undefined);
      if (matches.length === 0) {
        const differences = reference
          ? ` Differences from ${reference}: ${JSON.stringify(await diff(live, requireStateSnapshot(graph, reference)))}`
          : "";
        throw new MigrationError(
          `reanchor found no state of this history that the live schema matches.${differences}`,
          VibORMErrorCode.MIGRATION_DRIFT
        );
      }
      if (matches.length > 1) {
        throw new MigrationError(
          `Several states of this history match the live schema (${matches.join(", ")}), and equal schemas never say which data the database holds: name one with reanchor({ to }).`,
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }
      const target = matches[0]!;
      if (marker.path.some((edge) => edge.stateId === target)) {
        throw new MigrationError(
          `reanchor refuses ${target}: the marker passed through it, so the transitions lost after it changed no schema and may have moved data. Regenerate the lost states from the same documents instead: their ids come back identical.`,
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }
      const path = selectRoute(graph, null, target, options.via);
      assertStructuralRoute(graph, path, "reanchor");
      await command.preflightSchemaRequirements(
        [requireStateSnapshot(graph, target)],
        (sql, params) => pinned._executeRaw(sql, params)
      );
      await adoptRoute(pinned, command, graph, path, marker);
      return { stateId: target };
    }
  );
}

/** Baseline's proof of a root route: no manual, opaque or data-only edge. */
function assertStructuralRoute(
  graph: MigrationGraph,
  path: readonly Sha256[],
  command: "baseline" | "reanchor"
): void {
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
        `${command} refuses a path containing manual, opaque, or data-only transitions`,
        VibORMErrorCode.MIGRATION_INVALID_STATE
      );
    }
  }
}

/**
 * Publishes the marker re-rooted on `path`, its first edge a baseline
 * boundary, in place of `current` (compare-and-swap), with the event that
 * says so: `baselined` without a marker before, `reanchored` with one. In one
 * transaction when the producer can.
 */
async function adoptRoute(
  pinned: AnyDriver,
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  path: readonly Sha256[],
  current: MigrationMarkerV1 | null
): Promise<void> {
  const edges = path.map((stateId, index) => ({
    stateId,
    transitionHash: parentTransition(
      graph,
      index === 0 ? null : path[index - 1]!,
      stateId
    ).transitionHash,
    baselineBoundary: index === 0,
  }));
  const target = path.at(-1)!;
  const publish = async (producer: AnyDriver) => {
    const next = await advanceMarker(
      producer,
      command,
      graph.estateHash,
      current,
      edges,
      graph.states.get(target)!.snapshotHash
    );
    await appendLedger(
      producer,
      command,
      DEFAULT_CONTROL_BASE,
      ledgerEvent({
        attemptId: next.pathHash,
        kind: current ? "reanchored" : "baselined",
        estateHash: graph.estateHash,
        snapshotHash: next.snapshotHash,
        sqlHash: null,
        fromState: current?.stateId ?? null,
        toState: target,
        transitionHash: null,
        direction: "baseline",
        operationId: null,
        dispatchId: null,
        effectState: "none",
      })
    );
  };
  if (pinned.supportsTransactions) {
    await pinned.withTransaction((transaction) => publish(transaction));
  } else {
    await publish(pinned);
  }
}

export interface PruneOptions {
  /** The authored checkpoint (`generate({ from: null })`) to keep history from. */
  readonly checkpoint: StateSelector;
  /** A fresh history: the source is never changed. */
  readonly into: MigrationStorageWriter;
}

export interface PruneResult {
  /** The states `into` now holds from this history. */
  readonly states: readonly Sha256[];
}

/**
 * Plan T4: copies the checkpoint and the states `statesFrom` keeps after it
 * into a fresh history. Storage stays append-only, so pruning is a copy: what
 * it leaves out is what `check()` would report as orphaned, once the earlier
 * manifests were gone. A marker on a dropped state is moved by `reanchor()`.
 */
export async function pruneV1(
  storage: MigrationStorageReader,
  options: PruneOptions
): Promise<PruneResult> {
  const graph = await loadMigrationGraph(storage);
  const kept = statesFrom(
    graph,
    resolveStateSelector(graph, options.checkpoint)
  );
  const { into } = options;
  await into.publishEstate(await present(storage.readEstate(), "estate.json"));
  for (const id of kept) {
    const { snapshotHash, sqlHash } = graph.states.get(id)!;
    const snapshot = storage.readSnapshot(snapshotHash);
    await into.publishSnapshot(snapshotHash, await present(snapshot, id));
    await into.publishSql(sqlHash, graph.sql.get(sqlHash)!);
    await into.publishState(id, await present(storage.readState(id), id));
  }
  return { states: [...kept] };
}

/** Bytes the loaded graph authenticated, gone by the time prune copies them. */
async function present(
  read: Promise<Uint8Array | null>,
  artifact: string
): Promise<Uint8Array> {
  const bytes = await read;
  if (!bytes) {
    throw new MigrationError(
      `${artifact} vanished from the history while prune copied it`,
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  return bytes;
}

export async function downV1(
  client: MigrationClient,
  storage: MigrationStorageReader,
  options: DownV1Options = {}
): Promise<DownV1Result> {
  const request = normalizeDownOptions(options);
  const graph = await loadMigrationGraph(storage);
  const driver = openCommand(
    client,
    graph,
    request.dryRun ? "read-only" : "effectful",
    "down()"
  );
  if (request.dryRun) {
    const producer = client.$driver;
    const command = await resolveCommandDriver(producer, driver);
    const { close, removed, refusal } = await planRollback(
      producer,
      command,
      graph,
      await readCommandControl(producer, command),
      request,
      true
    );
    return {
      path: close
        ? [close.item.edge.stateId]
        : removed.map((edge) => edge.stateId),
      preview: true,
      edges: [...removed]
        .reverse()
        .map((edge) => previewRollbackEdge(graph, edge)),
      refusal,
    };
  }
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const control = await readCommandControl(pinned, command);
      const { close, removed, run } = await planRollback(
        pinned,
        command,
        graph,
        control,
        request,
        false
      );
      if (close) {
        await command.preflightSchemaRequirements(
          [requireStateSnapshot(graph, close.item.nextState)],
          (sql, params) => pinned._executeRaw(sql, params)
        );
        await runProgram(pinned, command, undefined, (producer) =>
          closeCompletedRollback(
            producer,
            command,
            graph,
            close.item,
            close.attempt,
            control.ledger,
            control.marker
          )
        );
        return { path: [close.item.edge.stateId], preview: false };
      }
      if (!run) return { path: [], preview: false };
      const { prepared, attempt } = run;
      const statementsOf = (item: PreparedRollback) =>
        stepStatements(item.blob, item.rollback.operations);
      await runProgram(pinned, command, undefined, async (producer) => {
        let current = run.marker;
        for (const group of groupContiguousAtomicity(prepared, statementsOf)) {
          const executeGroup = async (groupProducer: AnyDriver) => {
            await assertLockedSinceDecision(
              pinned,
              groupProducer,
              command,
              current,
              true
            );
            for (const item of group.items) {
              current = await executeRollbackEdge(
                groupProducer,
                command,
                graph,
                item,
                current,
                item === prepared[0] ? attempt : undefined,
                control.ledger,
                client.$schema
              );
            }
          };
          // MySQL runs the whole rollback as one sequential program.
          await (command.target.dialect === "mysql"
            ? executeGroup(producer)
            : runProgram(
                pinned,
                command,
                {
                  transactional: group.boundary === "transactional",
                  statements: group.items.flatMap(statementsOf),
                },
                executeGroup
              ));
        }
      });
      return { path: removed.map((edge) => edge.stateId), preview: false };
    }
  );
}

type PreparedRollback = ReturnType<typeof prepareRollbackEdge>;

interface RollbackPlan {
  /** The first refusal of a preview; `down` throws it instead. */
  readonly refusal: { code: string; message: string } | null;
  /** A rollback that finished before it was recorded: `down` closes it. */
  readonly close?: {
    readonly item: PreparedRollback;
    readonly attempt: LedgerEventV1;
  };
  /** The marker edges `down` removes. */
  readonly removed: MigrationMarkerV1["path"];
  /** Present when `down` reverses `removed`, newest edge first. */
  readonly run?: {
    readonly marker: MigrationMarkerV1;
    readonly prepared: readonly PreparedRollback[];
    readonly attempt: LedgerEventV1 | undefined;
  };
}

/**
 * What `down` decides before its first effect, read-only and in its order, so
 * the preview refuses where `down` refuses. `previewing` returns a refusal of
 * the attempt or of the checks as data (`down` throws it); without one, a
 * preview still names the edges.
 */
async function planRollback(
  producer: AnyDriver,
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  { marker, ledger }: MigrationControlRead,
  request: NormalizedDownOptions,
  previewing: boolean
): Promise<RollbackPlan> {
  assertExpectedRevision(marker, request);
  let refusal: RollbackPlan["refusal"] = null;
  let attempt: LedgerEventV1 | undefined;
  try {
    attempt = admitRollbackAttempt(ledger);
  } catch (error) {
    if (!previewing) throw error;
    refusal = refusalOf(error);
  }
  const { supportsTransactions } = producer;
  if (attempt && attempt.toState === (marker?.stateId ?? null)) {
    const item = prepareRollbackAttempt(
      graph,
      command,
      supportsTransactions,
      attempt
    );
    return { refusal, close: { item, attempt }, removed: [] };
  }
  if (!marker) {
    // `down` refuses the attempt before it finds nothing to roll back.
    if (refusal) return { refusal, removed: [] };
    throw new MigrationError(
      "Nothing to roll back",
      VibORMErrorCode.MIGRATION_NOT_FOUND
    );
  }
  const removed = rollbackSlice(graph, marker, request);
  // `down` checks nothing more when it has nothing to roll back.
  if (refusal || removed.length === 0) return { refusal, removed };
  try {
    const reverse = [...removed].reverse();
    for (const edge of reverse) assertReversibleEdge(graph, edge);
    const prepared = reverse.map((edge) =>
      prepareRollbackEdge(graph, command, supportsTransactions, edge)
    );
    await command.preflightSchemaRequirements(
      [
        requireStateSnapshot(graph, marker.stateId),
        ...prepared.map((item) => requireStateSnapshot(graph, item.nextState)),
      ],
      (sql, params) => producer._executeRaw(sql, params),
      prepared.flatMap((item) =>
        stepStatements(item.blob, item.rollback.operations)
      )
    );
    if (attempt) {
      assertResumesSelectedPath(
        graph,
        command,
        supportsTransactions,
        attempt,
        prepared[0]!
      );
    } else {
      await assertNoDrift(producer, command, graph, marker);
    }
    await approveRollbackLosses(
      producer,
      command,
      graph,
      prepared,
      request.resolve
    );
    return { refusal, removed, run: { marker, prepared, attempt } };
  } catch (error) {
    if (!previewing) throw error;
    return { refusal: refusalOf(error), removed };
  }
}

export async function resolveV1(
  client: MigrationClient,
  storage: MigrationStorageReader,
  options: ResolveV1Options
): Promise<{ readonly outcome: ResolveV1Options["outcome"] }> {
  const graph = await loadMigrationGraph(storage);
  const driver = openCommand(client, graph, "effectful", "resolve()");
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const { ledger } = await readCommandControl(pinned, command);
      const open = unfinishedAttempts(ledger);
      if (open.length !== 1) {
        throw new MigrationError(
          open.length === 0
            ? "resolve requires an unfinished attempt"
            : "resolve requires exactly one unfinished attempt",
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
      if (attempt.direction === "rollback") {
        throw new MigrationError(
          "An unfinished rollback can only be resumed by down()",
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
      const destSnapshot = requireStateSnapshot(graph, to);
      const originSnapshot = requireStateSnapshot(graph, from);
      await command.preflightSchemaRequirements(
        [originSnapshot, destSnapshot],
        (sql, params) => pinned._executeRaw(sql, params)
      );
      if (options.outcome !== "retry") {
        await repairInvalidIndexes(
          pinned,
          command,
          stepStatements(blob, transition.operations),
          options.outcome === "complete" ? destSnapshot : originSnapshot
        );
      }
      const liveHash = await fingerprintLive(
        await introspectManaged(pinned, command),
        command,
        pinned
      );
      const destHolds =
        liveHash === (await fingerprintLive(destSnapshot, command, pinned)) &&
        (await evaluateAllChecks(
          pinned,
          blob,
          state.destinationChecks,
          command.namespace
        ));
      const originHolds =
        liveHash === (await fingerprintLive(originSnapshot, command, pinned)) &&
        (await evaluateAllChecks(
          pinned,
          blob,
          transition.originChecks,
          command.namespace
        ));
      const manualOpaque = transition.operations.some(
        (operation) =>
          operation.origin === "manual" &&
          operation.steps.some((step) => step.retry === "opaque")
      );
      // Marking an outcome is one transaction where the producer has one.
      const record = { transactional: true, statements: [] };
      if (options.outcome === "complete") {
        if (
          !destHolds ||
          (manualOpaque && state.destinationChecks.length === 0)
        ) {
          throw new MigrationError(
            "resolve cannot mark complete without destination proof",
            VibORMErrorCode.MIGRATION_INVALID_STATE
          );
        }
        await runProgram(pinned, command, record, async (producer) => {
          // Completing manual SQL canonicalizes what it stored, as apply does.
          await canonicalizeSqliteStorage(
            producer,
            transition.operations,
            client.$schema,
            destSnapshot
          );
          await finishResolve(producer, command, graph, attempt, "applied", to);
        });
        return { outcome: "complete" };
      }
      if (options.outcome === "rolled-back") {
        refuseOpaqueEffect(transition, blob, attempt, ledger);
        if (
          !originHolds ||
          (manualOpaque && transition.originChecks.length === 0)
        ) {
          throw new MigrationError(
            "resolve cannot mark rolled back without origin proof",
            VibORMErrorCode.MIGRATION_INVALID_STATE
          );
        }
        await runProgram(pinned, command, record, (producer) =>
          finishResolve(producer, command, graph, attempt, "rolled-back", from)
        );
        return { outcome: "rolled-back" };
      }
      if (manualOpaque) {
        throw new MigrationError(
          "resolve cannot retry an opaque dispatch without origin or destination proof",
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }
      if (
        transition.operations.some((operation) =>
          operation.steps.some((step) => step.retry === "opaque")
        ) &&
        !originHolds
      ) {
        throw new MigrationError(
          "resolve cannot retry a generated structural transition except from the origin",
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }
      assertTransactionalBoundaryHonored(
        pinned.supportsTransactions,
        transition.requestedForwardBoundary
      );
      const boundary = classifyStoredAtomicity(
        command,
        transition.requestedForwardBoundary,
        transition.operations,
        blob
      );
      // A recreation is refused without a transaction: its lift is unproven.
      await runProgram(
        pinned,
        command,
        {
          transactional: boundary === "transactional",
          statements: stepStatements(blob, transition.operations),
        },
        async (producer) => {
          await executeOperations(
            producer,
            blob,
            transition.operations,
            boundary,
            undefined,
            command.namespace,
            { fromState: from, toState: to }
          );
          await assertAllChecks(
            producer,
            blob,
            state.destinationChecks,
            command.namespace,
            "Retry did not reach the destination"
          );
          await proveLive(
            producer,
            command,
            graph,
            state.snapshotHash,
            () => "Retry did not reach the destination"
          );
          await finishResolve(producer, command, graph, attempt, "applied", to);
        }
      );
      return { outcome: "retry" };
    }
  );
}

/**
 * The index a `CREATE`/`DROP`/`REINDEX INDEX CONCURRENTLY` statement names,
 * schema prefix dropped. An unnamed `CREATE INDEX CONCURRENTLY ON t` is never
 * matched; its PG-chosen name is left to the V11023 refusal. (DROP INDEX
 * CONCURRENTLY takes one name only.)
 */
const CONCURRENT_INDEX_NAME =
  /\bINDEX\s+CONCURRENTLY\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?!ON\b)(?:(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)\s*\.\s*)?("(?:[^"]|"")+"|[A-Za-z_][\w$]*)/gi;
/** The suffix of the `_ccnew`/`_ccold` copy an interrupted `REINDEX CONCURRENTLY` leaves INVALID. */
const REINDEX_REMNANT = /^_cc(?:new|old)\d*$/;

/**
 * Repairs the INVALID indexes the unfinished attempt's own CONCURRENTLY
 * statements left behind — the index each names, and the `<name>_ccnew` /
 * `<name>_ccold` remnant of an interrupted `REINDEX CONCURRENTLY` — towards the snapshot the
 * requested outcome asserts: an index that snapshot declares is rebuilt, any
 * other is dropped, both CONCURRENTLY so writes keep flowing. An invalid index
 * the attempt never named (another session's build, still running perhaps) is
 * left alone, and the proof that follows refuses on it with V11023. An invalid
 * index belongs to neither state, so the repair cannot turn a false proof true.
 */
async function repairInvalidIndexes(
  pinned: Parameters<typeof appendLedger>[0],
  command: Parameters<typeof appendLedger>[1],
  statements: readonly string[],
  expected: SchemaSnapshot
): Promise<void> {
  const named = statements.flatMap(concurrentIndexNames);
  if (named.length === 0) return;
  for (const { table, index } of await readInvalidIndexes(pinned, command)) {
    if (
      !named.some(
        (name) =>
          index === name ||
          (index.startsWith(name) &&
            REINDEX_REMNANT.test(index.slice(name.length)))
      )
    )
      continue;
    const rebuild = expected.tables.some(
      (declared) =>
        declared.name === table &&
        declared.indexes.some((item) => item.name === index)
    );
    const name = renderQualifiedIdentifier(
      (part) => command.escapeIdentifier(part),
      boundNamespace(command),
      index
    );
    await pinned._executeRaw(
      `${rebuild ? "REINDEX INDEX" : "DROP INDEX"} CONCURRENTLY ${name}`
    );
  }
}

/** The indexes a statement's `INDEX CONCURRENTLY` clauses name. */
function concurrentIndexNames(text: string): string[] {
  return [...text.matchAll(CONCURRENT_INDEX_NAME)].map(([, name = ""]) =>
    name.startsWith('"')
      ? name.slice(1, -1).replaceAll('""', '"')
      : name.toLowerCase()
  );
}

async function finishResolve(
  pinned: AnyDriver,
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  attempt: LedgerEventV1,
  kind: "applied" | "rolled-back",
  to: Sha256 | null
): Promise<void> {
  const { marker } = await readCommandControl(pinned, command);
  if (kind === "applied" && to && marker?.stateId !== to) {
    const transition = parentTransition(graph, attempt.fromState, to);
    await advanceMarker(
      pinned,
      command,
      graph.estateHash,
      marker,
      [
        ...(marker?.path ?? []),
        {
          stateId: to,
          transitionHash: attempt.transitionHash ?? transition.transitionHash,
          baselineBoundary: false,
        },
      ],
      graph.states.get(to)!.snapshotHash
    );
  }
  if (kind === "rolled-back" && marker && marker.stateId === attempt.toState) {
    const nextPath = marker.path.slice(0, -1);
    await advanceMarker(
      pinned,
      command,
      graph.estateHash,
      marker,
      nextPath,
      snapshotHashOf(graph, nextPath.at(-1)?.stateId ?? null)
    );
  }
  await appendLedger(
    pinned,
    command,
    DEFAULT_CONTROL_BASE,
    ledgerEvent({
      attemptId: attempt.attemptId,
      kind: "resolved",
      estateHash: graph.estateHash,
      snapshotHash: snapshotHashOf(graph, to),
      sqlHash: attempt.sqlHash,
      fromState: attempt.fromState,
      toState: to,
      transitionHash: attempt.transitionHash,
      direction: "resolve",
      operationId: null,
      dispatchId: null,
      effectState: "none",
    })
  );
}

/** The snapshot a state, or the empty origin, authenticates. */
function snapshotHashOf(graph: MigrationGraph, stateId: Sha256 | null): Sha256 {
  return stateId
    ? graph.states.get(stateId)!.snapshotHash
    : graph.emptySnapshotHash;
}

function prepareRollbackEdge(
  graph: MigrationGraph,
  command: Parameters<typeof appendLedger>[1],
  supportsTransactions: boolean,
  edge: MarkerPathEdgeV1
) {
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
  const requested =
    rollback.kind === "manual" ? rollback.requestedBoundary : null;
  assertTransactionalBoundaryHonored(supportsTransactions, requested);
  return {
    edge,
    state,
    parent,
    blob,
    rollback,
    boundary: classifyStoredAtomicity(
      command,
      requested,
      rollback.operations,
      blob
    ),
    nextState: parent.fromState,
  };
}

/**
 * One edge of a down preview: its rollback rendered as `show --sql` renders
 * it, without the forward half or its forward approvals.
 */
function previewRollbackEdge(
  graph: MigrationGraph,
  edge: MarkerPathEdgeV1
): DownPreviewEdgeV1 {
  const state = graph.states.get(edge.stateId);
  const parent = state?.parents.find(
    (item) => item.transitionHash === edge.transitionHash
  );
  const blob = state && graph.sql.get(state.sqlHash);
  if (!(parent && blob)) {
    throw new MigrationError(
      "Rollback cannot find the arrival transition or its SQL",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  const { approvals: _forward, ...transition } = parent;
  return {
    stateId: edge.stateId,
    toState: parent.fromState,
    sql: renderMigrationReview(
      [{ ...transition, originChecks: [], operations: [] }],
      [],
      blob
    ),
  };
}

/** A migration refusal as plain data; any other error is rethrown. */
function refusalOf(error: unknown): { code: string; message: string } {
  if (!(error instanceof MigrationError)) throw error;
  return { code: error.code, message: error.message };
}

/**
 * The one unfinished attempt `down` may resume: none, or a started rollback.
 * Anything else needs repair first.
 */
function admitRollbackAttempt(
  ledger: readonly LedgerEventV1[]
): LedgerEventV1 | undefined {
  const open = unfinishedAttempts(ledger);
  if (open.length > 1) {
    throw new MigrationError(
      "Multiple unfinished migration attempts require manual repair",
      VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT
    );
  }
  const attempt = open[0];
  if (
    attempt &&
    (attempt.kind !== "started" || attempt.direction !== "rollback")
  ) {
    throw new MigrationError(
      "An unfinished migration attempt is blocking ordinary work",
      VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT
    );
  }
  return attempt;
}

/** An unfinished rollback resumes only as the first edge `down` selected. */
function assertResumesSelectedPath(
  graph: MigrationGraph,
  command: Parameters<typeof appendLedger>[1],
  supportsTransactions: boolean,
  attempt: LedgerEventV1,
  first: PreparedRollback
): void {
  const resumed = prepareRollbackAttempt(
    graph,
    command,
    supportsTransactions,
    attempt
  );
  if (
    resumed.edge.stateId !== first.edge.stateId ||
    resumed.nextState !== first.nextState ||
    resumed.edge.transitionHash !== first.edge.transitionHash
  ) {
    throw new MigrationError(
      "An unfinished rollback does not match the selected reverse path",
      VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT
    );
  }
}

function prepareRollbackAttempt(
  graph: MigrationGraph,
  command: Parameters<typeof appendLedger>[1],
  supportsTransactions: boolean,
  attempt: LedgerEventV1
): PreparedRollback {
  if (!(attempt.fromState && attempt.transitionHash)) {
    throw new MigrationError(
      "Unfinished rollback is missing its authenticated edge identity",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  const item = prepareRollbackEdge(graph, command, supportsTransactions, {
    stateId: attempt.fromState,
    transitionHash: attempt.transitionHash,
    baselineBoundary: false,
  });
  if (
    attempt.toState !== item.nextState ||
    attempt.estateHash !== graph.estateHash ||
    attempt.snapshotHash !== item.state.snapshotHash ||
    attempt.sqlHash !== item.state.sqlHash
  ) {
    throw new MigrationError(
      "Unfinished rollback does not match an authenticated estate edge",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  return item;
}

async function executeRollbackEdge(
  producer: AnyDriver,
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  item: PreparedRollback,
  current: MigrationMarkerV1,
  resume: LedgerEventV1 | undefined,
  ledger: readonly LedgerEventV1[],
  models: MigrationClient["$schema"]
): Promise<MigrationMarkerV1> {
  const { edge, state, blob, rollback, boundary, nextState } = item;
  if (
    current.stateId !== edge.stateId ||
    current.path.at(-1)?.stateId !== edge.stateId ||
    current.path.at(-1)?.transitionHash !== edge.transitionHash
  ) {
    throw new MigrationError(
      "Rollback marker does not name the authenticated edge being reversed",
      VibORMErrorCode.MIGRATION_MARKER_CONFLICT
    );
  }
  if (!resume) {
    await assertAllChecks(
      producer,
      blob,
      state.destinationChecks,
      command.namespace,
      "Destination checks failed before rollback"
    );
  }
  const seed = rollbackEventSeed(graph, item);
  const attemptId = resume?.attemptId ?? attemptIdFor(seed);
  if (!resume) {
    await appendLedger(
      producer,
      command,
      DEFAULT_CONTROL_BASE,
      ledgerEvent({
        ...seed,
        attemptId,
        kind: "started",
        operationId: null,
        dispatchId: null,
        effectState: "none",
        open: true,
      })
    );
  }
  await executeOperations(
    producer,
    blob,
    resume
      ? remainingRollbackOperations(graph, item, resume, ledger)
      : rollback.operations,
    boundary,
    (progress, effect) =>
      appendLedger(
        producer,
        command,
        DEFAULT_CONTROL_BASE,
        ledgerEvent({
          ...seed,
          attemptId,
          kind: "step-confirmed",
          operationId: progress.operationId,
          dispatchId: progress.dispatchId,
          effectState: effect,
        })
      ),
    command.namespace,
    { fromState: edge.stateId, toState: nextState }
  );
  // Manual rollback SQL may store text typed queries cannot compare.
  await canonicalizeSqliteStorage(
    producer,
    rollback.operations,
    models,
    requireStateSnapshot(graph, nextState)
  );
  const snapshotHash = await proveRolledBack(producer, command, graph, item);
  const next = await advanceMarker(
    producer,
    command,
    graph.estateHash,
    current,
    current.path.slice(0, -1),
    snapshotHash
  );
  await appendRolledBackEvent(producer, command, graph, item, attemptId);
  return next;
}

async function closeCompletedRollback(
  producer: AnyDriver,
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  item: PreparedRollback,
  attempt: LedgerEventV1,
  ledger: readonly LedgerEventV1[],
  marker: MigrationMarkerV1 | null
): Promise<void> {
  remainingRollbackOperations(graph, item, attempt, ledger);
  if (marker ? marker.stateId !== item.nextState : item.nextState !== null) {
    throw new MigrationError(
      "Rollback marker is neither before nor after the unfinished edge",
      VibORMErrorCode.MIGRATION_MARKER_CONFLICT
    );
  }
  await proveRolledBack(producer, command, graph, item);
  await appendRolledBackEvent(
    producer,
    command,
    graph,
    item,
    attempt.attemptId
  );
}

/**
 * Proves a reversed edge reached its parent: the origin checks hold and the
 * live schema is the parent's snapshot, whose hash it returns.
 */
async function proveRolledBack(
  producer: AnyDriver,
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  { parent, blob, nextState }: PreparedRollback
): Promise<Sha256> {
  await assertAllChecks(
    producer,
    blob,
    parent.originChecks,
    command.namespace,
    "Origin checks failed after rollback"
  );
  const snapshotHash = snapshotHashOf(graph, nextState);
  await proveLive(
    producer,
    command,
    graph,
    snapshotHash,
    () => "Rollback did not reach the parent snapshot"
  );
  return snapshotHash;
}

/** The fields every event of one reversed edge carries. */
function rollbackEventSeed(
  graph: MigrationGraph,
  { edge, state, nextState }: PreparedRollback
) {
  return {
    estateHash: graph.estateHash,
    snapshotHash: state.snapshotHash,
    sqlHash: state.sqlHash,
    fromState: edge.stateId,
    toState: nextState,
    transitionHash: edge.transitionHash,
    direction: "rollback",
  } as const;
}

async function appendRolledBackEvent(
  producer: AnyDriver,
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  item: PreparedRollback,
  attemptId: Sha256
): Promise<void> {
  await appendLedger(
    producer,
    command,
    DEFAULT_CONTROL_BASE,
    ledgerEvent({
      ...rollbackEventSeed(graph, item),
      snapshotHash: snapshotHashOf(graph, item.nextState),
      attemptId,
      kind: "rolled-back",
      operationId: null,
      dispatchId: null,
      effectState: "committed",
    })
  );
}

function remainingRollbackOperations(
  graph: MigrationGraph,
  item: PreparedRollback,
  attempt: LedgerEventV1,
  ledger: readonly LedgerEventV1[]
): PreparedRollback["rollback"]["operations"] {
  const steps = item.rollback.operations.flatMap((operation) =>
    operation.steps.map((step) => ({ operation, step }))
  );
  const byDispatch = new Map(
    steps.map(({ step }, index) => [step.execute.dispatchId, index])
  );
  const committed = new Set<number>();
  const announced = new Set<number>();
  for (const event of ledger) {
    if (
      event.attemptId !== attempt.attemptId ||
      event.kind !== "step-confirmed"
    )
      continue;
    if (
      event.direction !== "rollback" ||
      event.estateHash !== graph.estateHash ||
      event.fromState !== item.edge.stateId ||
      event.toState !== item.nextState ||
      event.transitionHash !== item.edge.transitionHash ||
      event.sqlHash !== item.state.sqlHash ||
      !event.dispatchId
    ) {
      throw new MigrationError(
        "Rollback progress does not match its authenticated edge",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    const index = byDispatch.get(event.dispatchId);
    if (
      index === undefined ||
      steps[index]!.operation.id !== event.operationId
    ) {
      throw new MigrationError(
        "Rollback progress names an unknown dispatch",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    if (event.effectState === "committed") committed.add(index);
    if (event.effectState === "none") announced.add(index);
  }
  const completed = confirmedPrefix(
    committed,
    "Rollback progress is not a contiguous dispatch prefix"
  );
  refuseAmbiguousNext(
    steps[completed]?.step,
    item.boundary,
    announced.has(completed),
    "The next rollback dispatch has an ambiguous commit outcome"
  );
  return sliceOperations(item.rollback.operations, completed);
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

/** `down({ expectRevision })`: the marker must still be the one the caller read. */
function assertExpectedRevision(
  marker: MigrationMarkerV1 | null,
  request: NormalizedDownOptions
): void {
  if (
    request.expectRevision === undefined ||
    marker?.revision === request.expectRevision
  ) {
    return;
  }
  throw new MigrationError(
    `down expected marker revision ${request.expectRevision}, but the marker is at revision ${marker?.revision ?? "none"}: another command moved it`,
    VibORMErrorCode.MIGRATION_MARKER_CONFLICT
  );
}

/**
 * Puts each destructive change the rollback makes to a table holding rows to
 * `resolve`, as generate and push ask (plan S4): a retried or mistaken `down`
 * cannot drop data unasked. Only edges whose stored rollback is destructive
 * are diffed: a manual rollback is SQL its author wrote and published, often
 * to move the rows back before a drop, so it is not asked again. An ambiguous
 * change counts as the drop it may be. A table an earlier edge of the path
 * recreates is absent live, and holds no rows.
 */
async function approveRollbackLosses(
  producer: Parameters<typeof appendLedger>[0],
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  prepared: readonly PreparedRollback[],
  resolve: ResolveCallback | undefined
): Promise<void> {
  const losses: DiffOperation[] = [];
  for (const item of prepared) {
    if (!item.rollback.operations.some((op) => op.risk === "destructive")) {
      continue;
    }
    const { operations, ambiguousChanges } = await diff(
      requireStateSnapshot(graph, item.edge.stateId),
      requireStateSnapshot(graph, item.nextState)
    );
    for (const change of [...operations, ...ambiguousChanges.map(asDrop)]) {
      if (
        "tableName" in change &&
        isDestructiveOperation(change) &&
        (await holdsRows(producer, command, change.tableName))
      ) {
        losses.push(change);
      }
    }
  }
  await approveDestructiveOperations(losses, resolve, false);
}

function asDrop(change: AmbiguousChange): DiffOperation {
  return change.type === "ambiguousTable"
    ? { type: "dropTable", tableName: change.droppedTable }
    : {
        type: "dropColumn",
        tableName: change.tableName,
        columnName: change.droppedColumn.name,
      };
}

/**
 * The absent-and-empty-table probe: an absent table (a later state dropped it,
 * or a resumed rollback already did) holds no rows.
 */
async function holdsRows(
  producer: Parameters<typeof appendLedger>[0],
  command: Parameters<typeof appendLedger>[1],
  table: string
): Promise<boolean> {
  if (await isTableMissing(producer, command, table)) return false;
  const name = renderQualifiedIdentifier(
    (part) => command.escapeIdentifier(part),
    boundNamespace(command),
    table
  );
  const result = await producer._executeRaw(
    `SELECT 1 AS populated FROM ${name} LIMIT 1`
  );
  return result.rows.length > 0;
}

/**
 * A rolled-back attempt must have left nothing behind. A manual opaque step of
 * it that committed, or was announced and never confirmed (it may have
 * committed), is an effect no fingerprint shows and that no rollback undid: a
 * forward attempt runs none. Marking it rolled back would let `apply` run the
 * step again — the double credit (plan S4). Generated steps are structural,
 * and so is a CONCURRENTLY index statement, whose index resolve repairs before
 * the origin proof (plan S7): the fingerprint proves those undone.
 */
function refuseOpaqueEffect(
  transition: ReturnType<typeof parentTransition>,
  blob: Uint8Array,
  attempt: LedgerEventV1,
  ledger: readonly LedgerEventV1[]
): void {
  const opaque = new Set(
    transition.operations.flatMap((operation) =>
      operation.steps.flatMap((step) =>
        operation.origin === "manual" &&
        step.retry === "opaque" &&
        concurrentIndexNames(sliceDispatch(blob, step.execute)).length === 0
          ? [step.execute.dispatchId]
          : []
      )
    )
  );
  const effects = ledger.filter(
    (event) =>
      event.attemptId === attempt.attemptId &&
      event.kind === "step-confirmed" &&
      opaque.has(event.dispatchId ?? "")
  );
  const effect =
    effects.find((event) => event.effectState === "committed") ?? effects[0];
  if (effect === undefined) return;
  const committed = effect.effectState === "committed";
  throw new MigrationError(
    `resolve cannot mark this attempt rolled back: its opaque dispatch ${effect.dispatchId} ${committed ? "committed" : "may have committed"} and nothing undid it. Finish the transition by hand and resolve({ outcome: "complete" }).`,
    committed
      ? VibORMErrorCode.MIGRATION_PARTIAL_EFFECT
      : VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
    {
      meta: {
        ...(attempt.fromState ? { fromState: attempt.fromState } : {}),
        ...(attempt.toState ? { toState: attempt.toState } : {}),
        operationId: effect.operationId ?? undefined,
        dispatchId: effect.dispatchId ?? undefined,
        lastConfirmedStep: effect.dispatchId ?? undefined,
        effectState: committed ? "committed" : "may-have-committed",
        partial: true,
      },
    }
  );
}

function rollbackSlice(
  graph: MigrationGraph,
  marker: MigrationMarkerV1,
  options: NormalizedDownOptions
): MigrationMarkerV1["path"] {
  if (marker.path.length === 0) {
    throw new MigrationError(
      "Nothing to roll back",
      VibORMErrorCode.MIGRATION_NOT_FOUND
    );
  }
  const steps = options.to
    ? distanceTo(
        marker.path.map((edge) => edge.stateId),
        resolveStateSelector(graph, options.to)
      )
    : options.steps;
  const removed = steps === 0 ? [] : marker.path.slice(-steps);
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
