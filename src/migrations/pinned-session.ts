/**
 * The ONE pinned migration session.
 *
 * PostgreSQL advisory locks and MySQL named locks are SESSION-scoped. The
 * previous owner acquired through one pooled connection, ran the protected work
 * through others, and released through another: that protects nothing, and a
 * release issued on a connection that never held the lock strands it on the one
 * that did. §3.5's requirement is one physical producer across every decision
 * and commit boundary, so this module reserves that producer, proves the lock,
 * hands the callback that exact producer, and proves the unlock — condemning
 * the producer whenever either proof fails.
 *
 * The lock statement and the namespace proof are the only provider operations
 * allowed before the authoritative under-lock marker and ledger read, and both
 * are non-durable: a target mismatch after acquisition unlocks and leaves zero
 * tracking, DDL, artifact or snapshot effects behind.
 *
 * Two facts about that producer live here with it, because both are answers no
 * command may source twice: the driver a command RENDERS from
 * ({@link resolveCommandDriver}, which read-only commands reach without a
 * lock), and the commit boundary a program reached when the dialect commits
 * each statement as it runs ({@link runSequentialProgram}).
 */

import type { AnyDriver } from "../drivers/driver";
import { normalizeDriverError } from "../drivers/error-mapping";
import { errorCause } from "../drivers/shared/driver-options";
import {
  CLEANUP_BOUND_MS,
  DEFAULT_MIGRATION_TIME_LIMITS,
  leasePinnedCommand,
  type MigrationTimeLimits,
  type PinnedSessionControl,
  type PinnedSessionReservation,
  type ResolvedMigrationTimeLimits,
  settleWithin,
} from "../drivers/shared/pinned-session";
import { withSuppressedFailure } from "../drivers/shared/suppressed-failure";
import type { TransactionOptionSupport } from "../drivers/shared/transaction-options";
import { runTransactionLifecycle } from "../drivers/shared/transactions";
import type { QueryExecutionContext } from "../drivers/types";
import {
  ConnectionError,
  FeatureNotSupportedError,
  MigrationError,
  VibORMError,
  VibORMErrorCode,
} from "../errors";
import type { BoundMigrationDriver } from "./drivers";
import { planInterruptedMySQLDecimalRecovery } from "./drivers/mysql/decimal-recovery";
import { snapshotExactRecord } from "./input-boundary";
import { type CatalogRead, readsCommandNamespace } from "./target";
import { createQueryExecutor } from "./utils";

/**
 * Lock ID for PostgreSQL advisory locks.
 * Hash of "viborm_migrations" to avoid collisions.
 *
 * PostgreSQL keeps its DATABASE-wide key: an advisory lock is already scoped to
 * the database the session connected to, and independent schema estates in one
 * database deliberately serialize with each other — they share a catalog.
 * MySQL derives a database-specific name instead, because its named locks are
 * server-wide (`drivers/mysql/pinned-session.ts`).
 */
const MIGRATION_LOCK_ID = 0x76_69_62_6f_72_6d; // "viborm" in hex, truncated
const MYSQL_VERSION = /^(\d+)\.(\d+)\.(\d+)/;

const MYSQL_DECIMAL_RECOVERY = Symbol("mysqlDecimalRecovery");

interface MySQLDecimalRecoveryScope {
  take(producer: AnyDriver): Promise<readonly string[]>;
}

function isMySQLDecimalRecoveryScope(
  value: unknown
): value is MySQLDecimalRecoveryScope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "take") === "function"
  );
}

/**
 * Whether this driver can pin a session, answered without reserving one.
 *
 * The provider's `pinnedSession()` hook is the capability: its PRESENCE is the
 * whole answer. Migration admission asks this BEFORE any provider work, so an
 * effectful command on a transport with no interactive session refuses before
 * it connects.
 *
 * This and {@link withPinnedSession} live here, beside their only callers,
 * rather than on the `Driver` class, so an application bundle that never
 * migrates does not carry them. They reach the driver's protected members by
 * element access, exactly as `TransactionBoundDriver` reaches its base's.
 */
export function canPinSession(driver: AnyDriver): boolean {
  return driver["pinnedSession"] !== undefined;
}

/**
 * What a pinned session runs under besides its body (plan S1).
 *
 * `connectionWait` bounds the reservation on every transport. `limits` is the
 * PostgreSQL session's own: set once the session is reserved, reset before it
 * goes back, repeated with `SET LOCAL` in each of its transactions, and lifted
 * around a `CONCURRENTLY` statement.
 */
export interface PinnedSessionScope {
  readonly connectionWait: number;
  readonly limits?: PostgresSessionLimits | undefined;
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
  connectionWait: DEFAULT_MIGRATION_TIME_LIMITS.connectionWait,
};

