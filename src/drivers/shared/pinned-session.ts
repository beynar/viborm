import { ConnectionError, VibORMErrorCode } from "@errors";
import { type Clock, type ClockTimer, systemClock } from "../../clock";
import { errorCause } from "./driver-options";
import { withSuppressedFailure } from "./suppressed-failure";

/** The PostgreSQL statement that resets a session's advisory-lock state. */
const ADVISORY_RESET = "SELECT pg_advisory_unlock_all()";

/** Why a reserved session is abandoned, in the refusal's own words. */
const LOST_SESSION =
  "lost the connection of a reserved migration session and sent nothing more on it.";
const ADVISORY_RESET_FAILED = `could not prove the advisory-lock state of a discarded migration session: its "${ADVISORY_RESET}" reset failed.`;

/**
 * How long one cleanup statement — `ROLLBACK`, the unlock, the limits reset,
 * the advisory reset — may take before its session is treated as lost.
 *
 * A healthy server answers each of them in milliseconds. A session that does
 * not answer one within this bound is a half-open socket or a dying backend,
 * and waiting on it longer only keeps the caller from the failure it already
 * has (plan S2: "bound every cleanup statement").
 */
export const CLEANUP_BOUND_MS = 5000;

/**
 * The limits of one migration command's pinned session (plan S1), and the
 * table size it may rewrite in-request (plan T5a).
 *
 * Every value but `largeTableRows` is in milliseconds. `lockTimeout`, `statementTimeout` and
 * `idleTimeout` are PostgreSQL server settings, where 0 means "no limit";
 * `lockWait` and `connectionWait` are waits VibORM itself bounds. Only
 * `connectionWait` applies to MySQL as well: the others, `largeTableRows`
 * included, are PostgreSQL-only, and MySQL keeps its fixed named-lock wait.
 */
export interface MigrationLimits {
  /**
   * `lock_timeout`, for the session and, with `SET LOCAL`, every migration
   * transaction: how long one DDL statement may queue for a table lock.
   */
  readonly lockTimeout?: number;
  /**
   * `statement_timeout`, for every migration transaction and for the session
   * around the lock and stepwise programs. 0, or longer than `lockWait`.
   */
  readonly statementTimeout?: number;
  /**
   * `idle_in_transaction_session_timeout` and, on PostgreSQL 14+,
   * `idle_session_timeout`: how long the server keeps a migration session
   * whose client stopped talking — the one that vanished holding the lock.
   */
  readonly idleTimeout?: number;
  /** How long the command waits for the migration lock another one holds. */
  readonly lockWait?: number;
  /** How long the command waits for its pinned connection. */
  readonly connectionWait?: number;
  /**
   * A row count, not milliseconds: the planner's estimate above which a
   * statement that rewrites or scans a table under a lock that blocks it (a
   * column type change, `SET NOT NULL`, a volatile `ADD COLUMN` default, a
   * FOREIGN KEY or CHECK added without `NOT VALID`) is refused before any
   * effect, because it would hold that lock longer than a request should.
   * 0 admits every size.
   */
  readonly largeTableRows?: number;
}

export type ResolvedMigrationLimits = Readonly<Required<MigrationLimits>>;

export const DEFAULT_MIGRATION_LIMITS: ResolvedMigrationLimits = Object.freeze({
  lockTimeout: 4000,
  statementTimeout: 600_000,
  idleTimeout: 1000,
  lockWait: 10_000,
  connectionWait: 10_000,
  largeTableRows: 1_000_000,
});

/**
 * `running`, or a rejection built by `expired` once `ms` passed without an
 * answer.
 *
 * The abandoned operation keeps running on the provider. Its rejection is
 * observed here so it never surfaces as unhandled, and a late success is
 * handed to `abandon` — a reservation nobody will use goes back.
 *
 * `clock` is the same internal seam the transaction bounds take.
 */
export async function settleWithin<T>(
  running: Promise<T>,
  ms: number,
  expired: () => Error,
  abandon?: (late: T) => void,
  clock: Clock = systemClock
): Promise<T> {
  let timer: ClockTimer | undefined;
  let late = false;
  running.then(
    (value) => {
      if (late) abandon?.(value);
    },
    () => undefined
  );
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = clock.setTimeout(() => {
      late = true;
      reject(expired());
    }, ms);
  });
  try {
    return await Promise.race([running, expiry]);
  } finally {
    timer?.cancel();
  }
}

