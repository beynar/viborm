/**
 * The ONE pinned migration session (§3.5): one physical producer reserved for
 * a command, the lock proven on it, its loss and limits tracked, and the
 * producer condemned whenever a lock or unlock proof fails. PostgreSQL and
 * SQLite hold the lock in their transactions instead (plans D1, S5); only
 * PostgreSQL stepwise work and MySQL keep a session lock. The dialect's lock
 * and session statements come from the bound migration driver.
 */

import type { AnyDriver } from "../drivers/driver";
import { normalizeDriverError } from "../drivers/error-mapping";
import { errorCause } from "../drivers/shared/driver-options";
import {
  CLEANUP_BOUND_MS,
  leasePinnedCommand,
  type PinnedSessionControl,
  type PinnedSessionReservation,
} from "../drivers/shared/pinned-session";
import { settleWithin } from "../drivers/shared/settle";
import { withSuppressedFailure } from "../drivers/shared/suppressed-failure";
import type { TransactionOptionSupport } from "../drivers/shared/transaction-options";
import { runTransactionLifecycle } from "../drivers/shared/transactions";
import type { BatchQuery, QueryExecutionContext } from "../drivers/types";
import {
  ConnectionError,
  FeatureNotSupportedError,
  MigrationError,
  VibORMError,
  VibORMErrorCode,
} from "../errors";
import type { BoundMigrationDriver } from "./drivers";
import { providerRefused } from "./execute-dispatch";
import { liftForeignKeyPragmas, withForeignKeysLifted } from "./foreign-keys";
import {
  DEFAULT_MIGRATION_LIMITS,
  type ResolvedMigrationLimits,
} from "./limits";
import { buildsIndexConcurrently } from "./statement-safety";
import { type CatalogRead, readsCommandNamespace } from "./target";
import { createQueryExecutor } from "./utils";

/**
 * The migration lock's key, "viborm" in hex. PostgreSQL's advisory lock is
 * database-wide, so estates in one database serialize with each other; MySQL
 * names its lock after the database instead (`drivers/mysql/pinned-session.ts`).
 */
const MIGRATION_LOCK_ID = 0x76_69_62_6f_72_6d;
/**
 * The first pause between two PostgreSQL lock tries, doubled up to the cap. A
 * longer cap sends fewer tries but lets newcomers take a freed lock first: at
 * 1 s, waits under contention stretched to `lockWait`.
 */
const LOCK_RETRY_MS = 50;
const LOCK_RETRY_CAP_MS = 250;

/**
 * A condition true while no command holds the migration lock (plan D5), for a
 * decision read before the lock.
 */
export function migrationLockFree(command: BoundMigrationDriver): string {
  return command.generateLockFree(MIGRATION_LOCK_ID);
}

/**
 * Whether this driver can pin a session: the provider's `pinnedSession()`
 * hook is the capability, asked by admission before any provider work.
 */
export function canPinSession(driver: AnyDriver): boolean {
  return driver["pinnedSession"] !== undefined;
}

/**
 * Whether `driver` runs migration work with no session, one atomic request per
 * transactional group (plan D7): Neon HTTP is the shipped case.
 */
export function runsMigrationBatches(driver: AnyDriver): boolean {
  return (
    driver.dialect === "postgresql" &&
    !canPinSession(driver) &&
    driver.supportsBatch &&
    driver.supportsOrderedCommittedSegments
  );
}

/**
 * One transactional group as ONE request on a transport with no session
 * (plan D7). Statements sent to `producer` are recorded, not run; the request
 * opens with the limits and the bounded transaction lock, and what the command
 * would read inside its transaction is asserted there instead.
 */
export interface MigrationBatch {
  readonly producer: AnyDriver;
  /** `condition`, SQL with its own `$n` parameters, holds here, else `refusal` is the command's failure. */
  assert(
    condition: string,
    params: readonly unknown[],
    refusal: MigrationError
  ): void;
  /**
   * Resolves once the request committed, even when its reply was then
   * unreadable. Throws a `MigrationError` when the server refused (and rolled
   * back) the request; any other failure is a lost reply, after which the
   * request may have committed.
   */
  send(): Promise<void>;
}

/**
 * An assertion's refusal leaves its SQLSTATE (`P0V` + its position in base 36)
 * in a transaction-local setting, which this block raises: the SQLSTATE
 * survives diagnostics redaction where the message does not.
 */
const RAISE_REFUSAL = `DO $viborm$BEGIN IF current_setting('viborm.refusal') <> '' THEN RAISE EXCEPTION 'VibORM migration assertion %', current_setting('viborm.refusal') USING ERRCODE = current_setting('viborm.refusal'); END IF; END$viborm$`;
const REFUSAL = /^P0V([0-9A-Z]{2})$/;