/**
 * Runs `body` against ONE reserved producer.
 *
 * The view handed to the body is this exact driver with its client pinned to
 * the reservation, so every statement — the lock, the authoritative reads,
 * the DDL, the tracking writes, and the unlock — runs on the same physical
 * session, and a transaction opened inside the body runs on it too instead of
 * acquiring a second pooled connection.
 *
 * The producer is discarded rather than released when the body throws or
 * condemns it: a session whose lock state is unknown must not go back into a
 * pool. A session whose connection was LOST is never written to again — no
 * limits reset, no unlock, no rollback — and its failure surfaces as the
 * retryable connection error it is (plan S2).
 *
 * On a driver whose one connection IS the session, the whole call is one job
 * of the queue that already owns that connection — see the lease below.
 */
export async function withPinnedSession<D extends AnyDriver, T>(
  driver: D,
  body: (pinned: D, control: PinnedSessionControl) => Promise<T>,
  scope: PinnedSessionScope = DEFAULT_SCOPE
): Promise<T> {
  const reserve = driver["pinnedSession"];
  if (reserve === undefined) {
    // Two reachable shapes, one refusal. The shipped migration paths ask
    // `canPinSession()` at their admission boundary and refuse
    // `DRIVER_NOT_SUPPORTED` before any provider work, so this arm covers
    // what admission cannot see: a caller reaching the primitive directly
    // with a custom driver that implements no hook, and a caller reaching it
    // on a view that IS an already-reserved session (`createPinnedSessionView`
    // withdraws the hook).
    throw new FeatureNotSupportedError(
      driver.driverName,
      "pinnedSession",
      "No session can be reserved through this driver: either the transport has no interactive session at all, or this view is itself one reserved session and reserving again would take a SECOND connection. A migration lock is session-scoped, so either way it could be released by a different connection — or never released at all."
    );
  }

  const runSession = async (): Promise<T> => {
    // New defect 5: a server that accepts the socket and never answers left
    // this await pending for as long as the provider's own connect timeout —
    // forever on `pg`, whose pool has none by default.
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

    // The connection goes back to the application's pool, so the limits must
    // not go with it. A session whose reset failed still carries them and is
    // abandoned like a lost one; the reset's failure is RETURNED, so the
    // release after it always runs.
    const resetLimits = async (): Promise<unknown> => {
      if (limits === undefined || control.lost()) return undefined;
      try {
        await control.cleanup(() => view._executeRaw(limits.exit));
        return undefined;
      } catch (resetFailure) {
        control.abandon();
        return resetFailure;
      }
    };

    // The first failure is what the caller asked for and what the command
    // has to report. Awaiting the release in a `finally` made a release
    // rejection REPLACE it — the caller of a reset that dropped half an
    // estate on a dying socket was told only that the producer would not go
    // back. The release still runs, and still condemns the producer; every
    // later failure is recorded beside the first (§3.5).
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
      if (limits !== undefined) await view._executeRaw(limits.enter);
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

  // A provider that reserves a DEDICATED connection — `pg`, postgres.js, Bun
  // SQL, MySQL2 — hands back a producer that is already physically apart from
  // everything else its pool is serving, and there is nothing here to lease:
  // two migration commands on a pool are arbitrated by the real session lock,
  // and serializing them on this driver would be a regression.
  //
  // A single-connection driver reserves the connection every other caller
  // shares (plan §3.5: "PGlite — its single client UNDER THE EXISTING DRIVER
  // QUEUE"), so the whole session — the reservation, the acquisition, the
  // decisions, the DDL, the unlock and the release — is ONE job of that queue.
  // Leasing anything narrower lets a second command in between two of this
  // one's statements, and a PostgreSQL session advisory lock is REENTRANT: on
  // one session the second command re-acquires the lock the first is holding
  // instead of waiting for it.
  if (!driver["serializeTransactions"]) {
    return runSession();
  }
  // Reaching for the originating driver while its one connection is
  // transaction-bound is the refusal this driver already owns for every other
  // operation; here it is what stands between that caller and a wait on its
  // own holder. It is answered BEFORE the lease, not inside it: a driver that
  // waited for a lease another driver holds — on a client whose provider
  // serializes a transaction against every other statement — would wait for a
  // command that cannot finish until this transaction does.
  driver["assertBaseOperationAllowedDuringTransaction"](
    driver["resolveExecutionContext"](undefined, "pinnedSession")
  );
  const queue = driver["connectionQueue"];
  const identify = driver["physicalPinnedSession"];
  if (identify === undefined) {
    return queue.enqueue(runSession);
  }
  // The queue lease stays: it is what keeps this driver's own statements out
  // of the session. The physical lease is what keeps ANOTHER driver's command
  // out of it — and what refuses one outright when that session's
  // advisory-lock state was condemned, through this driver or any other.
  const session = await identify.call(driver);
  return leasePinnedCommand(driver.driverName, session, () =>
    queue.enqueue(runSession)
  );
}

/** The control of one reserved session, and what it knows about its connection. */
function controlSession(
  driver: AnyDriver,
  reservation: PinnedSessionReservation<unknown>
): PinnedSessionControl & {
  discarded(): boolean;
  lost(failure?: unknown, reported?: boolean): boolean;
  /** Sends nothing more on this session, whose state can no longer be made clean. */
  abandon(): void;
} {
  let discarded = false;
  let lost = false;
  const control = {
    discard: () => {
      discarded = true;
    },
    discarded: () => discarded,
    abandon: () => {
      lost = true;
    },
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
 * that the connection itself failed.
 *
 * The one classifier is the driver error mapping's: a statement sent through
 * the driver arrives already normalized, and a provider error from the raw
 * transaction statements is normalized here the same way.
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
 * retryable connection error carrying it.
 *
 * pg reports a socket that died mid-statement as an ordinary query failure,
 * and a caller deciding whether to retry needs to know it was the connection.
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
 * This driver, viewed with its client pinned to one reserved session.
 *
 * Defined rather than constructed: the view IS the concrete driver for every
 * other purpose — same adapter, same result parser, same capabilities — and
 * only the producer, the queue answer, the transaction owner and the
 * reservation hook differ. The facts it restates are `readonly`, hence
 * `defineProperties`. The transport assertion is forwarded EXACTLY: a pinned
 * session never derives, upgrades, or drops it, exactly as a
 * transaction-bound view does not.
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
  Object.defineProperties(view, {
    client: { value: session, writable: true },
    // `getClient()` returns a present client without consulting `initPromise`,
    // but a pinned view must never be able to start a second connection.
    initPromise: { value: null, writable: true },
    // The lease holds this driver's connection queue for the WHOLE session,
    // so a statement issued THROUGH this view must not wait on that queue: it
    // would be waiting for its own holder. The view is not opting out of
    // serialization — it IS the serialized job, and exclusivity for the whole
    // session is stronger than exclusivity per statement. On a driver that
    // took a dedicated connection there was no queueing here to begin with.
    serializeTransactions: { value: false },
    // §3.5's "one physical producer" made structural: the view IS the
    // reservation, so it has no reservation to give. Without this it
    // inherited the hook and answered `canPinSession() === true`, and a
    // nested `withLockedMigrationProducer` would have taken a SECOND
    // connection — one that then waits forever on PostgreSQL for the advisory
    // lock the first one holds, or times out on MySQL — instead of refusing.
    pinnedSession: { value: undefined },
    // The provider's own `transaction()` acquires a connection, which is what
    // pinning exists to prevent. A descriptor is how a `protected abstract`
    // member is replaced per-instance; it is also where the transaction
    // handle widens to the session, which is the honest shape here.
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
    // A `CONCURRENTLY` index statement waits, by design, for every
    // transaction older than it, without blocking anyone: the session's
    // limits would cut it short and leave an INVALID index behind (plan S1).
    // It runs with none, and they are restored once it completes; after a
    // failure the command is over and its release resets the session anyway.
    executeRaw: {
      async value(
        this: AnyDriver,
        client: unknown,
        sql: string,
        params: unknown[] | undefined,
        context?: QueryExecutionContext
      ) {
        if (limits === undefined || !CONCURRENTLY.test(sql)) {
          return executeRaw.call(this, client, sql, params, context);
        }
        await executeRaw.call(this, client, limits.unbound, undefined, context);
        const result = await executeRaw.call(
          this,
          client,
          sql,
          params,
          context
        );
        await executeRaw.call(this, client, limits.rebound, undefined, context);
        return result;
      },
    },
    // A driver whose `maxWait` bounds its connection-queue wait ("queue")
    // has nothing left to bound on this view: the lease already holds the
    // queue for the whole session, so accepting the option here would
    // accept a bound it cannot apply. Dedicated-connection drivers keep
    // their own answer.
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
  });
  return view;
}

/**
 * One transaction on the already-reserved session, installed as the pinned
 * view's `transaction` member (so `view` is that view).
 *
 * Every provider's own `transaction()` acquires a connection — that is the
 * behaviour a pinned session exists to prevent — and most of them refuse
 * outright when handed a connection instead of a pool. `BEGIN`/`COMMIT`/
 * `ROLLBACK` on the reserved producer is the one form that means the same
 * thing on every transport admitted to pinning, and it keeps the lock and the
 * transaction on one session.
 *
 * On PostgreSQL the transaction's first statement is its own `SET LOCAL`
 * limits (plan S1): a DDL statement queued behind a long reader gives up after
 * `lock_timeout` instead of stalling every read queued behind it. After a
 * connection failure no `ROLLBACK` is sent: the server ends the transaction
 * with its session, and a statement written to a dead connection only adds a
 * failure — or, on postgres.js, crashes the process (plan S2).
 */
function runPinnedTransaction<T>(
  view: AnyDriver,
  session: unknown,
  fn: (tx: unknown) => Promise<T>,
  context: QueryExecutionContext | undefined,
  control: PinnedSessionControl,
  limits: PostgresSessionLimits | undefined
): Promise<T> {
  const statement = async (sql: string) => {
    try {
      await view["executeRaw"](session, sql, undefined, context);
    } catch (failure) {
      control.lost(failure);
      throw failure;
    }
  };
  return runTransactionLifecycle({
    begin: () => statement("BEGIN"),
    // The session IS the transaction here: there is no second handle to hand
    // out, and a nested `$transaction` on it runs as a SAVEPOINT.
    callback: async () => {
      if (limits !== undefined) await statement(limits.transaction);
      try {
        return await fn(session);
      } catch (failure) {
        control.lost(failure);
        throw failure;
      }
    },
    commit: () => statement("COMMIT"),
    rollback: () =>
      control.lost() ? undefined : control.cleanup(() => statement("ROLLBACK")),
  });
}

/**
 * Runs `body` on ONE reserved producer holding this estate's migration lock.
 *
 * The body receives that producer and the migration driver THIS COMMAND must
 * render from: the same bound driver on every dialect but MySQL, and on MySQL
 * one carrying the spelling of the database the server itself answered with
 * (§5.2). Handing it over is what keeps the resolved spelling command-local —
 * it disappears with the session that resolved it, and nothing stores it.
 *
 * SQLite and LibSQL reserve nothing and take no lock: they own a single
 * connection with its own queue already, and §3.5 keeps that ownership rather
 * than making the new seam a regression for them. The callback then receives
 * the caller's own driver, which is exactly what it received before.
 *
 * This is the primitive both entry points share — estate commands through
 * {@link withLockedMigrationProducer}, and `push()`, which owns no migration
 * storage.
 */
export function withLockedMigrationProducer<T>(
  driver: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  body: (pinned: AnyDriver, command: BoundMigrationDriver) => Promise<T>
): Promise<T> {
  if (migrationDriver.target.dialect === "sqlite") {
    return body(driver, migrationDriver);
  }

  const limits = migrationDriver.timeLimits;
  return withPinnedSession(
    driver,
    async (pinned, control) => {
      // Acquisition stays OUTSIDE the release scope: a lock that was never
      // proven is not this session's to release, and issuing one anyway would
      // fail its own release proof and report that instead of the acquisition
      // failure. Everything after it is inside, because everything after it
      // happens with the lock HELD — §3.5's "unlocks through the same producer
      // in `finally`" covers the post-acquisition proof and target selection
      // too.
      await acquireLock(pinned, migrationDriver, control);

      let result: T;
      try {
        const command = await validateAndSelectMigrationTarget(
          pinned,
          migrationDriver
        );
        result = await body(pinned, scopeMySQLDecimalRecovery(command));
      } catch (error) {
        await releaseAfterFailure(pinned, migrationDriver, control, error);
        throw error;
      }
      await releaseLock(pinned, migrationDriver, control);
      return result;
    },
    {
      connectionWait: limits.connectionWait,
      limits:
        migrationDriver.target.dialect === "postgresql"
          ? postgresSessionLimits(limits)
          : undefined,
    }
  );
}

/**
 * A `CREATE`, `DROP` or `REINDEX INDEX CONCURRENTLY` statement — the only
 * kind whose waits block nobody. `REFRESH MATERIALIZED VIEW CONCURRENTLY` and
 * the word in a comment or a literal keep the limits.
 */
const CONCURRENTLY = /\bINDEX\s+CONCURRENTLY\b/i;

/**
 * The PostgreSQL statements behind one command's time limits (plan S1).
 *
 * The session's own limits are set once it is reserved, before the lock
 * statement, and cover it and every stepwise program, whose statements run
 * bare on the session: `lock_timeout`, so a DDL queued behind a long reader
 * gives up instead of stalling every read queued behind it (the lock statement
 * itself only polls `pg_try_advisory_lock`, which never waits on a lock); a
 * `statement_timeout` longer than the lock wait (so it never cuts the wait
 * short); and the idle limits that end a session whose client vanished while
 * holding the lock.
 *
 * The idle limits are asked of the server rather than assumed: they exist only
 * where `pg_settings` lists them (PostgreSQL 14+ for `idle_session_timeout` and
 * `client_connection_check_interval`), and a server that cannot check a
 * client's socket refuses `client_connection_check_interval`, which is then
 * left alone. They are not set on PGlite (`emscripten` in `version()`): its
 * in-process backend has no client to lose, and arming either idle timer there
 * hangs it — measured on PGlite 0.5.
 *
 * The reset puts back each setting's session default (`reset_val`, which keeps
 * a value the pool set at connect), because on success the connection returns
 * to the application's pool.
 */
function postgresSessionLimits(
  limits: ResolvedMigrationTimeLimits
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
    // Repeated in each transaction: a migration's own SQL may change the
    // session's values (pg_dump output opens with `SET lock_timeout = 0`),
    // and every later transaction still runs under the command's limits.
    transaction: `SELECT ${bound(lockTimeout, statementTimeout, true)}`,
    unbound: `SELECT ${bound(0, 0, false)}`,
    rebound: `SELECT ${bound(lockTimeout, statementTimeout, false)}`,
  };
}

/** The largest PostgreSQL timeout setting, and the largest timer delay. */
const MAX_TIME_LIMIT_MS = 2_147_483_647;

const TIME_LIMIT_KEYS = [
  "lockTimeout",
  "statementTimeout",
  "idleTimeout",
  "lockWait",
  "connectionWait",
] as const satisfies readonly (keyof MigrationTimeLimits)[];

/**
 * The time limits a migration client was given, settled once: each key a
 * whole number of milliseconds, the defaults filling in the rest.
 *
 * `lockWait` and `connectionWait` are waits VibORM bounds and must be
 * positive; the server settings accept 0 ("no limit"). Every key stops at
 * {@link MAX_TIME_LIMIT_MS}, the most both PostgreSQL's settings and a timer
 * hold. A `statementTimeout` must outlast `lockWait`, which runs as one
 * statement under it.
 */
export function resolveMigrationTimeLimits(
  input: unknown
): ResolvedMigrationTimeLimits {
  if (input === undefined) return DEFAULT_MIGRATION_TIME_LIMITS;
  const record = snapshotExactRecord(
    input,
    TIME_LIMIT_KEYS,
    "migration time limits",
    refuseTimeLimits
  );
  const limits: Record<(typeof TIME_LIMIT_KEYS)[number], number> = {
    ...DEFAULT_MIGRATION_TIME_LIMITS,
  };
  for (const key of TIME_LIMIT_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    const least = key === "lockWait" || key === "connectionWait" ? 1 : 0;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < least ||
      value > MAX_TIME_LIMIT_MS
    ) {
      refuseTimeLimits(
        `migration time limit ${key} must be a whole number of milliseconds, from ${least} to ${MAX_TIME_LIMIT_MS}`
      );
    }
    limits[key] = value;
  }
  if (
    limits.statementTimeout !== 0 &&
    limits.statementTimeout <= limits.lockWait
  ) {
    refuseTimeLimits(
      `migration time limit statementTimeout (${limits.statementTimeout} ms) must be 0 or longer than lockWait (${limits.lockWait} ms): the lock wait runs as one statement under it`
    );
  }
  return Object.freeze(limits);
}