/**
 * One reserved physical session, as a provider hands it back.
 *
 * The plan's requirement (§3.5) is "one physical producer across decisions and
 * commit boundaries": a session lock is session-scoped, so acquiring it through
 * one pooled connection and running the protected work through another protects
 * nothing and can strand the lock. A reservation is therefore a connection the
 * provider has taken OUT of its pool, plus the exact way to give it back.
 */
export interface PinnedSessionReservation<TSession> {
  /** The reserved producer. Every statement of the session runs on it. */
  readonly session: TSession;
  /**
   * The failure the provider itself saw end this session's connection, or
   * `undefined` while it has seen none.
   *
   * Only a provider that observes its connection has one (`pg`, through the
   * client's `error` event). Elsewhere a lost connection is recognized by the
   * failure that reported it.
   */
  readonly lost?: () => unknown;
  /**
   * Returns the producer to the provider.
   *
   * `discard` is true when the session's state is unknown — a failed unlock, a
   * failed cleanup, or a thrown body — and the provider must then destroy the
   * connection rather than hand a session carrying unknown state back to a
   * pool. A provider whose session can never be made clean again (MySQL2, which
   * has executed `USE` and possibly author-owned statements) destroys
   * unconditionally and ignores the flag.
   *
   * `lost` is true when the connection itself is gone or stopped answering:
   * the provider must send nothing more on it — not even the reset a discard
   * otherwise runs — and abandon or destroy it.
   */
  release(discard: boolean, lost?: boolean): Promise<void>;
}

/**
 * The handle the pinned body uses to condemn its own producer.
 *
 * A thrown body already condemns the session. This exists for the case that
 * does not throw: an unlock statement that RETURNS a result proving the lock
 * was not released. That session is still usable in the provider's eyes and
 * would be returned to the pool holding a lock nobody owns.
 */
export interface PinnedSessionControl {
  /** Condemn this producer; it will be destroyed instead of released. */
  discard(): void;
  /**
   * Whether this session's connection is gone: the provider saw it end,
   * `failure` reports it, or a cleanup statement went unanswered. Once true it
   * stays true, and nothing more is sent on the session (plan S2).
   */
  lost(failure?: unknown): boolean;
  /** Runs one cleanup statement within `CLEANUP_BOUND_MS`; past it, the session is lost. */
  cleanup<T>(run: () => Promise<T>): Promise<T>;
}

/**
 * The refusal a discarded session whose reset FAILED raises.
 *
 * A session is discarded because its state is unknown, and the reset is what
 * makes it known again. When the reset fails too, the session may still hold
 * the migration lock every other command is excluded by — so it must not go
 * back to the provider, and saying nothing about that is not an option either:
 * a swallowed cleanup failure is how a pool ends up serving a connection that
 * blocks the next migration forever.
 *
 * The reset's own failure is the evidence, and it is the PROVIDER's value: it
 * goes through the one total normalizer rather than a bare `instanceof`, which
 * a rejection whose `getPrototypeOf` trap throws turns into a throw inside this
 * constructor — replacing the whole typed refusal with the trap's error.
 */
export function unprovenLockStateError(
  driverName: string,
  containment: string,
  cause: unknown
): ConnectionError {
  return abandonedSessionError(
    driverName,
    ADVISORY_RESET_FAILED,
    containment,
    errorCause(cause)
  );
}

function abandonedSessionError(
  driverName: string,
  reason: string,
  containment: string,
  cause: Error | undefined
): ConnectionError {
  return new ConnectionError(
    `Driver "${driverName}" ${reason} ${containment}`,
    {
      code: VibORMErrorCode.CONNECTION_CLOSED,
      cause,
      meta: { driver: driverName, operation: "pinnedSession" },
    }
  );
}

/**
 * The refusal raised afterwards by EVERY driver whose one client was condemned.
 *
 * A transport that pools connections recovers by reserving a different one, so
 * this is only for the driver whose single client IS the session: there is no
 * other connection to reach for, and running the next migration command on a
 * session that may still hold the lock is precisely what the condemnation
 * exists to prevent. Two drivers over that one client are two callers of this
 * same refusal, because the session they would both pin is the same session.
 */
