/**
 * V1 operator commands: status, verify, log, baseline, down, resolve, reset.
 * Status/verify/log are read-only and never bootstrap missing control tables.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { renderQualifiedIdentifier } from "../sql/identifiers";
import { admitLiveMigrationCapability } from "./admission";
import {
  assertLockedSinceDecision,
  assertNoDrift,
  markerStanding,
} from "./apply-v1";
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
  appendLedger,
  casMarker,
  DEFAULT_CONTROL_BASE,
  ensureControlTables,
  isTableMissing,
  markerFromPath,
  readControlState,
  refuseIncompatibleHistory,
  refusePartialControl,
  unfinishedAttempts,
} from "./control";
import { diff, isDestructiveOperation } from "./differ";
import { type NormalizedDownOptions, normalizeDownOptions } from "./down-input";
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
  mayWrapTransaction,
  resolveCommandDriver,
  runSequentialProgram,
  withLockedMigrationProducer,
} from "./pinned-session";
import { getPushMigrationDriver, type MigrationClient } from "./push/planner";
import { fingerprintLive } from "./push-fingerprint";
import { introspectManaged } from "./push-plan";
import { approveDestructiveOperations } from "./resolver";
import { sliceDispatch } from "./sql-blob";
import { canonicalizeSqliteStorage } from "./sqlite-storage-audit";
import type { MigrationStorageReader } from "./storage/contract";
import { assertEstateTargetMatches } from "./target";
import type {
  AmbiguousChange,
  DiffOperation,
  ResolveCallback,
  SchemaSnapshot,
} from "./types";
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
  const driver = getPushMigrationDriver(client);
  assertEstateTargetMatches(graph.descriptor.target, driver.target);
  admitLiveMigrationCapability(driver, "read-only", "status()");
  const command = await resolveCommandDriver(client.$driver, driver);
  const control = await readControlState(
    client.$driver,
    command,
    DEFAULT_CONTROL_BASE
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
  const driver = getPushMigrationDriver(client);
  assertEstateTargetMatches(graph.descriptor.target, driver.target);
  admitLiveMigrationCapability(driver, "effectful", "verify()");
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const control = await readControlState(
        pinned,
        command,
        DEFAULT_CONTROL_BASE
      );
      if (control.presence.kind !== "present") {
        refusePartialControl(control.presence);
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
  const driver = getPushMigrationDriver(client);
  assertEstateTargetMatches(graph.descriptor.target, driver.target);
  admitLiveMigrationCapability(driver, "effectful", "baseline()");
  const target = resolveStateSelector(graph, options.to);
  const path = selectRoute(graph, null, target, options.via);
  return withLockedMigrationProducer(
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
      if (marker || unfinishedAttempts(ledger).length > 0) {
        throw new MigrationError(
          "baseline requires an unmarked database without an unfinished attempt",
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }
      refuseIncompatibleHistory(marker, ledger);
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
      const expected = requireStateSnapshot(graph, target);
      await command.preflightSchemaRequirements([expected], (sql, params) =>
        pinned._executeRaw(sql, params)
      );
      const live = await introspectManaged(pinned, command);
      if (
        (await fingerprintLive(live, command, pinned)) !==
        (await fingerprintLive(expected, command, pinned))
      ) {
        throw new MigrationError(
          `baseline requires exact live equality with the target snapshot. Differences: ${JSON.stringify(await diff(live, expected))}`,
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
      const publish = async (producer: Parameters<typeof casMarker>[0]) => {
        if (needsBootstrap) {
          await ensureControlTables(producer, command, DEFAULT_CONTROL_BASE);
        }
        await casMarker(producer, command, DEFAULT_CONTROL_BASE, null, next);
        await appendLedger(producer, command, DEFAULT_CONTROL_BASE, {
          ...event,
          eventId: eventIdFor(event),
        });
      };
      if (pinned.supportsTransactions) {
        await pinned.withTransaction((transaction) => publish(transaction));
      } else {
        await publish(pinned);
      }
      return { stateId: target };
    }
  );
}

export async function downV1(
  client: MigrationClient,
  storage: MigrationStorageReader,
  options: DownV1Options = {}
): Promise<{ readonly path: readonly Sha256[]; readonly preview: boolean }> {
  const request = normalizeDownOptions(options);
  const graph = await loadMigrationGraph(storage);
  const driver = getPushMigrationDriver(client);
  assertEstateTargetMatches(graph.descriptor.target, driver.target);
  const dryRun = request.dryRun;
  admitLiveMigrationCapability(
    driver,
    dryRun ? "read-only" : "effectful",
    "down()"
  );
  if (dryRun) {
    const control = await readControlState(
      client.$driver,
      driver,
      DEFAULT_CONTROL_BASE
    );
    refusePartialControl(control.presence);
    const { marker } = control;
    assertExpectedRevision(marker, request);
    if (!marker) {
      throw new MigrationError(
        "Nothing to roll back",
        VibORMErrorCode.MIGRATION_NOT_FOUND
      );
    }
    const removed = rollbackSlice(graph, marker, request);
    return { path: removed.map((edge) => edge.stateId), preview: true };
  }
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const control = await readControlState(
        pinned,
        command,
        DEFAULT_CONTROL_BASE
      );
      refusePartialControl(control.presence);
      const { ledger, marker } = control;
      assertExpectedRevision(marker, request);
      const open = unfinishedAttempts(ledger);
      if (open.length > 1) {
        throw new MigrationError(
          "Multiple unfinished migration attempts require manual repair",
          VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT
        );
      }
      const rollbackAttempt = open[0];
      if (
        rollbackAttempt &&
        (rollbackAttempt.kind !== "started" ||
          rollbackAttempt.direction !== "rollback")
      ) {
        throw new MigrationError(
          "An unfinished migration attempt is blocking ordinary work",
          VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT
        );
      }
      if (!marker) {
        if (rollbackAttempt?.toState === null) {
          const item = prepareRollbackAttempt(
            graph,
            command,
            pinned.supportsTransactions,
            rollbackAttempt
          );
          await command.preflightSchemaRequirements(
            [requireStateSnapshot(graph, item.nextState)],
            (sql, params) => pinned._executeRaw(sql, params)
          );
          const close = (producer: Parameters<typeof appendLedger>[0]) =>
            closeCompletedRollback(
              producer,
              command,
              graph,
              item,
              rollbackAttempt,
              ledger,
              null
            );
          if (command.target.dialect === "mysql") {
            await runSequentialProgram(pinned, command, close);
          } else {
            await close(pinned);
          }
          return { path: [item.edge.stateId], preview: false };
        }
        throw new MigrationError(
          "Nothing to roll back",
          VibORMErrorCode.MIGRATION_NOT_FOUND
        );
      }
      if (rollbackAttempt?.toState === marker.stateId) {
        const item = prepareRollbackAttempt(
          graph,
          command,
          pinned.supportsTransactions,
          rollbackAttempt
        );
        await command.preflightSchemaRequirements(
          [requireStateSnapshot(graph, item.nextState)],
          (sql, params) => pinned._executeRaw(sql, params)
        );
        const close = (producer: Parameters<typeof appendLedger>[0]) =>
          closeCompletedRollback(
            producer,
            command,
            graph,
            item,
            rollbackAttempt,
            ledger,
            marker
          );
        if (command.target.dialect === "mysql") {
          await runSequentialProgram(pinned, command, close);
        } else {
          await close(pinned);
        }
        return { path: [item.edge.stateId], preview: false };
      }
      const removed = rollbackSlice(graph, marker, request);
      if (removed.length === 0) return { path: [], preview: false };
      const reverse = [...removed].reverse();
      for (const edge of reverse) {
        assertReversibleEdge(graph, edge);
      }
      const prepared = reverse.map((edge) =>
        prepareRollbackEdge(graph, command, pinned.supportsTransactions, edge)
      );
      const rollbackSnapshots = prepared.map((item) =>
        requireStateSnapshot(graph, item.nextState)
      );
      await command.preflightSchemaRequirements(
        [requireStateSnapshot(graph, marker.stateId), ...rollbackSnapshots],
        (sql, params) => pinned._executeRaw(sql, params),
        prepared.flatMap((item) =>
          stepStatements(item.blob, item.rollback.operations)
        )
      );
      if (!rollbackAttempt) {
        await assertNoDrift(pinned, command, graph, marker);
      }
      if (rollbackAttempt) {
        const resumed = prepareRollbackAttempt(
          graph,
          command,
          pinned.supportsTransactions,
          rollbackAttempt
        );
        const first = prepared[0]!;
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
      await approveRollbackLosses(
        pinned,
        command,
        graph,
        prepared,
        request.resolve
      );
      const run = async (producer: Parameters<typeof appendLedger>[0]) => {
        let current = marker;
        const statementsOf = (item: (typeof prepared)[number]) =>
          stepStatements(item.blob, item.rollback.operations);
        for (const group of groupContiguousAtomicity(prepared, statementsOf)) {
          const statements = group.items.flatMap(statementsOf);
          const lifted = liftForeignKeyPragmas(pinned, statements);
          const executeGroup = async (
            groupProducer: Parameters<typeof appendLedger>[0]
          ) => {
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
                item === prepared[0] ? rollbackAttempt : undefined,
                ledger,
                client.$schema
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
            await withForeignKeysLifted(pinned, lifted.bracket, (inside) =>
              pinned.withTransaction((transaction) =>
                inside(transaction, executeGroup)
              )
            );
          } else {
            await executeGroup(producer);
          }
        }
      };
      if (command.target.dialect === "mysql") {
        await runSequentialProgram(pinned, command, run);
      } else {
        await run(pinned);
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
      const control = await readControlState(
        pinned,
        command,
        DEFAULT_CONTROL_BASE
      );
      refusePartialControl(control.presence);
      const { ledger } = control;
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
      const live = await introspectManaged(pinned, command);
      const destHolds =
        (await fingerprintLive(live, command, pinned)) ===
          (await fingerprintLive(destSnapshot, command, pinned)) &&
        (await evaluateAllChecks(
          pinned,
          blob,
          state.destinationChecks,
          command.namespace
        ));
      const originHolds =
        (await fingerprintLive(live, command, pinned)) ===
          (await fingerprintLive(originSnapshot, command, pinned)) &&
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
        const finish = async (producer: Parameters<typeof appendLedger>[0]) => {
          // Completing manual SQL canonicalizes what it stored, as apply does.
          await canonicalizeSqliteStorage(
            producer,
            transition.operations,
            client.$schema,
            destSnapshot
          );
          await finishResolve(producer, command, graph, attempt, "applied", to);
        };
        if (command.target.dialect === "mysql") {
          await runSequentialProgram(pinned, command, finish);
        } else if (pinned.supportsTransactions) {
          await pinned.withTransaction(finish);
        } else {
          await finish(pinned);
        }
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
        const finish = (producer: Parameters<typeof appendLedger>[0]) =>
          finishResolve(producer, command, graph, attempt, "rolled-back", from);
        if (command.target.dialect === "mysql") {
          await runSequentialProgram(pinned, command, finish);
        } else if (pinned.supportsTransactions) {
          await pinned.withTransaction(finish);
        } else {
          await finish(pinned);
        }
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
      const executeRetry = async (
        producer: Parameters<typeof appendLedger>[0]
      ) => {
        await executeOperations(
          producer,
          blob,
          transition.operations,
          boundary,
          undefined,
          command.namespace,
          { fromState: from, toState: to }
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
            "Retry did not reach the destination",
            VibORMErrorCode.MIGRATION_DRIFT
          );
        }
        const liveAfter = await introspectManaged(producer, command);
        if (
          !destSnapshot ||
          (await fingerprintLive(liveAfter, command, producer)) !==
            (await fingerprintLive(destSnapshot, command, producer))
        ) {
          throw new MigrationError(
            "Retry did not reach the destination",
            VibORMErrorCode.MIGRATION_DRIFT
          );
        }
        await finishResolve(producer, command, graph, attempt, "applied", to);
      };
      if (command.target.dialect === "mysql") {
        await runSequentialProgram(pinned, command, executeRetry);
      } else if (
        mayWrapTransaction(
          pinned,
          command.target.dialect,
          boundary === "transactional"
        )
      ) {
        const statements = stepStatements(blob, transition.operations);
        const lifted = liftForeignKeyPragmas(pinned, statements);
        await withForeignKeysLifted(pinned, lifted.bracket, (inside) =>
          pinned.withTransaction((transaction) =>
            inside(transaction, executeRetry)
          )
        );
      } else {
        // A recreation is refused here: without a transaction its lift is unproven.
        liftForeignKeyPragmas(
          pinned,
          stepStatements(blob, transition.operations)
        );
        await executeRetry(pinned);
      }
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
  pinned: Parameters<typeof appendLedger>[0],
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  attempt: LedgerEventV1,
  kind: "applied" | "rolled-back",
  to: Sha256 | null
): Promise<void> {
  const control = await readControlState(pinned, command, DEFAULT_CONTROL_BASE);
  refusePartialControl(control.presence);
  const { marker } = control;
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

function prepareRollbackAttempt(
  graph: MigrationGraph,
  command: Parameters<typeof appendLedger>[1],
  supportsTransactions: boolean,
  attempt: LedgerEventV1
): ReturnType<typeof prepareRollbackEdge> {
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
  producer: Parameters<typeof appendLedger>[0],
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  item: ReturnType<typeof prepareRollbackEdge>,
  current: MigrationMarkerV1,
  resume: LedgerEventV1 | undefined,
  ledger: readonly LedgerEventV1[],
  models: MigrationClient["$schema"]
): Promise<MigrationMarkerV1> {
  const { edge, state, parent, blob, rollback, boundary, nextState } = item;
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
  if (
    !resume &&
    state.destinationChecks.length > 0 &&
    !(await evaluateAllChecks(
      producer,
      blob,
      state.destinationChecks,
      command.namespace
    ))
  ) {
    throw new MigrationError(
      "Destination checks failed before rollback",
      VibORMErrorCode.MIGRATION_DRIFT
    );
  }
  const attemptId =
    resume?.attemptId ??
    eventIdFor({
      format: "1",
      attemptId: "0".repeat(64),
      kind: "started",
      estateHash: graph.estateHash,
      snapshotHash: state.snapshotHash,
      sqlHash: state.sqlHash,
      fromState: edge.stateId,
      toState: nextState,
      transitionHash: edge.transitionHash,
      direction: "rollback",
      operationId: null,
      dispatchId: null,
      effectState: "none",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      toolVersion: "v1",
      failure: null,
    });
  if (!resume) {
    const started = {
      format: "1" as const,
      attemptId,
      kind: "started" as const,
      estateHash: graph.estateHash,
      snapshotHash: state.snapshotHash,
      sqlHash: state.sqlHash,
      fromState: edge.stateId,
      toState: nextState,
      transitionHash: edge.transitionHash,
      direction: "rollback" as const,
      operationId: null,
      dispatchId: null,
      effectState: "none" as const,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      toolVersion: "v1",
      failure: null,
    };
    await appendLedger(producer, command, DEFAULT_CONTROL_BASE, {
      ...started,
      eventId: eventIdFor(started),
    });
  }
  const operations = resume
    ? remainingRollbackOperations(graph, item, resume, ledger)
    : rollback.operations;
  await executeOperations(
    producer,
    blob,
    operations,
    boundary,
    async (progress, effect) => {
      const confirmed = {
        format: "1" as const,
        attemptId,
        kind: "step-confirmed" as const,
        estateHash: graph.estateHash,
        snapshotHash: state.snapshotHash,
        sqlHash: state.sqlHash,
        fromState: edge.stateId,
        toState: nextState,
        transitionHash: edge.transitionHash,
        direction: "rollback" as const,
        operationId: progress.operationId,
        dispatchId: progress.dispatchId,
        effectState: effect,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        toolVersion: "v1",
        failure: null,
      };
      await appendLedger(producer, command, DEFAULT_CONTROL_BASE, {
        ...confirmed,
        eventId: eventIdFor(confirmed),
      });
    },
    command.namespace,
    { fromState: edge.stateId, toState: nextState }
  );
  const snapshotHash = nextState
    ? graph.states.get(nextState)!.snapshotHash
    : graph.emptySnapshotHash;
  const expected =
    graph.snapshots.get(snapshotHash) ??
    (snapshotHash === graph.emptySnapshotHash
      ? emptyManagedSnapshot()
      : undefined);
  // Manual rollback SQL may store text typed queries cannot compare.
  if (expected) {
    await canonicalizeSqliteStorage(
      producer,
      rollback.operations,
      models,
      expected
    );
  }
  if (
    parent.originChecks.length > 0 &&
    !(await evaluateAllChecks(
      producer,
      blob,
      parent.originChecks,
      command.namespace
    ))
  ) {
    throw new MigrationError(
      "Origin checks failed after rollback",
      VibORMErrorCode.MIGRATION_DRIFT
    );
  }
  const live = await introspectManaged(producer, command);
  if (
    !expected ||
    (await fingerprintLive(live, command, producer)) !==
      (await fingerprintLive(expected, command, producer))
  ) {
    throw new MigrationError(
      "Rollback did not reach the parent snapshot",
      VibORMErrorCode.MIGRATION_DRIFT
    );
  }
  const nextPath = current.path.slice(0, -1);
  const next = markerFromPath(
    graph.estateHash,
    snapshotHash,
    nextPath,
    current.revision + 1
  );
  await casMarker(
    producer,
    command,
    DEFAULT_CONTROL_BASE,
    {
      revision: current.revision,
      pathHash: current.pathHash,
    },
    next
  );
  await appendRolledBackEvent(
    producer,
    command,
    graph,
    item,
    attemptId,
    snapshotHash
  );
  return next;
}

async function closeCompletedRollback(
  producer: Parameters<typeof appendLedger>[0],
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  item: ReturnType<typeof prepareRollbackEdge>,
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
  const { parent, blob, nextState } = item;
  if (
    parent.originChecks.length > 0 &&
    !(await evaluateAllChecks(
      producer,
      blob,
      parent.originChecks,
      command.namespace
    ))
  ) {
    throw new MigrationError(
      "Origin checks failed after rollback",
      VibORMErrorCode.MIGRATION_DRIFT
    );
  }
  const snapshotHash = nextState
    ? graph.states.get(nextState)!.snapshotHash
    : graph.emptySnapshotHash;
  const expected =
    graph.snapshots.get(snapshotHash) ??
    (snapshotHash === graph.emptySnapshotHash
      ? emptyManagedSnapshot()
      : undefined);
  const live = await introspectManaged(producer, command);
  if (
    !expected ||
    (await fingerprintLive(live, command, producer)) !==
      (await fingerprintLive(expected, command, producer))
  ) {
    throw new MigrationError(
      "Rollback did not reach the parent snapshot",
      VibORMErrorCode.MIGRATION_DRIFT
    );
  }
  await appendRolledBackEvent(
    producer,
    command,
    graph,
    item,
    attempt.attemptId,
    snapshotHash
  );
}

async function appendRolledBackEvent(
  producer: Parameters<typeof appendLedger>[0],
  command: Parameters<typeof appendLedger>[1],
  graph: MigrationGraph,
  item: ReturnType<typeof prepareRollbackEdge>,
  attemptId: Sha256,
  snapshotHash: Sha256
): Promise<void> {
  const { edge, state, nextState } = item;
  const rolled = {
    format: "1" as const,
    attemptId,
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
  await appendLedger(producer, command, DEFAULT_CONTROL_BASE, {
    ...rolled,
    eventId: eventIdFor(rolled),
  });
}

function remainingRollbackOperations(
  graph: MigrationGraph,
  item: ReturnType<typeof prepareRollbackEdge>,
  attempt: LedgerEventV1,
  ledger: readonly LedgerEventV1[]
): ReturnType<typeof prepareRollbackEdge>["rollback"]["operations"] {
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
  let completed = 0;
  while (committed.has(completed)) completed += 1;
  if ([...committed].some((index) => index >= completed)) {
    throw new MigrationError(
      "Rollback progress is not a contiguous dispatch prefix",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  const next = steps[completed];
  if (
    next?.step.retry === "opaque" &&
    item.boundary === "stepwise" &&
    announced.has(completed)
  ) {
    throw new MigrationError(
      "The next rollback dispatch has an ambiguous commit outcome",
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
  let skipped = completed;
  return item.rollback.operations.flatMap((operation) => {
    if (skipped >= operation.steps.length) {
      skipped -= operation.steps.length;
      return [];
    }
    const steps = operation.steps.slice(skipped);
    skipped = 0;
    return [{ ...operation, steps }];
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
  prepared: readonly ReturnType<typeof prepareRollbackEdge>[],
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
