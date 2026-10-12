/**
 * The limits of one migration command (plans S1, T5a): their type, their
 * defaults and the one resolver. Only migration code imports this module, so
 * an application bundle carries none of it.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { snapshotExactRecord } from "./input-boundary";

/**
 * The limits of one migration command's pinned session (plan S1), and the
 * table size it may rewrite in-request (plan T5a).
 *
 * Every value but `largeTableRows` is in milliseconds. `lockTimeout`, `statementTimeout` and
 * `idleTimeout` are PostgreSQL server settings, where 0 means "no limit";
 * `lockWait` and `connectionWait` are waits VibORM itself bounds. `lockWait`
 * also bounds SQLite's `BEGIN IMMEDIATE`, and `connectionWait` applies to
 * MySQL as well; the others, `largeTableRows` included, are PostgreSQL-only,
 * and MySQL keeps its fixed named-lock wait.
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

/** The largest PostgreSQL timeout setting, and the largest timer delay. */
const MAX_TIME_LIMIT_MS = 2_147_483_647;

const LIMIT_KEYS = [
  "lockTimeout",
  "statementTimeout",
  "idleTimeout",
  "lockWait",
  "connectionWait",
  "largeTableRows",
] as const satisfies readonly (keyof MigrationLimits)[];

/**
 * The limits a migration client was given, settled once: each key a whole
 * number (milliseconds, rows for `largeTableRows`), the defaults filling in
 * the rest.
 *
 * `lockWait` and `connectionWait` are waits VibORM bounds and must be
 * positive; the server settings accept 0 ("no limit"). Every key stops at
 * {@link MAX_TIME_LIMIT_MS}, the most both PostgreSQL's settings and a timer
 * hold. A `statementTimeout` must outlast `lockWait`, which runs as one
 * statement under it.
 */
export function resolveMigrationLimits(
  input: unknown
): ResolvedMigrationLimits {
  if (input === undefined) return DEFAULT_MIGRATION_LIMITS;
  const record = snapshotExactRecord(
    input,
    LIMIT_KEYS,
    "migration limits",
    refuseLimits
  );
  const limits: Record<(typeof LIMIT_KEYS)[number], number> = {
    ...DEFAULT_MIGRATION_LIMITS,
  };
  for (const key of LIMIT_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    const least = key === "lockWait" || key === "connectionWait" ? 1 : 0;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < least ||
      value > MAX_TIME_LIMIT_MS
    ) {
      refuseLimits(
        `migration limit ${key} must be a whole number of ${key === "largeTableRows" ? "rows" : "milliseconds"}, from ${least} to ${MAX_TIME_LIMIT_MS}`
      );
    }
    limits[key] = value;
  }
  if (
    limits.statementTimeout !== 0 &&
    limits.statementTimeout <= limits.lockWait
  ) {
    refuseLimits(
      `migration limit statementTimeout (${limits.statementTimeout} ms) must be 0 or longer than lockWait (${limits.lockWait} ms): the lock wait runs as one statement under it`
    );
  }
  return Object.freeze(limits);
}

function refuseLimits(message: string, cause?: Error): never {
  throw new MigrationError(message, VibORMErrorCode.INVALID_INPUT, { cause });
}