export function openMigrationBatch(
  driver: AnyDriver,
  migrationDriver: BoundMigrationDriver
): MigrationBatch {
  const queries: BatchQuery[] = [
    { sql: postgresSessionLimits(migrationDriver.limits).transaction },
  ];
  const refusals: MigrationError[] = [];
  const producer: AnyDriver = Object.create(driver);
  Object.defineProperty(producer, "_executeRaw", {
    value: (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  });
  const batch: MigrationBatch = {
    producer,
    assert(condition, params, refusal) {
      queries.push(
        {
          sql: `SELECT set_config('viborm.refusal', CASE WHEN ${condition} THEN '' ELSE 'P0V${refusals.length.toString(36).toUpperCase().padStart(2, "0")}' END, true)`,
          params: [...params],
        },
        { sql: RAISE_REFUSAL }
      );
      refusals.push(refusal);
    },
    async send() {
      let committed = false;
      try {
        await driver._executeBatch(queries, undefined, undefined, () => {
          committed = true;
          return Promise.resolve();
        });
      } catch (failure) {
        if (committed) return;
        if (!providerRefused(failure)) throw failure;
        const position = REFUSAL.exec(String(failure.meta.providerSqlState));
        const refusal = position && refusals[Number.parseInt(position[1]!, 36)];
        if (refusal) throw refusal;
        throw new MigrationError(
          "The server refused the migration request, which rolled back: nothing of it was applied.",
          VibORMErrorCode.MIGRATION_FAILED,
          {
            cause: failure,
            meta: { providerSqlState: failure.meta.providerSqlState },
          }
        );
      }
    },
  };
  batch.assert(
    `(SELECT acquired FROM (${migrationDriver.generateAcquireLock(MIGRATION_LOCK_ID)}) AS lock)`,
    [],
    lockNotConfirmed(migrationDriver)
  );
  return batch;
}

/**
 * What a pinned session runs under besides its body (plan S1): the bound on
 * its reservation, the PostgreSQL command's limits, and, for a driver whose
 * one connection IS the session (SQLite), that session.
 */
export interface PinnedSessionScope {
  readonly connectionWait: number;
  readonly limits?: PostgresSessionLimits | undefined;
  readonly session?: () => Promise<PinnedSessionReservation<unknown>>;
}

/** The statements that impose, lift and reset one PostgreSQL session's limits. */
interface PostgresSessionLimits {
  readonly enter: string;
  readonly exit: string;
  readonly transaction: string;
  readonly unbound: string;
  readonly rebound: string;
}

const DEFAULT_SCOPE: PinnedSessionScope = {
  connectionWait: DEFAULT_MIGRATION_LIMITS.connectionWait,
};

/**
 * Runs `body` against ONE reserved producer: this driver with its client
 * pinned to the reservation, so every statement, transactions included, runs
 * on one physical session (§3.5).
 *
 * The producer is discarded rather than released when the body throws or
 * condemns it; a LOST session is never written to again, and its failure
 * surfaces as the retryable connection error it is (plan S2).
 */
export async function withPinnedSession<D extends AnyDriver, T>(
  driver: D,
  body: (pinned: D, control: SessionControl) => Promise<T>,
  scope: PinnedSessionScope = DEFAULT_SCOPE
): Promise<T> {
  const reserve = scope.session ?? driver["pinnedSession"];
  if (reserve === undefined) {
    // A custom driver with no hook, or a view that IS a reserved session
    // (`createPinnedSessionView` withdraws the hook); admission refuses the
    // shipped paths earlier.
    throw new FeatureNotSupportedError(
      driver.driverName,
      "pinnedSession",
      "No session can be reserved through this driver: either the transport has no interactive session at all, or this view is itself one reserved session and reserving again would take a SECOND connection. A migration lock is session-scoped, so either way it could be released by a different connection — or never released at all."
    );
  }

  const runSession = async (): Promise<T> => {
    // A server that accepts the socket and never answers is bounded here.
    const reservation = await settleWithin(
      reserve.call(driver),
      scope.connectionWait,
      () => connectionWaitError(driver.driverName, scope.connectionWait),
      (late) => {
        late.release(true).catch(() => undefined);
      }
    );
    const control = controlSession(driver, reservation);
    const { limits } = scope;
    const view = createPinnedSessionView(
      driver,
      reservation.session,
      control,
      limits
    );

    // Converted only when the failure IS the loss: a failure the command hit
    // first, whose cleanup then went unanswered, stays primary.
    const surface = (failure: unknown): unknown =>
      control.lost(failure, true)
        ? connectionLostError(driver.driverName, failure)
        : failure;

    // Limits a stepwise program set on the session must not go back to the
    // pool; a failed reset is RETURNED, so the release after it always runs.
    const resetLimits = async (): Promise<unknown> => {
      if (limits === undefined || !control.limited() || control.lost()) {
        return undefined;
      }
      try {
        await control.cleanup(() => view._executeRaw(limits.exit));
        return undefined;
      } catch (resetFailure) {
        control.abandon();
        return resetFailure;
      }
    };

    // The first failure stays primary; later ones are recorded beside it.
    const releaseAfter = async (
      surfaced: unknown,
      resetFailure: unknown
    ): Promise<unknown> => {
      let failure =
        resetFailure === undefined
          ? surfaced
          : withSuppressedFailure(surfaced, resetFailure);
      try {
        await reservation.release(true, control.lost());
      } catch (releaseFailure) {
        failure = withSuppressedFailure(failure, releaseFailure);
      }
      return failure;
    };

    let value: T;
    try {
      value = await body(view, control);
    } catch (bodyFailure) {
      // Surfaced first: it is what tells the reset the session is lost.
      throw await releaseAfter(surface(bodyFailure), await resetLimits());
    }
    const resetFailure = await resetLimits();
    if (resetFailure !== undefined) {
      throw await releaseAfter(surface(resetFailure), undefined);
    }
    // Nothing else failed, so a release failure IS the failure.
    await reservation.release(control.discarded(), false);
    return value;
  };

  // A dedicated connection needs no lease: the real lock arbitrates.
  if (!driver["serializeTransactions"]) {
    return runSession();
  }
  // A single-connection driver runs the whole session as ONE job of its queue
  // (§3.5): a narrower lease lets a second command in, and a PostgreSQL
  // session advisory lock is reentrant. A transaction-bound caller is refused
  // before the lease rather than waiting on its own holder.
  driver["assertBaseOperationAllowedDuringTransaction"](
    driver["resolveExecutionContext"](undefined, "pinnedSession")
  );
  const queue = driver["connectionQueue"];
  const identify = driver["physicalPinnedSession"];
  if (identify === undefined) {
    return queue.enqueue(runSession);
  }
  // The physical lease keeps ANOTHER driver over the same client out, and
  // refuses one whose advisory-lock state was condemned.
  const session = await identify.call(driver);
  return leasePinnedCommand(driver.driverName, session, () =>
    queue.enqueue(runSession)
  );
}

/** The control of one reserved session, and what it knows about its connection. */
interface SessionControl extends PinnedSessionControl {
  discarded(): boolean;
  lost(failure?: unknown, reported?: boolean): boolean;
  /** Sends nothing more on this session, whose state can no longer be made clean. */
  abandon(): void;
  /** Records that the session itself now carries the command's limits. */
  limit(): void;
  /** Whether the session carries them, and so must be reset before it goes back. */
  limited(): boolean;
}

function controlSession(
  driver: AnyDriver,
  reservation: PinnedSessionReservation<unknown>
): SessionControl {
  let discarded = false;
  let lost = false;
  let limited = false;
  const control = {
    discard: () => {
      discarded = true;
    },
    discarded: () => discarded,
    abandon: () => {
      lost = true;
    },
    limit: () => {
      limited = true;
    },
    limited: () => limited,
    /** With `reported`, whether `failure` itself reports the loss. */
    lost: (failure?: unknown, reported = false) => {
      const reports =
        reservation.lost?.() !== undefined ||
        reportsLostConnection(driver, failure);
      lost ||= reports;
      return reported ? reports : lost;
    },
    cleanup: <R>(run: () => Promise<R>) =>
      settleWithin(run(), CLEANUP_BOUND_MS, () => {
        lost = true;
        return new ConnectionError(
          `A cleanup statement of the pinned migration session on driver "${driver.driverName}" went unanswered for ${CLEANUP_BOUND_MS} ms; its connection is treated as lost.`,
          {
            code: VibORMErrorCode.CONNECTION_TIMEOUT,
            meta: { driver: driver.driverName, operation: "pinnedSession" },
          }
        );
      }),
  };
  return control;
}

/**
 * Whether `failure`, or anything it was caused by, is the provider reporting
 * that the connection itself failed, by the driver error mapping's one
 * classifier.
 */
function reportsLostConnection(driver: AnyDriver, failure: unknown): boolean {
  let link: unknown = failure;
  for (let depth = 0; depth < 8 && link instanceof Error; depth += 1) {
    const normalized =
      link instanceof VibORMError
        ? link
        : normalizeDriverError(link, {
            driverName: driver.driverName,
            dialect: driver.dialect,
          });
    if (normalized instanceof ConnectionError) return true;
    link = link.cause;
  }
  return false;
}

/**
 * The failure a command on a lost session surfaces: the provider's own report
 * when it already is a connection error or a migration outcome, otherwise a
 * retryable connection error carrying it (pg reports a dead socket as an
 * ordinary query failure).
 */
function connectionLostError(driverName: string, failure: unknown): unknown {
  if (failure instanceof ConnectionError || failure instanceof MigrationError) {
    return failure;
  }
  return new ConnectionError(
    `The connection of the pinned migration session on driver "${driverName}" was lost. VibORM sent nothing more on it: the server rolls back its open transaction and frees its migration lock when that session ends. Run the command again; it re-reads the marker under the lock.`,
    {
      code: VibORMErrorCode.CONNECTION_FAILED,
      cause: errorCause(failure),
      meta: { driver: driverName, operation: "pinnedSession" },
    }
  );
}

function connectionWaitError(driverName: string, ms: number): ConnectionError {
  return new ConnectionError(
    `Driver "${driverName}" got no connection for the migration session within ${ms} ms (connectionWait). Nothing was sent; the command can be retried.`,
    {
      code: VibORMErrorCode.CONNECTION_TIMEOUT,
      meta: { driver: driverName, operation: "pinnedSession" },
    }
  );
}

/**
 * This driver, viewed with its client pinned to one reserved session: the
 * same driver in every other respect, with the transport assertion forwarded
 * exactly. Every statement it sends records a lost connection (plan S2).
 */
function createPinnedSessionView<D extends AnyDriver>(
  driver: D,
  session: unknown,
  control: PinnedSessionControl,
  limits: PostgresSessionLimits | undefined
): D {
  const view: D = Object.create(driver);
  const support = driver["transactionOptionSupport"]();
  const executeRaw = driver["executeRaw"];
  const beforeForeignKeysOff = driver["beforeForeignKeysOff"];
  Object.defineProperties(view, {
    client: { value: session, writable: true },
    // A pinned view must never start a second connection.
    initPromise: { value: null, writable: true },
    // The view IS the queue's serialized job: waiting on the queue would wait
    // for its own holder.
    serializeTransactions: { value: false },
    // The view is the reservation, so it has none to give (§3.5): a nested
    // lock refuses instead of taking a second connection.
    pinnedSession: { value: undefined },
    // The provider's own `transaction()` acquires a connection.
    transaction: {
      value(
        this: AnyDriver,
        pinned: unknown,
        fn: (tx: unknown) => Promise<unknown>,
        context?: QueryExecutionContext
      ) {
        return runPinnedTransaction(this, pinned, fn, context, control, limits);
      },
    },
    executeRaw: {
      async value(
        this: AnyDriver,
        client: unknown,
        sql: string,
        params: unknown[] | undefined,
        context?: QueryExecutionContext
      ) {
        // Nothing more is sent on a lost connection (plan S2).
        if (control.lost())
          throw connectionLostError(driver.driverName, undefined);
        const locked = LOCKED.get(this);
        await locked?.before(sql);
        // A `CONCURRENTLY` index statement runs without the session's limits,
        // which would cut it short and leave an INVALID index (plan S1).
        const run = async () => {
          try {
            if (limits === undefined || !buildsIndexConcurrently(sql)) {
              return await executeRaw.call(this, client, sql, params, context);
            }
            await executeRaw.call(
              this,
              client,
              limits.unbound,
              undefined,
              context
            );
            const result = await executeRaw.call(
              this,
              client,
              sql,
              params,
              context
            );
            await executeRaw.call(
              this,
              client,
              limits.rebound,
              undefined,
              context
            );
            return result;
          } catch (failure) {
            control.lost(failure);
            throw failure;
          }
        };
        return locked === undefined
          ? run()
          : run().catch((failure: unknown) => locked.failed(failure));
      },
    },
    // The lease holds the queue for the whole session, so there is no queue
    // wait left to bound.
    transactionOptionSupport: {
      value: (): TransactionOptionSupport =>
        support.maxWait === "queue"
          ? {
              ...support,
              maxWait: "unsupported",
              maxWaitReason:
                "the pinned session holds the connection queue's lease for its whole duration, so there is no queue wait to bound",
            }
          : support,
    },
    migrationNamespaceAttestation: {
      value: driver.migrationNamespaceAttestation,
    },
    // The hook runs outside any transaction: a SQLite command's locked
    // transaction ends before it.
    beforeForeignKeysOff: {
      async value(this: AnyDriver) {
        await LOCKED.get(this)?.between();
        await beforeForeignKeysOff?.call(this);
      },
    },
  });
  return view;
}

/**
 * One transaction on the already-reserved session, as `BEGIN`/`COMMIT`/
 * `ROLLBACK` on that producer: under a lock the session already holds
 * (MySQL's, or a PostgreSQL stepwise program's), opening with the PostgreSQL
 * limits (plan S1), and sending no `ROLLBACK` after a lost connection (S2).
 */
function runPinnedTransaction<T>(
  view: AnyDriver,
  session: unknown,
  fn: (tx: unknown) => Promise<T>,
  context: QueryExecutionContext | undefined,
  control: PinnedSessionControl,
  limits: PostgresSessionLimits | undefined
): Promise<T> {
  const locked = LOCKED.get(view)?.group(() => fn(session));
  if (locked !== undefined) return locked;
  const statement = (sql: string) =>
    view["executeRaw"](session, sql, undefined, context);
  return runTransactionLifecycle({
    begin: () => statement("BEGIN"),
    // The session IS the transaction: a nested `$transaction` is a SAVEPOINT.
    callback: async () => {
      if (limits !== undefined) await statement(limits.transaction);
      return fn(session);
    },
    commit: () => statement("COMMIT"),
    rollback: () =>
      control.lost() ? undefined : control.cleanup(() => statement("ROLLBACK")),
  });
}

/**
 * Runs `body` on ONE reserved producer holding this estate's migration lock,
 * with the migration driver THIS command renders from (§5.2).
 *
 * MySQL holds a session lock for the whole command; PostgreSQL and SQLite run
 * it in locked transactions ({@link lockTransactions}); a batch transport
 * locks each request (plan D7). `unlocked` (PostgreSQL) runs first, before any
 * lock, for a decision one statement proves while no command holds the lock
 * (plan D5); a failure that is not the lost connection only means it could not
 * decide.
 */
export function withLockedMigrationProducer<T>(
  driver: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  body: (pinned: AnyDriver, command: BoundMigrationDriver) => Promise<T>,
  unlocked?: (session: AnyDriver, lockFree: string) => Promise<T | undefined>
): Promise<T> {
  const { dialect } = migrationDriver.target;
  const limits = migrationDriver.limits;
  const lockFree = migrationLockFree(migrationDriver);
  const scope: PinnedSessionScope = {
    connectionWait: limits.connectionWait,
    limits:
      dialect === "postgresql" ? postgresSessionLimits(limits) : undefined,
    session:
      dialect === "sqlite"
        ? async () => ({
            session: await driver["getClient"]({ operation: "pinnedSession" }),
            release: () => Promise.resolve(),
          })
        : undefined,
  };
  if (runsMigrationBatches(driver)) {
    return (async () => {
      const answer = await unlocked?.(driver, lockFree).catch(() => undefined);
      if (answer !== undefined) return answer;
      return body(
        driver,
        await validateAndSelectMigrationTarget(driver, migrationDriver)
      );
    })();
  }
  if (dialect === "mysql") {
    return withPinnedSession(
      driver,
      async (pinned, control) => {
        // A lock never proven is not this session's to release (§3.5).
        await acquireLock(pinned, migrationDriver, control);
        let result: T;
        try {
          const command = await validateAndSelectMigrationTarget(
            pinned,
            migrationDriver
          );
          result = await body(pinned, command);
        } catch (error) {
          await releaseAfterFailure(pinned, migrationDriver, control, error);
          throw error;
        }
        await releaseLock(pinned, migrationDriver, control);
        return result;
      },
      scope
    );
  }
  return withPinnedSession(
    driver,
    async (pinned, control) => {
      try {
        const answer = await unlocked?.(pinned, lockFree);
        if (answer !== undefined) return answer;
      } catch (failure) {
        if (control.lost(failure)) throw failure;
      }
      // An admitted SQLite driver without transactions runs under the
      // driver's queue lease alone.
      if (!pinned.supportsTransactions) {
        return body(
          pinned,
          await validateAndSelectMigrationTarget(pinned, migrationDriver)
        );
      }
      const locked = lockTransactions(
        pinned,
        migrationDriver,
        control,
        scope.limits
      );
      LOCKED.set(pinned, locked);
      let result: T;
      try {
        const command = await validateAndSelectMigrationTarget(
          pinned,
          migrationDriver
        );
        result = await body(pinned, command);
      } catch (error) {
        await locked.abort(error);
        throw error;
      }
      await locked.finish();
      return result;
    },
    scope
  );
}

/**
 * The locked transactions one PostgreSQL or SQLite command runs in (plans D1,
 * S5), opened on demand before each statement: PostgreSQL `BEGIN`, its limits
 * and the bounded transaction lock; SQLite `BEGIN IMMEDIATE`. The first opens
 * before the namespace proof, so every decision is read under the lock.
 *
 * PostgreSQL stepwise work and `CONCURRENTLY` statements take the session lock
 * inside the open locked transaction, so the lock is never let go between the
 * decision and the work. SQLite's `PRAGMA foreign_keys` switch runs between
 * two transactions. A commit without the session lock lets the lock go, and
 * {@link lockedSinceDecision} is then false.
 */
interface LockedTransactions {
  /** Readies the session for one statement sent outside a group. */
  before(sql: string): Promise<void>;
  /** Ends what one statement's failure ended, then rethrows it. */
  failed(failure: unknown): Promise<never>;
  /** Runs one transactional group, or `undefined` once the session lock holds. */
  group<T>(fn: () => Promise<T>): Promise<T> | undefined;
  /** Marks the work about to run as stepwise (PostgreSQL). */
  stepwise(): void;
  /** Ends the open locked transaction: SQLite's pragma, a PostgreSQL bootstrap. */
  between(): Promise<void>;
  /** Whether the lock has been held without a gap since the first read. */
  continuous(): boolean;
  /** Ends a command that succeeded: commits, then releases the session lock. */
  finish(): Promise<void>;
  /** Ends a command that failed: rolls back, releases, never replaces `cause`. */
  abort(cause: unknown): Promise<void>;
}

const LOCKED = new WeakMap<object, LockedTransactions>();

/** The switch SQLite ignores inside a transaction; its read form runs anywhere. */
const FOREIGN_KEYS_SWITCH = /^\s*PRAGMA\s+foreign_keys\s*=/i;

function lockTransactions(
  pinned: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  control: SessionControl,
  limits: PostgresSessionLimits | undefined
): LockedTransactions {
  const sqlite = migrationDriver.target.dialect === "sqlite";
  // The protocol's own statements, on the same session, past `before`.
  const direct: AnyDriver = Object.create(pinned);
  const run = <T = Record<string, unknown>>(sql: string) =>
    direct._executeRaw<T>(sql);
  let open = false;
  let sessionLocked = false;
  let armed = false;
  let continuous = true;
  let grouped = false;

  const rollback = async (): Promise<void> => {
    if (!open) return;
    open = false;
    continuous &&= sessionLocked;
    if (control.lost()) return;
    await control.cleanup(() => run("ROLLBACK"));
  };
  const commit = async (): Promise<void> => {
    await run("COMMIT");
    open = false;
    continuous &&= sessionLocked;
  };
  // SQLite's lock IS its BEGIN IMMEDIATE: `lockWait` bounds that one
  // statement's busy wait, then the connection's own timeout is restored.
  const beginImmediate = async (): Promise<void> => {
    const [own] = (await run<{ timeout: unknown }>("PRAGMA busy_timeout")).rows;
    await run(`PRAGMA busy_timeout = ${migrationDriver.limits.lockWait}`);
    try {
      await run("BEGIN IMMEDIATE");
    } finally {
      // Interpolated, so only an integer is written back.
      if (Number.isInteger(own?.timeout)) {
        await run(`PRAGMA busy_timeout = ${own?.timeout}`);
      }
    }
  };
  // A PostgreSQL transaction takes its limits and tries the lock in one
  // statement. A refused try waits outside any transaction, so the wait holds
  // no snapshot: another command's `CREATE INDEX CONCURRENTLY` under the
  // session lock would otherwise wait for this one to give up. Each jittered
  // pause doubles up to the cap and ends in one autocommit try, which lets go
  // of what it takes, until the lock is free or `lockWait` is spent.
  const lockFree = `${migrationLockFree(migrationDriver)} AS acquired`;
  const tryLock = sqlite ? null : `SELECT ${lockFree}`;
  const enter =
    limits === undefined ? tryLock : `${limits.transaction}, ${lockFree}`;
  const begin = async (): Promise<void> => {
    const deadline = Date.now() + migrationDriver.limits.lockWait;
    let pause = LOCK_RETRY_MS;
    for (;;) {
      try {
        await (sqlite ? beginImmediate() : run("BEGIN"));
      } catch (error) {
        // SQLite's lock IS its BEGIN IMMEDIATE: a busy database is a lock wait.
        if (!sqlite || control.lost(error)) throw error;
        throw lockStatementFailed(migrationDriver, error);
      }
      open = true;
      let held: boolean;
      try {
        held = await lockHeld(direct, migrationDriver, control, enter);
      } catch (error) {
        await rollback().catch((cleanup: unknown) => {
          throw withSuppressedFailure(error, cleanup);
        });
        throw error;
      }
      if (held) return;
      // Nothing was read under a lock never held: not a gap in `continuous`.
      open = false;
      await control.cleanup(() => run("ROLLBACK"));
      do {
        const left = deadline - Date.now();
        if (left <= 0) throw lockNotConfirmed(migrationDriver);
        const jittered = pause * (0.5 + Math.random() / 2);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(left, jittered))
        );
        pause = Math.min(pause * 2, LOCK_RETRY_CAP_MS);
      } while (!(await lockHeld(direct, migrationDriver, control, tryLock)));
    }
  };
  const escalate = async (): Promise<void> => {
    if (!open) await begin();
    await acquireLock(
      direct,
      migrationDriver,
      control,
      migrationDriver.generateSessionLock(MIGRATION_LOCK_ID)
    );
    sessionLocked = true;
    armed = false;
    if (limits !== undefined) {
      await run(limits.enter);
      control.limit();
    }
    await commit();
  };

  const between = async (): Promise<void> => {
    if (open) await commit();
  };
  const abort = async (cause: unknown): Promise<void> => {
    // A failure that IS the lost connection: nothing more is sent (plan S2).
    control.lost(cause);
    try {
      await rollback();
    } catch (cleanup) {
      throw withSuppressedFailure(cause, cleanup);
    }
    if (sessionLocked) {
      await releaseAfterFailure(direct, migrationDriver, control, cause);
    }
  };

  return {
    async failed(failure) {
      if (!(sqlite || grouped || control.lost(failure))) {
        await rollback().catch((cleanup: unknown) => {
          throw withSuppressedFailure(failure, cleanup);
        });
      }
      throw failure;
    },
    async before(sql) {
      if (grouped || sessionLocked) return;
      if (sqlite && FOREIGN_KEYS_SWITCH.test(sql)) {
        await between();
        return;
      }
      if (!sqlite && (armed || buildsIndexConcurrently(sql))) {
        await escalate();
        return;
      }
      if (!open) await begin();
    },
    group(fn) {
      if (sessionLocked) return undefined;
      return runTransactionLifecycle({
        begin: () => (open ? undefined : begin()),
        callback: async () => {
          grouped = true;
          try {
            return await fn();
          } finally {
            grouped = false;
          }
        },
        commit,
        rollback,
      });
    },
    stepwise() {
      armed = true;
    },
    between,
    continuous: () => continuous,
    async finish() {
      if (open) {
        try {
          await commit();
        } catch (failure) {
          await abort(failure);
          throw failure;
        }
      }
      if (sessionLocked) await releaseLock(direct, migrationDriver, control);
    },
    abort,
  };
}