function refuseTimeLimits(message: string, cause?: Error): never {
  throw new MigrationError(message, VibORMErrorCode.INVALID_INPUT, { cause });
}

/**
 * Selects the live migration target on a pinned producer, if this dialect has
 * one to select.
 *
 * The ONE consumer of the dialect's target-selection statement. It runs when
 * the lock is taken and again immediately before every relative artifact —
 * never only once for the session, because a manual artifact is allowed to
 * issue its own `USE` and the next artifact must still land on the configured
 * target (§10).
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
 * §5.3's step 2: VALIDATED target selection, once per session.
 *
 * Selecting a database the server does not have is a raw provider failure, and
 * §3.3 requires a configured-but-absent namespace to fail on its own read-only
 * catalog proof instead — before session state changes and before any DDL. The
 * proof therefore runs on this exact producer, immediately after the lock and
 * before the first selection; every later reassertion re-selects a target this
 * session has already validated.
 *
 * It runs on every dialect, not only the one with a target to select. A
 * PostgreSQL command's proof used to be deferred to whichever of its two
 * tracking owners ran first, which meant each of them had to ask again — and
 * meant the fact was re-established once per applied-state read instead of once
 * per command. Proving it HERE is what lets everything below this line render
 * from a driver that has already been proven.
 */
async function validateAndSelectMigrationTarget(
  pinned: AnyDriver,
  migrationDriver: BoundMigrationDriver
): Promise<BoundMigrationDriver> {
  const command = await resolveCommandDriver(pinned, migrationDriver);
  await selectMigrationTarget(pinned, command);
  await proveExactValueSessionMode(pinned, command);
  return command;
}

