/**
 * Apply V1: authenticate the graph, lock, refuse drift, execute exact slices,
 * then CAS the marker. Production never evaluates TypeScript.
 */

import { isVibORMError, MigrationError, VibORMErrorCode } from "../errors";
import {
  assertTransactionalBoundaryHonored,
  classifyStoredAtomicity,
  groupContiguousAtomicity,
  refuseSqliteStepwise,
  stepStatements,
} from "./compile";
import {
  type AttemptEvents,
  advanceMarker,
  appendLedger,
  attemptEvents,
  CONTROL_TABLES,
  ensureControlTables,
  markerFromPath,
  markerUnmovedCondition,
  markerWrite,
  readControlState,
  readPostgresDecision,
  refuseIncompatibleHistory,
  sameMarker,
  unfinishedAttempts,
} from "./control";
import type { BoundMigrationDriver } from "./drivers";
import { assertAllChecks, executeOperations } from "./execute-dispatch";
import {
  loadMigrationGraph,
  type MigrationGraph,
  type RouteEdge,
  requireStateSnapshot,
  resolveStateSelector,
  routeEdges,
  selectRoute,
} from "./graph";
import type { Sha256 } from "./identity";
import {
  commitLockedTransaction,
  type MigrationBatch,
  migrationLockFree,
  openMigrationBatch,
  runProgram,
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
} from "./proof";
import type { MigrationClient } from "./push/planner";
import { fingerprintDeparsed, fingerprintSnapshot } from "./push-fingerprint";
import type { introspectManaged } from "./push-plan";
import { openCommand, readCommandControl } from "./resume";
import { canonicalizeSqliteStorage } from "./sqlite-storage-audit";
import type { MigrationStorageReader } from "./storage/contract";
import type { SchemaSnapshot } from "./types";
import type {
  ApplyV1Options,
  LedgerEventV1,
  MarkerPathEdgeV1,
  MigrationMarkerV1,
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
  const dryRun = options.dryRun === true;
  const driver = openCommand(
    client,
    graph,
    dryRun ? "read-only" : "batch",
    dryRun ? "apply({ dryRun: true })" : "apply()"
  );
  const target = resolveStateSelector(graph, options.to);

  if (dryRun) {
    const control = await readCommandControl(client.$driver, driver);
    const decision = decide(graph, control.marker, target, options);
    if (!decision || decision.origin === target) {
      return { outcome: "noop", path: [], statements: [] };
    }
    const { path, statements } = decision;
    return { outcome: "preview", path, statements };
  }

  // Set once the path committed: a failure after it is the lock's release.
  const committed: { result?: ApplyV1Result } = {};
  const locked = withLockedMigrationProducer<ApplyV1Result>(
    client.$driver,
    driver,
    async (pinned, command) => {
      const control = await readCommandControl(pinned, command, true);
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
      const decision = decide(graph, marker, target, options);
      if (!decision) return { outcome: "noop", path: [], statements: [] };
      const { origin, path, statements } = decision;
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
      // On MySQL the whole path is one sequential program.
      await runProgram(pinned, command, undefined, (producer) =>
        applyPathUnderLock(
          producer,
          command,
          graph,
          marker,
          origin,
          path,
          client.$schema,
          needsBootstrap
        )
      );
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
  const decision = await readPostgresDecision(session, driver, lockFree);
  const marker = decision?.marker;
  if (!marker || unfinishedAttempts(decision.ledger).length > 0) return;
  // A refusal thrown here is decided again, and thrown, under the lock.
  if (followsAheadPolicy(graph, marker, options)) {
    return { outcome: "noop", path: [], statements: [] };
  }
  if (marker.stateId !== target || decision.digest === undefined) return;
  // `markedSnapshotHash` proved the snapshot is in the estate. Partial-index
  // predicates compare as the server deparsed them: the live ones in the
  // digest, the snapshot's from the record beside the marker.
  const expected = graph.snapshots.get(markedSnapshotHash(graph, marker))!;
  return decision.digest ===
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

/**
 * What apply does from `marker`, shared by the dry run and the locked apply:
 * its ahead policy, origin, route and authenticated artifacts. `undefined`
 * when `ifAhead: "noop"` applies.
 */
function decide(
  graph: MigrationGraph,
  marker: MigrationMarkerV1 | null,
  target: Sha256,
  options: ApplyV1Options
):
  | { origin: Sha256 | null; path: readonly Sha256[]; statements: string[] }
  | undefined {
  if (followsAheadPolicy(graph, marker, options)) return;
  const origin = marker?.stateId ?? null;
  const path =
    origin === target ? [] : selectRoute(graph, origin, target, options.via);
  return { origin, path, statements: previewStatements(graph, origin, path) };
}

async function applyPathUnderLock(
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
  const prepared = routeEdges(graph, origin, path).map((edge) => {
    const requested = edge.transition.requestedForwardBoundary;
    assertTransactionalBoundaryHonored(
      pinned.supportsTransactions || batched,
      requested
    );
    const boundary = classifyStoredAtomicity(
      command,
      requested,
      edge.transition.operations,
      edge.blob
    );
    refuseSqliteStepwise(command, requested, edge.to);
    if (batched && boundary === "stepwise") {
      refuseBatchedStepwise(pinned, edge.to);
    }
    return { ...edge, boundary };
  });

  let current = marker;
  const nextPath = marker ? [...marker.path] : [];
  // Before the program, as statements of their own: one request cannot read
  // what the bootstrap reads (plan D7), and a PostgreSQL bootstrap commits.
  if (needsBootstrap) {
    await ensureControlTables(pinned, command);
    await commitLockedTransaction(pinned, command);
  }
  const statementsOf = ({ transition, blob }: PreparedForwardEdge) =>
    stepStatements(blob, transition.operations);
  for (const group of groupContiguousAtomicity(prepared, statementsOf)) {
    if (batched) {
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
    const running: { attempt?: ForwardAttempt } = {};
    const run = async (
      producer: Parameters<typeof appendLedger>[0],
      atomic: boolean
    ) => {
      await assertLockedSinceDecision(pinned, producer, command, current);
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
      // Edge by edge, each step probed and recorded as it runs.
      for (const item of group.items) {
        const attempt = forwardAttempt(graph, item);
        await appendLedger(producer, command, attempt.event("started", "none"));
        await runForwardEdge(
          producer,
          command,
          graph,
          attempt,
          nextPath,
          models,
          true
        );
        const { snapshotHash } = item.state;
        current = await advanceMarker(
          producer,
          command,
          graph.estateHash,
          current,
          [...nextPath],
          snapshotHash,
          1,
          await proveLive(producer, command, graph, snapshotHash)
        );
        await appendLedger(
          producer,
          command,
          attempt.event("applied", "committed")
        );
      }
    };
    const phase = { committing: false, committed: false };
    const program = {
      transactional: group.boundary === "transactional",
      statements: group.items.flatMap(statementsOf),
      phase,
    };
    try {
      // On MySQL the path already runs as one sequential program (`applyV1`).
      await (command.target.dialect === "mysql"
        ? run(pinned, false)
        : runProgram(pinned, command, program, run));
    } catch (failure) {
      // Past the commit only the foreign-key restore can fail: it is reported.
      if (phase.committed) throw failure;
      if (
        phase.committing &&
        (await commitLanded(pinned, command, group.items, current, failure))
      ) {
        continue;
      }
      await recordFailedAttempt(pinned, command, running, failure);
      throw failure;
    }
  }
}

/**
 * Plan D7, refused while the path is prepared, before any of it runs: a
 * transport with no session runs only transactional groups, each as one
 * request.
 */
function refuseBatchedStepwise(
  pinned: import("../drivers/driver").AnyDriver,
  toState: Sha256
): never {
  throw new MigrationError(
    `The driver "${pinned.driverName}" sends each transactional group as one request and has no session for a stepwise transition (CONCURRENTLY, or a manual stepwise step). Nothing ran. Apply it over a session driver: viborm/pg, Neon's WebSocket Pool included.`,
    VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
    { meta: { dialect: "postgresql", toState, feature: "stepwise execution" } }
  );
}

/**
 * One forward edge, from its origin checks to its destination checks, its
 * arrival pushed onto `nextPath`; the caller proves the destination, moves
 * the marker and records the arrival. A `probed` edge runs step by step and
 * records each confirmed step; otherwise it runs inside a real transaction,
 * or one request (`batch`), whose rollback is the proof of every step.
 */
async function runForwardEdge(
  producer: Parameters<typeof appendLedger>[0],
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  attempt: ForwardAttempt,
  nextPath: MarkerPathEdgeV1[],
  models: MigrationClient["$schema"],
  probed: boolean,
  batch?: MigrationBatch
): Promise<void> {
  const { from, to, transition, state, blob, boundary } = attempt.item;
  await assertAllChecks(
    producer,
    blob,
    transition.originChecks,
    command.namespace,
    "Origin checks failed before the first dispatch",
    batch
  );
  await executeOperations(
    producer,
    blob,
    transition.operations,
    probed ? boundary : "atomic",
    probed
      ? (progress, effect, failure) =>
          appendLedger(
            producer,
            command,
            attempt.event("step-confirmed", effect, progress, failure)
          )
      : undefined,
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
  await assertAllChecks(
    producer,
    blob,
    state.destinationChecks,
    command.namespace,
    "Destination checks failed before the marker could advance",
    batch
  );
  nextPath.push({
    stateId: to,
    transitionHash: transition.transitionHash,
    baselineBoundary: false,
  });
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
    running.attempt = forwardAttempt(graph, item);
    await runForwardEdge(
      producer,
      command,
      graph,
      running.attempt,
      nextPath,
      models,
      false,
      batch
    );
    arrivals.push(running.attempt.event("applied", "committed"));
  }
  const last = items.at(-1)!;
  const { snapshotHash } = last.state;
  let next: MigrationMarkerV1;
  if (batch) {
    assertDigest(batch, command, requireStateSnapshot(graph, last.to));
    next = markerFromPath(
      graph.estateHash,
      snapshotHash,
      [...nextPath],
      (current?.revision ?? 0) + items.length
    );
    // The request asserted `current` under its lock first.
    const write = markerWrite(command, current, next);
    await producer._executeRaw(write.sql, write.params);
  } else {
    next = await advanceMarker(
      producer,
      command,
      graph.estateHash,
      current,
      [...nextPath],
      snapshotHash,
      items.length,
      await proveLive(producer, command, graph, snapshotHash)
    );
  }
  await appendLedger(producer, command, ...arrivals);
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
  const unmoved = markerUnmovedCondition(command, current);
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
    // Refused for the lock or a moved marker, the request ran none of the
    // group: a session refuses both before the attempt, recording nothing.
    const refusedBeforeGroup =
      failure instanceof MigrationError &&
      (failure.code === VibORMErrorCode.MIGRATION_LOCK_FAILED ||
        failure.code === VibORMErrorCode.MIGRATION_MARKER_CONFLICT);
    if (!refusedBeforeGroup) {
      await recordFailedAttempt(driver, command, running, failure);
    }
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
  // A batch runs only on PostgreSQL, whose driver owns the digest.
  const digest = command.catalogDigestQuery!(CONTROL_TABLES);
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
    ? readPostgresDecision(pinned, command, migrationLockFree(command)).then(
        (decision) => decision?.marker
      )
    : readControlState(pinned, command, {
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
  return marker !== null && sameMarker(marker, expected);
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
  running: { readonly attempt?: ForwardAttempt },
  failure: unknown
): Promise<void> {
  const { attempt } = running;
  if (attempt === undefined) return;
  const meta = isVibORMError(failure) ? failure.meta : {};
  const event = attempt.event(
    "failed",
    "none",
    {
      operationId:
        typeof meta.operationId === "string" ? meta.operationId : null,
      dispatchId: typeof meta.dispatchId === "string" ? meta.dispatchId : null,
    },
    describeFailure(failure)
  );
  try {
    if (runsMigrationBatches(pinned)) {
      // Its control tables were made before the request (plan D7).
      await appendLedger(pinned, command, event);
      return;
    }
    await pinned.withTransaction(async (transaction) => {
      await ensureControlTables(transaction, command);
      await appendLedger(transaction, command, event);
    });
  } catch {
    // Best effort: the caller is owed the failure itself, not this one.
  }
}

function describeFailure(failure: unknown): string {
  if (isVibORMError(failure)) return `${failure.code}: ${failure.message}`;
  return failure instanceof Error ? failure.name : "a non-error value";
}

interface PreparedForwardEdge extends RouteEdge {
  readonly boundary: "transactional" | "stepwise";
}

/** One edge's attempt: the edge, and the builder of its ledger events. */
interface ForwardAttempt extends AttemptEvents {
  readonly item: PreparedForwardEdge;
}

function forwardAttempt(
  graph: MigrationGraph,
  item: PreparedForwardEdge
): ForwardAttempt {
  return {
    item,
    ...attemptEvents({
      estateHash: graph.estateHash,
      snapshotHash: item.state.snapshotHash,
      sqlHash: item.state.sqlHash,
      fromState: item.from,
      toState: item.to,
      transitionHash: item.transition.transitionHash,
      direction: "forward",
    }),
  };
}

function previewStatements(
  graph: MigrationGraph,
  origin: Sha256 | null,
  path: readonly Sha256[]
): string[] {
  return routeEdges(graph, origin, path).flatMap(({ blob, transition }) =>
    stepStatements(blob, transition.operations)
  );
}