/**
 * Commits a PostgreSQL command's open locked transaction. The next statement
 * opens another, and {@link lockedSinceDecision} is then false. Called:
 *
 * - after a bootstrap, before any statement writes the control tables:
 *   PlanetScale's Neki plans a statement against the schema committed before
 *   its transaction, so a control table created in the same one is not there
 *   for it. SQLite writes them in the transaction that made them; MySQL
 *   commits each DDL as it runs;
 * - before the caller's own work, such as a `resolve` callback, which no
 *   transaction waits on: past `idleTimeout` the server ends the session.
 */
export async function commitLockedTransaction(
  pinned: AnyDriver,
  command: BoundMigrationDriver
): Promise<void> {
  if (command.target.dialect === "postgresql") {
    await LOCKED.get(pinned)?.between();
  }
}

/**
 * Whether `producer`'s command has held its migration lock without a gap since
 * it read its decision; always true on MySQL, which holds a session lock.
 */
export function lockedSinceDecision(producer: AnyDriver): boolean {
  return LOCKED.get(producer)?.continuous() ?? true;
}

/**
 * The PostgreSQL statements behind one command's time limits (plan S1).
 *
 * Every migration transaction opens with its own `SET LOCAL` limits, which
 * leave with it (plan D1); the session carries them only while stepwise work
 * holds the session lock, and is reset to each setting's `reset_val` before it
 * goes back. The idle limits are set only where `pg_settings` lists them, and
 * never on PGlite, whose in-process backend hangs on either idle timer.
 */