/**
 * MySQL only: PROVES this session fails on an out-of-range value instead of
 * truncating it (plan 3.3: "Strict exact-value behavior is required; a mode
 * that converts overflow or truncation to warnings is refused for effectful
 * decimal operations").
 *
 * The requirement is not decorative on a fixed-decimal estate. Outside strict
 * mode MySQL answers an overflowing `DECIMAL` assignment with a WARNING and
 * writes the clamped value: measured on 8.4, `UPDATE t SET amount = amount *
 * 100000` on a `DECIMAL(6,2)` column holding `10.00` stores `9999.99` and
 * returns success. Migration work may execute provider-authored DDL and manual
 * artifacts outside the ORM adapter's guarded decimal assignments, so its one
 * pinned producer must prove that an out-of-range exact value is an error.
 * Ordinary ORM increment, decrement, multiply, and divide carry their own
 * same-statement non-strict refusal; this proof owns the migration boundary.
 *
 * ONE proof, HERE: once per pinned migration session, on the producer that runs
 * the DDL, before any statement it protects. Not per operation — a hot-path
 * check would ask the same server the same question on every write, and the
 * session it would be asking about is the one this owner already reserved.
 * PostgreSQL and SQLite have no equivalent mode to prove: neither has a setting
 * that turns an out-of-range numeric into a truncation.
 */
