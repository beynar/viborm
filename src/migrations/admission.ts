/**
 * Live-capability admission
 *
 * ONE decision admits a migration command to live database state. Direct
 * `push()` and every high-level migration command reach it here; no command
 * reinterprets either fact for itself.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import type { BoundMigrationDriver } from "./drivers";
import { formatMigrationTarget, readNamespaceAttestation } from "./target";

/**
 * What a command asks of live state.
 *
 * - `effectful` — the command can write, or promises a concurrency-stable
 *   decision read from live state (apply/down/reset/verify/push, and the live
 *   dry down/reset decisions the CLI confirms against).
 * - `read-only` — a point-in-time read that changes nothing (status, log,
 *   push dry-run introspection).
 *
 * Offline and storage-only work — generate, check, apply dry-run — never
 * reaches this owner at all.
 */
export type MigrationLiveRequirement = "effectful" | "read-only";

/**
 * Admits (or refuses) live migration work for one command.
 *
 * The failure precedence for MySQL is exact and is the whole point of the
 * owner: an absent attestation is `DRIVER_NOT_SUPPORTED`, and only AFTER the
 * capability is admitted does an absent namespace become
 * `MIGRATION_INVALID_STATE`. Reversing them would report a missing database
 * name for a driver whose routing was never provable in the first place.
 *
 * PostgreSQL namespaces are proven earlier, when the estate target is resolved
 * — a PostgreSQL driver with no adapter namespace never reaches a live
 * boundary. SQLite has no namespace to prove.
 */
export function admitLiveMigrationCapability(
  migrationDriver: BoundMigrationDriver,
  requirement: MigrationLiveRequirement,
  command: string
): void {
  const { target } = migrationDriver;

  if (target.dialect === "postgresql") {
    admitPinnedSessionCapability(migrationDriver, requirement, command);
    return;
  }

  if (target.dialect === "sqlite") {
    admitSqliteFamilyCapability(migrationDriver, requirement, command);
    return;
  }

  if (target.dialect !== "mysql") {
    return;
  }

  if (requirement === "effectful") {
    const attestation = readNamespaceAttestation(
      migrationDriver.executionDriver
    );
    if (attestation === undefined) {
      throw new MigrationError(
        `${command} needs proof that this MySQL driver does not redirect qualified table references, and the driver "${migrationDriver.executionDriver.driverName}" carries no non-redirecting migration-namespace attestation. ` +
          "Effectful and concurrency-stable live migration work is refused: a successful handshake, a driver class, a URL shape or a server version is not proof that a proxy leaves qualified names in the requested database.",
        VibORMErrorCode.DRIVER_NOT_SUPPORTED,
        {
          meta: {
            driver: migrationDriver.executionDriver.driverName,
            command,
            target: formatMigrationTarget(target, migrationDriver.namespace),
          },
        }
      );
    }
  }

  if (migrationDriver.namespace === undefined) {
    throw new MigrationError(
      `${command} needs a live MySQL database and this client's adapter is unbound. ` +
        "MySQL migration artifacts are database-relative on purpose, so the live destination comes from the driver's `namespace` — supply it explicitly, in the connection URL, or through the driver's database option.",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      {
        meta: {
          driver: migrationDriver.executionDriver.driverName,
          command,
          target: formatMigrationTarget(target),
        },
      }
    );
  }
}

/**
 * Refuses an effectful PostgreSQL command on a transport with no interactive
 * session.
 *
 * Neon's HTTP driver is the shipped case: it speaks a stateless request/reply
 * API, so a `pg_advisory_lock` it issued would be acquired by one request and
 * could never be released by another — the lock would be neither held for the
 * work nor released after it. Every path that mutates, or that makes a
 * concurrency-stable decision from live state, is therefore refused HERE:
 * before the connection, before storage writes, and before any other provider
 * work. Its qualified runtime, read-only introspection, status/log, push
 * dry-run, and every offline path stay available.
 *
 * The answer is the driver's own `_canPinSession()` — the presence of its
 * pinned-session hook — so nothing declares a capability it does not implement,
 * and a custom PostgreSQL driver is judged by the same fact as a stock one.
 */
function admitSqliteFamilyCapability(
  migrationDriver: BoundMigrationDriver,
  requirement: MigrationLiveRequirement,
  command: string
): void {
  if (requirement !== "effectful") {
    return;
  }
  const driverName = migrationDriver.executionDriver.driverName;
  if (driverName === "d1" || driverName === "d1-http") {
    throw new MigrationError(
      `${command} cannot claim effectful V1 migration support on "${driverName}": table recreation, foreign-key handling, native-batch atomicity, and marker CAS are not proven together. ` +
        "Generation, check, and read-only status remain available.",
      VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      {
        meta: {
          driver: driverName,
          command,
          target: formatMigrationTarget(migrationDriver.target),
        },
      }
    );
  }
  if (driverName === "libsql") {
    throw new MigrationError(
      `${command} cannot claim V1 constraint alteration on libsql: existing rows are not prevalidated and table reconstruction is not proven. ` +
        "Generation, check, and read-only status remain available.",
      VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      {
        meta: {
          driver: driverName,
          command,
          target: formatMigrationTarget(migrationDriver.target),
        },
      }
    );
  }
}

function admitPinnedSessionCapability(
  migrationDriver: BoundMigrationDriver,
  requirement: MigrationLiveRequirement,
  command: string
): void {
  if (requirement !== "effectful") {
    return;
  }
  if (migrationDriver.executionDriver._canPinSession()) {
    return;
  }
  throw new MigrationError(
    `${command} needs one physical database session it can hold a migration lock on, and the driver "${migrationDriver.executionDriver.driverName}" has no interactive session to reserve. ` +
      "Effectful and concurrency-stable live migration work is refused: a session-scoped lock taken over a stateless transport would be acquired by one request and released by another, so it would protect nothing. Runtime queries, introspection, status, log, push dry-run and every offline command remain available.",
    VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    {
      meta: {
        driver: migrationDriver.executionDriver.driverName,
        command,
        target: formatMigrationTarget(migrationDriver.target),
      },
    }
  );
}