function postgresSessionLimits(
  limits: ResolvedMigrationLimits
): PostgresSessionLimits {
  const bound = (lock: number, statement: number, local: boolean) =>
    `set_config('lock_timeout', '${lock}', ${local}), set_config('statement_timeout', '${statement}', ${local})`;
  const { lockTimeout, statementTimeout } = limits;
  return {
    enter: `DO $viborm_limits$BEGIN
PERFORM ${bound(lockTimeout, statementTimeout, false)};
IF pg_catalog.version() NOT LIKE '%emscripten%' THEN
PERFORM set_config(name, '${limits.idleTimeout}', false) FROM pg_catalog.pg_settings WHERE name IN ('idle_in_transaction_session_timeout', 'idle_session_timeout');
BEGIN
PERFORM set_config(name, '1000', false) FROM pg_catalog.pg_settings WHERE name = 'client_connection_check_interval';
EXCEPTION WHEN invalid_parameter_value THEN NULL;
END;
END IF;
END$viborm_limits$`,
    exit: "SELECT count(set_config(name, reset_val, false)) AS reset FROM pg_catalog.pg_settings WHERE name IN ('lock_timeout', 'statement_timeout', 'idle_in_transaction_session_timeout', 'idle_session_timeout', 'client_connection_check_interval')",
    // Repeated in each transaction under the session lock too: a migration's
    // own SQL may change the session's values.
    transaction: `SELECT ${bound(lockTimeout, statementTimeout, true)}, set_config('idle_in_transaction_session_timeout', CASE WHEN pg_catalog.version() LIKE '%emscripten%' THEN pg_catalog.current_setting('idle_in_transaction_session_timeout') ELSE '${limits.idleTimeout}' END, true)`,
    unbound: `SELECT ${bound(0, 0, false)}`,
    rebound: `SELECT ${bound(lockTimeout, statementTimeout, false)}`,
  };
}