async function proveExactValueSessionMode(
  pinned: AnyDriver,
  migrationDriver: BoundMigrationDriver
): Promise<void> {
  if (migrationDriver.target.dialect !== "mysql") {
    return;
  }
  const rows = await createQueryExecutor(pinned)(
    "SELECT @@SESSION.sql_mode AS sql_mode, VERSION() AS server_version"
  );
  const row = rows[0];
  const mode: unknown =
    typeof row === "object" && row !== null
      ? Reflect.get(row, "sql_mode")
      : undefined;
  const declared = typeof mode === "string" ? mode : "";
  const serverVersion: unknown =
    typeof row === "object" && row !== null
      ? Reflect.get(row, "server_version")
      : undefined;
  const renderedVersion =
    typeof serverVersion === "string" ? serverVersion : "<unreported>";
  if (!supportsEnforcedMySQLChecks(renderedVersion)) {
    throw new MigrationError(
      `This MySQL migration session reports version "${renderedVersion}". Fixed-decimal conversions require MySQL 8.0.16 or later, where CHECK constraints are enforced; the command is refused before any migration effect.`,
      VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      {
        meta: {
          dialect: "mysql",
          type: "unenforced-check-constraints",
          target: describeEstate(migrationDriver),
        },
      }
    );
  }
  const hasStrictMode = declared.split(",").some((mode) => {
    const token = mode.trim();
    return token === "STRICT_TRANS_TABLES" || token === "STRICT_ALL_TABLES";
  });
  if (hasStrictMode) {
    return;
  }
  throw new MigrationError(
    `This MySQL session runs in sql_mode "${declared}", which has neither STRICT_TRANS_TABLES nor STRICT_ALL_TABLES. ` +
      "Effectful migration work is refused: without a strict mode MySQL answers an out-of-range DECIMAL with a warning and stores the clamped value, so an exact fixed-decimal column would silently stop holding what it was given. Enable a strict mode on the server or on this connection and run the command again.",
    VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    {
      meta: {
        dialect: "mysql",
        type: "non-strict-sql-mode",
        target: describeEstate(migrationDriver),
      },
    }
  );
}

