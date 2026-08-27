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
 * allowed before the authoritative under-lock journal read, and both are
 * non-durable: a journal mismatch after acquisition unlocks and leaves zero
 * tracking, DDL, artifact or snapshot effects behind.
 *
 * Two facts about that producer live here with it, because both are answers no
 * command may source twice: the driver a command RENDERS from
 * ({@link resolveCommandDriver}, which read-only commands reach without a
 * lock), and the commit boundary a program reached when the dialect commits
 * each statement as it runs ({@link runSequentialProgram}).
 */

import type { AnyDriver } from "../drivers/driver";
import { withCleanupFailure } from "../drivers/shared/cleanup-failure";
import { MigrationError, VibORMErrorCode } from "../errors";
import type { MigrationContext } from "./context";
import type { BoundMigrationDriver } from "./drivers";
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
 * This is the primitive both entry points share — `MigrationContext` commands
 * through {@link withLockedMigrationSession}, and `push()`, which owns no
 * migration storage and therefore no context.
 */
export function withLockedMigrationProducer<T>(
  driver: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  body: (pinned: AnyDriver, command: BoundMigrationDriver) => Promise<T>
): Promise<T> {
  if (migrationDriver.target.dialect === "sqlite") {
    return body(driver, migrationDriver);
  }

  return driver._withPinnedSession(async (pinned, control) => {
    // Acquisition stays OUTSIDE the release scope: a lock that was never proven
    // is not this session's to release, and issuing one anyway would fail its
    // own release proof and report that instead of the acquisition failure.
    // Everything after it is inside, because everything after it happens with
    // the lock HELD — §3.5's "unlocks through the same producer in `finally`"
    // covers the post-acquisition proof and target selection too.
    await acquireLock(pinned, migrationDriver);

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
  });
}

/**
 * Runs `fn` under this estate's migration lock with a context bound to the
 * pinned producer.
 */
export function withLockedMigrationSession<T>(
  ctx: MigrationContext,
  fn: (locked: MigrationContext) => Promise<T>
): Promise<T> {
  return withLockedMigrationProducer(
    ctx.driver,
    ctx.migrationDriver,
    (pinned, command) => fn(pinContext(ctx, pinned, command))
  );
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
  return command;
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
 * READ-ONLY commands take no lock — `status()`, `pending()` and a dry `push()`
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
 * rebuild, down's group and reset's replay are five different programs, and
 * each of them would otherwise have to carry its own bookkeeping and its own
 * error. The view is built the way every other execution view in this layer is
 * — an `Object.create` over the producer restating one member — so the body
 * runs on the SAME physical session, the same reserved client, and the same
 * attestation it was handed.
 *
 * The scope is the whole program the command commits to, deliberately: a report
 * covering only the clear would tell a `reset()` nothing about the replay that
 * followed it.
 */
export async function runSequentialProgram<T>(
  producer: AnyDriver,
  body: (recording: AnyDriver) => Promise<T>
): Promise<T> {
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
    return await body(recording);
  } catch (cause) {
    throw partialProgramFailure(cause, committed);
  }
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
      "The migration journal, snapshot and artifacts are untouched — fix the cause and re-run.",
    VibORMErrorCode.MIGRATION_FAILED,
    { cause: cause instanceof Error ? cause : undefined }
  );
}

/**
 * The caller's context, viewed with its producer pinned.
 *
 * Same estate, same storage, same tracking-table name — a different producer,
 * and the command's own migration driver. Defined rather than assigned because
 * the facts it replaces are readonly; this is the shape `MigrationContext`'s
 * own transaction view already uses.
 */
function pinContext(
  ctx: MigrationContext,
  pinned: AnyDriver,
  command: BoundMigrationDriver
): MigrationContext {
  const locked: MigrationContext = Object.create(ctx);
  Object.defineProperties(locked, {
    driver: { value: pinned },
    executor: { value: createQueryExecutor(pinned) },
    isPinned: { value: true },
    migrationDriver: { value: command },
  });
  return locked;
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
  migrationDriver: BoundMigrationDriver
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
 * The recording is {@link withCleanupFailure}, the one rule both cleanup owners
 * share. Appending the detail to `cause.message` was the same intent written as
 * a WRITE to an error VibORM does not own: it throws outright for a frozen
 * Error or an accessor-backed `message`, and the caller was then told about a
 * `TypeError` from the cleanup rather than about the estate.
 */
async function releaseAfterFailure(
  pinned: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  control: { discard(): void },
  cause: unknown
): Promise<void> {
  try {
    await releaseLock(pinned, migrationDriver, control);
  } catch (releaseFailure) {
    // For everything a caller can throw and hold, this IS `cause` — carrying
    // the release failure, unchanged in every other respect. Only a primary
    // that can carry nothing at all (a thrown string, a thrown number) changes
    // shape, into the one carrier that keeps both.
    throw withCleanupFailure(cause, releaseFailure);
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
  control: { discard(): void }
): Promise<void> {
  const statement = migrationDriver.generateReleaseLock(MIGRATION_LOCK_ID);
  if (statement === null) {
    return;
  }

  const executor = createQueryExecutor(pinned);
  let rows: unknown[];
  try {
    rows = await executor(statement);
  } catch (error) {
    control.discard();
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