/**
 * Selects the live migration target on a pinned producer, if this dialect has
 * one: when the lock is taken and again before every relative artifact, since
 * a manual artifact may issue its own `USE` (§10).
 */
export async function selectMigrationTarget(
  pinned: AnyDriver,
  migrationDriver: BoundMigrationDriver
): Promise<void> {
  const statement = migrationDriver.generateSelectTarget();
  if (statement === null) {
    return;
  }
  await pinned._executeRaw(statement);
}

/**
 * §5.3's step 2, once per locked session: the namespace proof (§3.3), the
 * target selection, then the dialect's own proof of the session.
 */
async function validateAndSelectMigrationTarget(
  pinned: AnyDriver,
  migrationDriver: BoundMigrationDriver
): Promise<BoundMigrationDriver> {
  const command = await resolveCommandDriver(pinned, migrationDriver);
  await selectMigrationTarget(pinned, command);
  return command.proveSession((sql, params) => pinned._executeRaw(sql, params));
}

/**
 * The ONE owner of the migration driver a command renders from, after its
 * namespace proof (§5.2): on the dialect that resolves a command-local
 * spelling (MySQL), a frozen view carrying the server's own spelling, which
 * lives exactly as long as the command. Read-only commands reach it too.
 */
export async function resolveCommandDriver(
  producer: AnyDriver,
  migrationDriver: BoundMigrationDriver
): Promise<BoundMigrationDriver> {
  const read: CatalogRead = (sql, params) => producer._executeRaw(sql, params);
  if (!readsCommandNamespace(migrationDriver)) {
    await migrationDriver.proveNamespaceExists(read);
    return migrationDriver;
  }

  const spelling = await migrationDriver.resolveCommandNamespace(read);
  const command: BoundMigrationDriver = Object.create(migrationDriver);
  Object.defineProperty(command, "namespace", {
    value: spelling,
    enumerable: true,
  });
  Object.freeze(command);
  return command;
}