/** MySQL began enforcing CHECK constraints in 8.0.16. */
function supportsEnforcedMySQLChecks(version: string): boolean {
  if (version.toLowerCase().includes("mariadb")) {
    return false;
  }
  const match = MYSQL_VERSION.exec(version);
  if (match === null) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 8 || (major === 8 && (minor > 0 || patch >= 16));
}

/**
 * The ONE owner of the migration driver a command renders from, after its
 * namespace proof.
 *
 * A dialect that resolves a command-local spelling gets a view carrying it;
 * every other dialect proves and keeps the driver it was given. The view is
 * built the way every other execution view in this layer is — a frozen
 * `Object.create` over the bound driver, restating one readonly fact — so the
 * resolved name is not a second stored namespace: it lives exactly as long as
 * the command that resolved it (§5.2).
 *
 * The proof ANSWERS on the one dialect where the answer can differ from the
 * question: `resolveCommandNamespace` returns the server's own spelling of the
 * configured database. Throwing that spelling away is what made a case-folded
 * MySQL match pass its proof and then die on a raw `Unknown database` from the
 * very `USE` the proof had just admitted — while the reset inventory read a
 * database the server does not have.
 *
 * READ-ONLY commands take no lock — `status()`, `log()` and a dry `push()`
 * are point-in-time reports, not concurrency-stable decisions — and they reach
 * this same owner on their own producer. That is deliberate: the spelling is a
 * fact about the SERVER, not about the lock, so a command that proves it and
 * then renders the configured one is wrong whether or not it locked. There is
 * no second namespace source anywhere; every command's catalog reads and every
 * statement it renders come from the view returned here.
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
 * Runs a MySQL sequential program on `producer` and reports the boundary it
 * reached (§6.2, §6.3).
 *
 * MySQL commits DDL as each statement runs. Two things follow, and this is the
 * ONE owner of both. There is no transaction — the caller has already branched
 * away from its transaction owner, because `BEGIN` → `CREATE TABLE` (which
 * commits, and the `BEGIN` with it) → a tracking write now in autocommit →
 * `COMMIT` with nothing left to commit is the APPEARANCE of atomicity. And a
 * failure part-way through cannot be undone, so it is reported as the partial
 * commit it is.
 *
 * The boundary is recorded by the producer the body runs on, not by the body:
 * apply's artifact and its tracking insert, push's DDL, force-reset's clear and
 * rebuild, down's group, resolve's completion, and reset's replay are six
 * different programs. Each would otherwise have to carry its own bookkeeping
 * and its own error. The view is built the way every other execution view in
 * this layer is — an `Object.create` over the producer restating one member —
 * so the body runs on the SAME physical session, the same reserved client, and
 * the same attestation it was handed.
 *
 * The scope is the whole program the command commits to, deliberately: a report
 * covering only the clear would tell a `reset()` nothing about the replay that
 * followed it.
 */