export function condemnedSessionError(driverName: string): ConnectionError {
  return new ConnectionError(
    `Driver "${driverName}" will pin no further migration session: an earlier session's "${ADVISORY_RESET}" reset failed, so the advisory-lock state of its one client is unknown. That client was not closed — it is the caller's database, not a pooled connection VibORM may discard — and ordinary queries on it are unaffected.`,
    {
      code: VibORMErrorCode.CONNECTION_CLOSED,
      meta: { driver: driverName, operation: "pinnedSession" },
    }
  );
}

/**
 * What was actually DONE about the abandoned connection, in the refusal's own
 * words.
 *
 * Three outcomes, three sentences, each chosen once the outcome is known
 * rather than once the ownership is known. A single sentence written before the
 * close was attempted claimed the backend had been ended even when ending it
 * threw — and the one thing a caller does with that claim is stop looking for a
 * connection that is still running, still holding the lock this refusal exists
 * to report.
 */
const CALLER_OWNED_CONTAINMENT =
  "The reserved connection was abandoned rather than returned to the pool. VibORM did not close the transport, which belongs to the caller, so the lock is freed when that connection is.";
const CLOSED_CONTAINMENT =
  "The reserved connection was abandoned rather than returned to the pool, and the transport VibORM created for it was closed — which ends that backend, and with it every advisory lock it held.";
const CLOSE_FAILED_CONTAINMENT =
  "The reserved connection was abandoned rather than returned to the pool, and ending the transport VibORM created for it FAILED: that backend may still be running, and any advisory lock it holds is freed only when it goes away. VibORM withdrew that transport and will not use it again.";

/**
 * Returns a reserved PostgreSQL session to its pool, or condemns it — the ONE
 * rule for every provider that reserves a connection it cannot destroy.
 *
 * postgres.js and Bun SQL both expose `release()` and nothing else: there is no
 * destructive return to reach for, so a session whose reset failed is ABANDONED
 * — never released — which is the only way it stops being a connection the pool
 * will hand to the next caller.
 *
 * Abandoning it leaves the lock held until that backend goes away, so a
 * transport VibORM created is closed too: ending it terminates the backend, and
 * PostgreSQL frees every advisory lock the session held. A transport the CALLER
 * supplied is never closed for this — it is theirs, may be serving their own
 * code, and closing it to tidy up VibORM's cleanup failure would be a far
 * larger effect than the one being contained.
 *
 * A LOST session (plan S2) is abandoned the same way without the reset: its
 * connection is gone or stopped answering, and a statement written to it is,
 * on postgres.js, an uncaught crash from inside the provider's write loop. Its
 * owned transport is closed; a supplied one is reported, since abandoning is
 * all VibORM may do with it.
 */
export async function releaseReservedPostgresSession(reservation: {
  readonly driverName: string;
  readonly discard: boolean;
  readonly lost?: boolean | undefined;
  /** Runs `SELECT pg_advisory_unlock_all()` on the reserved session. */
  readonly reset: () => Promise<unknown>;
  /** Hands the reserved session back to the provider's pool. */
  readonly release: () => void;
  /** Closes the transport, or absent when the CALLER owns it. */
  readonly closeOwnedTransport: (() => Promise<void>) | undefined;
}): Promise<void> {
  if (reservation.lost === true) {
    const { closeOwnedTransport, driverName } = reservation;
    if (closeOwnedTransport === undefined) {
      throw abandonedSessionError(
        driverName,
        LOST_SESSION,
        CALLER_OWNED_CONTAINMENT,
        undefined
      );
    }
    // Not awaited: the connection failure the caller holds is already the
    // answer, and the close lets the transport's other queries finish first
    // (postgres.js waits on the dead connection's unsettled query until its
    // bound). The transport is withdrawn before it closes, and a session the
    // close cannot end is ended by the server's idle limit.
    closeOwnedTransport().catch(() => undefined);
    return;
  }
  if (!reservation.discard) {
    reservation.release();
    return;
  }

  try {
    await settleWithin(
      reservation.reset(),
      CLEANUP_BOUND_MS,
      () =>
        new Error(
          `The advisory-lock reset went unanswered for ${CLEANUP_BOUND_MS} ms.`
        )
    );
  } catch (resetFailure) {
    await abandon(reservation, ADVISORY_RESET_FAILED, resetFailure);
  }
  reservation.release();
}

/**
 * Abandons a reserved session: never released, its owned transport closed,
 * and the refusal that says so thrown. A transport the caller supplied is only
 * abandoned.
 */