/**
 * Whether a group of `transactional` work runs in a transaction on this
 * producer: never on MySQL, nor without transactions. Asked of each group
 * right before it runs, which is where a PostgreSQL command hears of stepwise
 * work and takes the session lock it needs (plan D1).
 */
export function mayWrapTransaction(
  producer: Pick<AnyDriver, "supportsTransactions">,
  dialect: string,
  transactional: boolean
): boolean {
  if (!transactional) LOCKED.get(producer)?.stepwise();
  return transactional && dialect !== "mysql" && producer.supportsTransactions;
}

/**
 * Runs one program of a command, the one owner of how it runs: on MySQL as a
 * sequential program; else, given its `program`, in a transaction where
 * {@link mayWrapTransaction} admits one, SQLite's foreign-key pragmas lifted
 * around it (a recreation is refused where nothing can lift them), and
 * directly otherwise; without one, directly. `atomic` tells the body which.
 * `phase` records how far a transaction got: past its body and checks
 * (`committing`), past its COMMIT (`committed`), for a caller that classifies
 * a failure at COMMIT (plan S3).
 */
export async function runProgram<T>(
  pinned: AnyDriver,
  command: BoundMigrationDriver,
  program:
    | {
        readonly transactional: boolean;
        readonly statements: string[];
        readonly phase?: { committing: boolean; committed: boolean };
      }
    | undefined,
  body: (producer: AnyDriver, atomic: boolean) => Promise<T>
): Promise<T> {
  const { dialect } = command.target;
  if (dialect === "mysql") {
    return runSequentialProgram(pinned, command, (producer) =>
      body(producer, false)
    );
  }
  if (!program) return body(pinned, false);
  const { bracket } = liftForeignKeyPragmas(pinned, program.statements);
  if (!mayWrapTransaction(pinned, dialect, program.transactional)) {
    return body(pinned, false);
  }
  const { phase } = program;
  return withForeignKeysLifted(pinned, bracket, async (inside) => {
    const result = await pinned.withTransaction(async (transaction) => {
      const value = await inside(transaction, (producer) =>
        body(producer, true)
      );
      if (phase) phase.committing = true;
      return value;
    });
    if (phase) phase.committed = true;
    return result;
  });
}

