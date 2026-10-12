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
  controlTableNames,
  DEFAULT_CONTROL_BASE,
  ensureControlTables,
  markerFromPath,
  markerUnmovedCondition,
  markerWrite,
  readControlState,
  readPostgresDecision,
  refuseIncompatibleHistory,
  refusePartialControl,
  unfinishedAttempts,
} from "./control";
import type { BoundMigrationDriver } from "./drivers";
import { postgresCatalogDigestQuery } from "./drivers/postgres/catalog-digest";
import {
  checkCondition,
  evaluateAllChecks,
  executeOperations,
} from "./execute-dispatch";
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
  MIGRATION_LOCK_FREE,
  type MigrationBatch,
  mayWrapTransaction,
  openMigrationBatch,
  runSequentialProgram,
  runsMigrationBatches,
  withLockedMigrationProducer,
} from "./pinned-session";
import {
  assertEmptyManaged,
  assertLockedSinceDecision,
  assertNoDrift,
  markedSnapshotHash,
  markerStanding,
  proveLive,
  snapshotOf,
} from "./proof";
import { getPushMigrationDriver, type MigrationClient } from "./push/planner";
import { fingerprintDeparsed, fingerprintSnapshot } from "./push-fingerprint";
import type { introspectManaged } from "./push-plan";
import { canonicalizeSqliteStorage } from "./sqlite-storage-audit";
import type { MigrationStorageReader } from "./storage/contract";
import { assertEstateTargetMatches } from "./target";
import type { SchemaSnapshot } from "./types";
import { eventIdFor } from "./v1-parse";
import type {
  ApplyV1Options,
  LedgerEventV1,
  MarkerPathEdgeV1,
  MigrationBooleanCheckV1,
  MigrationMarkerV1,
  MigrationStateManifestV1,
} from "./v1-types";

// Moved to proof.ts; re-exported for the commands not yet importing from there.
export {
  assertLockedSinceDecision,
  assertNoDrift,
  markerStanding,
} from "./proof";

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
    dryRun ? "read-only" : "batch",
    dryRun ? "apply({ dryRun: true })" : "apply()"
  );

  if (dryRun) {
    const control = await readControlState(
      client.$driver,
      driver,
      DEFAULT_CONTROL_BASE,
      { ledger: "open" }
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
        DEFAULT_CONTROL_BASE,
        { ledger: "open" }
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
    },
    driver.target.dialect === "postgresql"
      ? (session, lockFree) =>
          provenNoop(session, lockFree, driver, graph, target, options)
      : undefined
  );
  return keepCommittedOutcome(committed, locked);
}

/**
 * Plan D5 (decision 7): a PostgreSQL apply with nothing to do proves it
 * before the lock, in two statements: the control tables' definition, then
 * the marker, the open attempts and the catalog digest, read in one snapshot
 * while no other command holds the lock (`lockFree`). A database at the
 * target, with nothing open and no drift, was there at that instant, which is
 * all a no-op claims, and it writes nothing a lock would protect. Anything
 * else — another command at work included — or anything this read cannot
 * decide, goes to the locked path, which decides again under the lock.
 */
async function provenNoop(
  session: Parameters<typeof introspectManaged>[0],
  lockFree: string,
  driver: BoundMigrationDriver,
  graph: MigrationGraph,
  target: Sha256,
  options: ApplyV1Options
): Promise<ApplyV1Result | undefined> {
  const decision = await readPostgresDecision(
    session,
    driver,
    DEFAULT_CONTROL_BASE,
    lockFree
  );
  const marker = decision?.marker;
  if (!marker || unfinishedAttempts(decision.ledger).length > 0) return;
  // A refusal thrown here is decided again, and thrown, under the lock.
  if (followsAheadPolicy(graph, marker, options)) {
    return { outcome: "noop", path: [], statements: [] };
  }
  if (marker.stateId !== target || decision.digest === undefined) return;
  const expected = snapshotOf(graph, markedSnapshotHash(graph, marker));
  // Partial-index predicates compare as the server deparsed them: the live
  // ones in the digest, the snapshot's from the record beside the marker.
  return expected &&
    decision.digest ===
      fingerprintDeparsed(expected, decision.predicates, driver)
    ? { outcome: "noop", path: [], statements: [] }
    : undefined;
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
  const batched = runsMigrationBatches(pinned);
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
      pinned.supportsTransactions || batched,
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
    const boundary = classifyStoredAtomicity(
      command,
      transition.requestedForwardBoundary,
      transition.operations,
      blob
    );
    // Plan D7: a transport with no session runs only transactional groups,
    // each as one request. Refused while the path is prepared.
    if (batched && boundary === "stepwise") {
      throw new MigrationError(
        `The driver "${pinned.driverName}" sends each transactional group as one request and has no session for a stepwise transition (CONCURRENTLY, or a manual stepwise step). Nothing ran. Apply it over a session driver: viborm/pg, Neon's WebSocket Pool included.`,
        VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
        {
          meta: {
            dialect: "postgresql",
            toState: to,
            feature: "stepwise execution",
          },
        }
      );
    }
    return { from, to, transition, state, blob, boundary };
  });

  let current = marker;
  const nextPath = marker ? [...marker.path] : [];
  let bootstrapPending = needsBootstrap;
  const statementsOf = ({ transition, blob }: PreparedForwardEdge) =>
    stepStatements(blob, transition.operations);
  for (const group of groupContiguousAtomicity(prepared, statementsOf)) {
    if (batched) {
      // Before the request: the bootstrap reads what one request cannot.
      if (bootstrapPending) {
        await ensureControlTables(pinned, command, DEFAULT_CONTROL_BASE);
        bootstrapPending = false;
      }
      current = await applyGroupBatch(
        pinned,
        command,
        graph,
        group.items,
        current,
        nextPath,
        models
      );
      continue;
    }
    const statements = group.items.flatMap(statementsOf);
    const lifted = liftForeignKeyPragmas(pinned, statements);
    const running: { attempt?: ForwardAttempt } = {};
    const run = async (
      producer: Parameters<typeof appendLedger>[0],
      atomic: boolean
    ) => {
      await assertLockedSinceDecision(pinned, producer, command, current);
      if (bootstrapPending) {
        await ensureControlTables(producer, command, DEFAULT_CONTROL_BASE);
        bootstrapPending = false;
      }
      if (atomic) {
        current = await executeAtomicGroup(
          producer,
          command,
          graph,
          group.items,
          running,
          current,
          nextPath,
          models
        );
        return;
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
            await inside(transaction, (producer) => run(producer, true));
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
      await run(pinned, false);
    }
  }
}