export function mayWrapTransaction(
  producer: Pick<AnyDriver, "supportsTransactions">,
  dialect: string,
  transactional: boolean
): boolean {
  return transactional && dialect !== "mysql" && producer.supportsTransactions;
}

export async function runSequentialProgram<T>(
  producer: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  body: (recording: AnyDriver) => Promise<T>
): Promise<T> {
  let recoveryStatements: readonly string[] = [];
  if (migrationDriver.target.dialect === "mysql") {
    const recovery: unknown = Reflect.get(
      migrationDriver,
      MYSQL_DECIMAL_RECOVERY
    );
    if (!isMySQLDecimalRecoveryScope(recovery)) {
      throw new MigrationError(
        "This MySQL sequential migration program is not bound to its locked command's decimal-recovery scope.",
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { dialect: "mysql", type: "unbound-migration-command" } }
      );
    }
    recoveryStatements = await recovery.take(producer);
  }

  /**
   * The last statement that RAN TO COMPLETION.
   *
   * Where nothing rolls back, "completed" IS "committed", and it is the only
   * honest thing an error can say about a database it did not restore.
   */
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
    for (const statement of recoveryStatements) {
      await recording._executeRaw(statement);
    }
    return await body(recording);
  } catch (cause) {
    throw partialProgramFailure(cause, committed);
  }
}

/**
 * Gives one locked command one recoverable MySQL decimal-cleanup decision.
 *
 * The decision is lazy because apply must read and validate its authoritative
 * journal before recovery may touch the estate. The first sequential program
 * takes it after that preflight; later artifact/program segments in the same
 * command get an empty plan. Proof failures leave the decision untaken and
 * retain their exact migration-state diagnostics.
 */
function scopeMySQLDecimalRecovery(
  migrationDriver: BoundMigrationDriver
): BoundMigrationDriver {
  if (migrationDriver.target.dialect !== "mysql") {
    return migrationDriver;
  }
  if (migrationDriver.namespace === undefined) {
    throw new MigrationError(
      "This MySQL migration command has no resolved database for interrupted decimal-conversion recovery.",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { meta: { dialect: "mysql", type: "unbound-database" } }
    );
  }
  const namespace = migrationDriver.namespace;

  let taken = false;
  let planned: Promise<readonly string[]> | undefined;
  const scope: MySQLDecimalRecoveryScope = {
    async take(producer) {
      if (taken) return [];
      if (planned !== undefined) {
        await planned;
        return [];
      }
      planned = planInterruptedMySQLDecimalRecovery(
        (sql, params) => producer._executeRaw(sql, params),
        namespace,
        (name) => migrationDriver.escapeIdentifier(name)
      );
      try {
        const statements = await planned;
        taken = true;
        return statements;
      } catch (error) {
        planned = undefined;
        throw error;
      }
    },
  };
  const command: BoundMigrationDriver = Object.create(migrationDriver);
  Object.defineProperty(command, MYSQL_DECIMAL_RECOVERY, { value: scope });
  Object.freeze(command);
  return command;
}