/**
 * Runs a MySQL sequential program on `producer`, after the command's
 * `programPreamble`, and reports the boundary it reached (§6.2, §6.3): MySQL
 * commits DDL as each statement runs, so a failure part-way through is the
 * partial commit it is, recorded by the producer the body runs on.
 */
export async function runSequentialProgram<T>(
  producer: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  body: (recording: AnyDriver) => Promise<T>
): Promise<T> {
  const preamble = await migrationDriver.programPreamble(producer);
  /** The last statement that RAN TO COMPLETION, which here IS committed. */
  let committed: string | undefined;
  const recording: AnyDriver = Object.create(producer);
  Object.defineProperty(recording, "_executeRaw", {
    value: async (sql: string, params?: unknown[]) => {
      const result = await producer._executeRaw(sql, params);
      committed = sql;
      return result;
    },
  });

  try {
    for (const statement of preamble) {
      await recording._executeRaw(statement);
    }
    return await body(recording);
  } catch (cause) {
    throw partialProgramFailure(cause, committed);
  }
}

/**
 * The honest report for a program that cannot be undone (§6.2, §6.3): the
 * last statement known to have completed, no claim of a rollback, and the
 * provider's failure as the cause.
 */
function partialProgramFailure(
  cause: unknown,
  committed: string | undefined
): MigrationError {
  const boundary =
    committed ?? "(none — the failure came before any statement completed)";
  return new MigrationError(
    "This migration program failed partway through. MySQL commits DDL as each statement runs, so NOTHING was rolled back: every statement that completed stands, and VibORM makes no claim about whether the statement that failed took effect. " +
      `The last statement that completed was: ${boundary}. ` +
      "Estate artifacts and the control plane were not rewritten as a successful apply — fix the cause and re-run.",
    VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
    { cause: errorCause(cause) }
  );
}