/**
 * One group inside a real transaction (plan D5). Its rollback is the proof
 * of every step, so the statements run unprobed and leave no progress rows
 * or `started` events; the group's last state is proven once, the marker
 * moves once (by one revision per edge, as edge by edge), and every edge's
 * `applied` event lands in one statement. Between the first DDL and the
 * COMMIT this sends the DDL, the authored checks and three control
 * statements.
 */
async function executeAtomicGroup(
  producer: Parameters<typeof appendLedger>[0],
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  items: readonly PreparedForwardEdge[],
  running: { attempt?: ForwardAttempt },
  current: MigrationMarkerV1 | null,
  nextPath: MarkerPathEdgeV1[],
  models: MigrationClient["$schema"],
  batch?: MigrationBatch
): Promise<MigrationMarkerV1> {
  const arrivals: LedgerEventV1[] = [];
  for (const item of items) {
    const attemptId = forwardAttemptId(graph, item);
    running.attempt = { item, attemptId };
    const { from, to, transition, state, blob } = item;
    await assertChecks(
      producer,
      command,
      blob,
      transition.originChecks,
      "origin",
      batch
    );
    await executeOperations(
      producer,
      blob,
      transition.operations,
      "atomic",
      undefined,
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
    await assertChecks(
      producer,
      command,
      blob,
      state.destinationChecks,
      "destination",
      batch
    );
    nextPath.push({
      stateId: to,
      transitionHash: transition.transitionHash,
      baselineBoundary: false,
    });
    arrivals.push(
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
  }
  const { snapshotHash } = items.at(-1)!.state;
  const next = markerFromPath(
    graph.estateHash,
    snapshotHash,
    [...nextPath],
    (current?.revision ?? 0) + items.length
  );
  const expected = current
    ? { revision: current.revision, pathHash: current.pathHash }
    : null;
  if (batch) {
    assertDigest(batch, command, requireStateSnapshot(graph, items.at(-1)!.to));
    // The request asserted `expected` under its lock first.
    const write = markerWrite(command, DEFAULT_CONTROL_BASE, expected, next);
    await producer._executeRaw(write.sql, write.params);
  } else {
    const predicates = await proveLive(producer, command, graph, snapshotHash);
    await casMarker(
      producer,
      command,
      DEFAULT_CONTROL_BASE,
      expected,
      next,
      predicates
    );
  }
  await appendLedger(producer, command, DEFAULT_CONTROL_BASE, ...arrivals);
  return next;
}

/**
 * Plan D7: one transactional group as ONE request, on a transport with no
 * session. The request takes the transaction lock, asserts that the marker
 * is still the one this command decided on and that no attempt is open
 * ({@link assertLockedSinceDecision} in SQL), then runs the group as
 * {@link executeAtomicGroup} does, its checks and destination proof asserted
 * in SQL. A request the server refused rolled back; after a lost reply the
 * marker says whether it committed ({@link commitLanded}).
 */
async function applyGroupBatch(
  driver: Parameters<typeof appendLedger>[0],
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  items: readonly PreparedForwardEdge[],
  current: MigrationMarkerV1 | null,
  nextPath: MarkerPathEdgeV1[],
  models: MigrationClient["$schema"]
): Promise<MigrationMarkerV1> {
  const batch = openMigrationBatch(driver, command);
  const unmoved = markerUnmovedCondition(
    command,
    DEFAULT_CONTROL_BASE,
    current
  );
  batch.assert(
    unmoved.sql,
    unmoved.params,
    new MigrationError(
      "Another migration command moved the marker, or opened an attempt, after this command read it. Nothing of this request was applied; running the command again re-reads the marker.",
      VibORMErrorCode.MIGRATION_MARKER_CONFLICT
    )
  );
  const running: { attempt?: ForwardAttempt } = {};
  const next = await executeAtomicGroup(
    batch.producer,
    command,
    graph,
    items,
    running,
    current,
    nextPath,
    models,
    batch
  );
  try {
    await batch.send();
  } catch (failure) {
    if (
      !(failure instanceof MigrationError) &&
      (await commitLanded(driver, command, items, next, failure))
    ) {
      return next;
    }
    await recordFailedAttempt(driver, command, graph, running, failure);
    throw failure;
  }
  return next;
}

/**
 * The destination proof inside one request (plan D7): the catalog digest
 * (`catalog-digest.ts`) is the snapshot's fingerprint. Where the digest
 * abstains, the request cannot prove the destination, and is refused.
 */
function assertDigest(
  batch: MigrationBatch,
  command: BoundMigrationDriver,
  snapshot: SchemaSnapshot
): void {
  const digest = postgresCatalogDigestQuery(
    command,
    controlTableNames(DEFAULT_CONTROL_BASE)
  );
  batch.assert(
    `(${digest.sql}) IS NOT NULL`,
    digest.parameters,
    new MigrationError(
      "This change cannot be proven inside one request: the catalog digest abstains on the destination schema (a partial index, or a default it cannot reproduce; see drivers/postgres/catalog-digest.ts). Nothing was applied. Apply it over a session driver: viborm/pg, Neon's WebSocket Pool included.",
      VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER
    )
  );
  batch.assert(
    `(${digest.sql}) = $7`,
    [...digest.parameters, fingerprintSnapshot(snapshot, command)],
    new MigrationError(
      "Live managed schema drifted from the authenticated snapshot",
      VibORMErrorCode.MIGRATION_DRIFT
    )
  );
}

/** An edge's authored origin or destination checks, which must all hold. */
async function assertChecks(
  producer: Parameters<typeof appendLedger>[0],
  command: BoundMigrationDriver,
  blob: Uint8Array,
  checks: readonly MigrationBooleanCheckV1[],
  side: "origin" | "destination",
  batch?: MigrationBatch
): Promise<void> {
  const refusal = () =>
    new MigrationError(
      side === "origin"
        ? "Origin checks failed before the first dispatch"
        : "Destination checks failed before the marker could advance",
      VibORMErrorCode.MIGRATION_DRIFT
    );
  if (batch) {
    for (const check of checks) {
      const { sql, params } = checkCondition(blob, check, command.namespace);
      batch.assert(sql, params, refusal());
    }
    return;
  }
  if (await evaluateAllChecks(producer, blob, checks, command.namespace)) {
    return;
  }
  throw refusal();
}

interface ForwardAttempt {
  readonly item: PreparedForwardEdge;
  readonly attemptId: Sha256;
}

/**
 * Whether a transaction whose COMMIT was sent, and then failed, committed.
 * The marker it compare-and-swapped answers: it commits with the transition
 * or not at all. When even the marker cannot be read, the outcome is the
 * ambiguous commit V11020 it is (plan S3). Without a session (plan D7) it is
 * read only while no command holds the lock, so never while the request
 * whose reply was lost may still run.
 */
async function commitLanded(
  pinned: Parameters<typeof appendLedger>[0],
  command: BoundMigrationDriver,
  items: readonly PreparedForwardEdge[],
  expected: MigrationMarkerV1 | null,
  failure: unknown
): Promise<boolean> {
  // On a lost connection the pinned view refuses this read (plan S2).
  const marker = await (runsMigrationBatches(pinned)
    ? readPostgresDecision(
        pinned,
        command,
        DEFAULT_CONTROL_BASE,
        MIGRATION_LOCK_FREE
      ).then((decision) => decision?.marker)
    : readControlState(pinned, command, DEFAULT_CONTROL_BASE, {
        ledger: "open",
      }).then((control) => control.marker)
  ).catch(() => undefined);
  if (marker === undefined) {
    const fromState = items[0]?.from ?? null;
    throw new MigrationError(
      "The migration's COMMIT was sent but its reply was lost, and the marker cannot be re-read, or another request still holds the migration lock: the transition may have committed. status() and apply() re-read the marker.",
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
    if (runsMigrationBatches(pinned)) {
      // Its control tables were made before the request (plan D7).
      await appendLedger(pinned, command, DEFAULT_CONTROL_BASE, event);
      return;
    }
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
  await assertChecks(
    producer,
    command,
    blob,
    transition.originChecks,
    "origin"
  );
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
  await assertChecks(
    producer,
    command,
    blob,
    state.destinationChecks,
    "destination"
  );
  const predicates = await proveLive(
    producer,
    command,
    graph,
    state.snapshotHash
  );
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
    next,
    predicates
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