/**
 * The honest report for a program that cannot be undone (§6.2, §6.3).
 *
 * It states the boundary and refuses to characterize anything past it: the
 * statement that FAILED may have taken effect before it errored, so the last
 * statement known to have completed is the strongest true claim available.
 * Nothing here says or implies "rolled back" — the whole reason this error
 * exists is that no rollback happened — and nothing here claims the database
 * was CHANGED either, because a program can fail on the catalog read it opens
 * with.
 *
 * The provider's own failure survives underneath as the cause rather than being
 * replaced by this report.
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
    { cause: cause instanceof Error ? cause : undefined }
  );
}

/**
 * Acquires the lock and PROVES it.
 *
 * The order is §5.3's: lock first, target selection second, and everything the
 * command decides from live state after both. Selecting the target before the
 * lock would let two commands agree on a database and then race inside it —
 * which is why the selection is the caller's next step rather than this one's
 * tail: it belongs to the scope that releases.
 */
async function acquireLock(
  pinned: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  control: PinnedSessionControl
): Promise<void> {
  const statement = migrationDriver.generateAcquireLock(MIGRATION_LOCK_ID);
  if (statement === null) {
    return;
  }

  const executor = createQueryExecutor(pinned);
  let rows: unknown[];
  try {
    rows = await executor(statement);
  } catch (error) {
    // A lost connection is not a lock failure: it is retryable, and the
    // session surfaces it as such.
    if (control.lost(error)) throw error;
    throw new MigrationError(
      `Failed to acquire the migration lock for ${describeEstate(migrationDriver)}: the lock statement itself failed.`,
      VibORMErrorCode.MIGRATION_LOCK_FAILED,
      { cause: error instanceof Error ? error : undefined }
    );
  }

  if (!migrationDriver.provesLockAcquired(rows)) {
    throw new MigrationError(
      `Failed to acquire the migration lock for ${describeEstate(migrationDriver)}: the provider did not confirm the lock. ` +
        "A wait that timed out, an error, or a malformed answer all mean the lock is NOT held; VibORM will not run migration work on that assumption.",
      VibORMErrorCode.MIGRATION_LOCK_FAILED
    );
  }
}

/**
 * Releases the lock after the protected work FAILED, without replacing its
 * error.
 *
 * A `finally` that throws destroys the exception the caller needs: a MySQL
 * reset that cleared tracking and dropped half an estate on a dying connection
 * would report only "the lock could not be released", losing both the statement
 * that failed and the partial-commit reality §3.5 and §6.2 require it to state.
 * So the release still runs — the lock must not outlive the command, and the
 * producer is still condemned — and its own failure is RECORDED on the way out
 * instead of replacing the cause.
 *
 * The recording is {@link withSuppressedFailure}, the one rule both cleanup owners
 * share. Appending the detail to `cause.message` was the same intent written as
 * a WRITE to an error VibORM does not own: it throws outright for a frozen
 * Error or an accessor-backed `message`, and the caller was then told about a
 * `TypeError` from the cleanup rather than about the estate.
 */
async function releaseAfterFailure(
  pinned: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  control: PinnedSessionControl,
  cause: unknown
): Promise<void> {
  // A session that lost its connection holds no lock to release: the server
  // frees it with the session, and an unlock written to that connection only
  // adds a failure — or, on postgres.js, crashes the process (plan S2).
  if (control.lost(cause)) return;
  try {
    await releaseLock(pinned, migrationDriver, control);
  } catch (releaseFailure) {
    // For everything a caller can throw and hold, this IS `cause` — carrying
    // the release failure, unchanged in every other respect. Only a primary
    // that can carry nothing at all (a thrown string, a thrown number) changes
    // shape, into the one carrier that keeps both.
    throw withSuppressedFailure(cause, releaseFailure);
  }
}

/**
 * Releases the lock and PROVES the release.
 *
 * An unproven release condemns the producer: it is a session holding a lock
 * nobody will free, and handing it back to a pool would strand that lock for
 * the life of the connection. The refusal surfaces — cleanup failure is a
 * failure — except when the body itself already threw, in which case the throw
 * propagates and replacing it would hide the cause
 * ({@link releaseAfterFailure}).
 *
 * The lock is released through the driver the command was GIVEN, never through
 * the command-local view a MySQL session resolved: a release has to name the
 * lock this session acquired, and only the acquiring driver can name it.
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
      { cause: error instanceof Error ? error : undefined }
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
  return target.dialect === "postgresql"
    ? `schema "${target.namespace}"`
    : `database "${migrationDriver.namespace ?? "(unbound)"}"`;
}