/**
 * Acquires the lock and PROVES it. The target is selected after the lock
 * (§5.3), by the caller's scope that releases.
 */
async function acquireLock(
  pinned: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  control: PinnedSessionControl,
  statement = migrationDriver.generateAcquireLock(MIGRATION_LOCK_ID)
): Promise<void> {
  if (!(await lockHeld(pinned, migrationDriver, control, statement))) {
    throw lockNotConfirmed(migrationDriver);
  }
}

/** Runs one lock statement: whether the provider proved the lock held. */
async function lockHeld(
  pinned: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  control: PinnedSessionControl,
  statement: string | null
): Promise<boolean> {
  if (statement === null) {
    return true;
  }

  const executor = createQueryExecutor(pinned);
  let rows: unknown[];
  try {
    rows = await executor(statement);
  } catch (error) {
    // A lost connection is retryable, not a lock failure.
    if (control.lost(error)) throw error;
    throw lockStatementFailed(migrationDriver, error);
  }
  return migrationDriver.provesLockAcquired(rows);
}

function lockNotConfirmed(
  migrationDriver: BoundMigrationDriver
): MigrationError {
  return new MigrationError(
    `Failed to acquire the migration lock for ${describeEstate(migrationDriver)}: the provider did not confirm the lock. ` +
      "A wait that timed out, an error, or a malformed answer all mean the lock is NOT held; VibORM will not run migration work on that assumption.",
    VibORMErrorCode.MIGRATION_LOCK_FAILED
  );
}

function lockStatementFailed(
  migrationDriver: BoundMigrationDriver,
  error: unknown
): MigrationError {
  return new MigrationError(
    `Failed to acquire the migration lock for ${describeEstate(migrationDriver)}: the lock statement itself failed.`,
    VibORMErrorCode.MIGRATION_LOCK_FAILED,
    { cause: errorCause(error) }
  );
}

/**
 * Releases the lock after the protected work FAILED: the release still runs
 * and its own failure is recorded beside `cause` (§3.5), never replacing it.
 * A lost session holds no lock to release (plan S2).
 */
async function releaseAfterFailure(
  pinned: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  control: PinnedSessionControl,
  cause: unknown
): Promise<void> {
  if (control.lost(cause)) return;
  try {
    await releaseLock(pinned, migrationDriver, control);
  } catch (releaseFailure) {
    throw withSuppressedFailure(cause, releaseFailure);
  }
}

/**
 * Releases the lock and PROVES the release, through the driver the command
 * was GIVEN (only it names the lock acquired); an unproven release condemns
 * the producer.
 */
async function releaseLock(
  pinned: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  control: PinnedSessionControl
): Promise<void> {
  const statement = migrationDriver.generateReleaseLock(MIGRATION_LOCK_ID);
  if (statement === null) {
    return;
  }

  const executor = createQueryExecutor(pinned);
  let rows: unknown[];
  try {
    rows = await control.cleanup(() => executor(statement));
  } catch (error) {
    control.discard();
    if (control.lost(error)) throw error;
    throw new MigrationError(
      `Failed to release the migration lock for ${describeEstate(migrationDriver)}. The pinned session was discarded rather than returned to the pool.`,
      VibORMErrorCode.MIGRATION_LOCK_FAILED,
      { cause: errorCause(error) }
    );
  }

  if (!migrationDriver.provesLockReleased(rows)) {
    control.discard();
    throw new MigrationError(
      `Failed to release the migration lock for ${describeEstate(migrationDriver)}: the provider did not confirm the release. The pinned session was discarded rather than returned to the pool, so the lock cannot outlive the connection.`,
      VibORMErrorCode.MIGRATION_LOCK_FAILED
    );
  }
}

/** The estate a lock failure is about. */
function describeEstate(migrationDriver: BoundMigrationDriver): string {
  const { target } = migrationDriver;
  if (target.dialect === "sqlite") return "the SQLite database";
  return target.dialect === "postgresql"
    ? `schema "${target.namespace}"`
    : `database "${migrationDriver.namespace ?? "(unbound)"}"`;
}