async function abandon(
  reservation: {
    readonly driverName: string;
    readonly closeOwnedTransport: (() => Promise<void>) | undefined;
  },
  reason: string,
  cause: unknown
): Promise<void> {
  const { closeOwnedTransport, driverName } = reservation;
  if (closeOwnedTransport === undefined) {
    throw abandonedSessionError(
      driverName,
      reason,
      CALLER_OWNED_CONTAINMENT,
      errorCause(cause)
    );
  }
  try {
    await closeOwnedTransport();
  } catch (closeFailure) {
    // The reason stays primary — it is what the caller acts on — and the
    // close's own failure is cleanup evidence beside it.
    throw withSuppressedFailure(
      abandonedSessionError(
        driverName,
        reason,
        CLOSE_FAILED_CONTAINMENT,
        errorCause(cause)
      ),
      closeFailure
    );
  }
  throw abandonedSessionError(
    driverName,
    reason,
    CLOSED_CONTAINMENT,
    errorCause(cause)
  );
}

/** What VibORM knows about one PHYSICAL session it pins commands on. */
interface PhysicalSessionState {
  /**
   * The pinned commands already queued on this session. It never rejects, so
   * one command's failure cannot poison the queue — the next command runs
   * either way, exactly as it would after a success.
   */
  queued: Promise<void>;
  /**
   * Set when a discarded session's advisory-lock reset failed, and never
   * cleared: nothing that happens later can prove a lock was released.
   */
  condemned: boolean;
}

/**
 * What is known about each PHYSICAL session, keyed on the session itself.
 *
 * A driver's connection queue serializes the commands of THAT driver. Two
 * drivers built over one supplied client — the documented shape for two
 * schema-scoped estates over one PGlite — own two queues and one session, so
 * the queue arbitrates nothing between them, and a PostgreSQL session advisory
 * lock is REENTRANT: the second command re-acquires the lock the first is
 * holding instead of waiting for it, then reads and writes inside the first
 * command's session. The client is the only thing both drivers agree on, so it
 * is what this is keyed on.
 *
 * The condemnation shares that key because it answers for the same subject: a
 * failed reset leaves the CLIENT's lock state unknown, not the wrapper's. Kept
 * on the driver instead, it was a fact the other wrappers over that client
 * never consulted, and their next command ran inside the session it condemned.
 *
 * Weak by construction: the entry dies with the client, and a client nobody
 * holds keeps nothing alive here.
 */
const PHYSICAL_SESSIONS = new WeakMap<object, PhysicalSessionState>();

/**
 * Refuses a command on a session whose advisory-lock state was condemned.
 *
 * One refusal, read at two moments, and each covers what the other cannot. At
 * ADMISSION, so a session condemned before this command arrived refuses now
 * rather than behind a queue whose head may itself be waiting on the very lock
 * nobody can account for. At the FRONT of the queue, because condemnation lands
 * BETWEEN the two: the command ahead of this one is the one whose reset fails,
 * and this one was admitted while that session still looked accountable.
 */
function refuseCondemnedSession(
  driverName: string,
  state: PhysicalSessionState
): void {
  if (state.condemned) {
    throw condemnedSessionError(driverName);
  }
}

/**
 * Runs `command` exclusively on this physical session, when it may still be
 * pinned at all.
 *
 * The refusal is here rather than beside it because this is the one path every
 * pinned command over a shared session takes, and it lands before `command` —
 * so no body and no statement of the refused command reaches the client.
 */
export function leasePinnedCommand<T>(
  driverName: string,
  session: object,
  command: () => Promise<T>
): Promise<T> {
  const state = physicalSessionState(session);
  refuseCondemnedSession(driverName, state);
  const next = state.queued.then(() => {
    refuseCondemnedSession(driverName, state);
    return command();
  });
  state.queued = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * Records that this physical session's advisory-lock state can no longer be
 * accounted for — for every driver that reaches it, not only the one whose
 * reset failed.
 */
export function condemnPhysicalSession(session: object): void {
  physicalSessionState(session).condemned = true;
}

/** This session's state, created on first use and mutated in place after. */
function physicalSessionState(session: object): PhysicalSessionState {
  const existing = PHYSICAL_SESSIONS.get(session);
  if (existing) {
    return existing;
  }
  const created: PhysicalSessionState = {
    queued: Promise.resolve(),
    condemned: false,
  };
  PHYSICAL_SESSIONS.set(session, created);
  return created;
}
