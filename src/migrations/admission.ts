/**
 * Live-capability admission
 *
 * ONE decision admits a migration command to live database state. Direct
 * `push()` and every high-level migration command reach it here; no command
 * reinterprets either fact for itself.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import type { BoundMigrationDriver } from "./drivers";
import { canPinSession } from "./pinned-session";
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
 * Admits effectful SQLite work only on a driver that declared the migration
 * capability.
 *
 * The declaration was read once when the driver was bound (`getMigrationDriver`,
 * where it also chose the implementation); this is where it decides. Stock
 * sqlite3 and bun-sqlite declare it; D1 and libSQL do not, and stay refused for
 * effectful work while generation, check and read-only status stay available.
 * Whether the driver runs callback transactions is its `supportsTransactions`,
 * which each command already reads for its own transaction shape.
 */
function admitSqliteFamilyCapability(
  migrationDriver: BoundMigrationDriver,
  requirement: MigrationLiveRequirement,
  command: string
): void {
  if (
    requirement !== "effectful" ||
    migrationDriver.sqliteMigrationCapability !== undefined
  ) {
    return;
  }
  const { driverName } = migrationDriver.executionDriver;
  throw new MigrationError(
    `${command} is refused: the SQLite driver "${driverName}" declares no \`sqliteMigrationCapability\`. Generation, check and status remain available.`,
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

/**
 * Refuses an effectful PostgreSQL command on a transport that cannot hold a
 * session lock for it.
 *
 * Neon's HTTP driver is the shipped case of a transport with no interactive
 * session: it speaks a stateless request/reply API, so a `pg_advisory_lock` it
 * issued would be acquired by one request and could never be released by
 * another — the lock would be neither held for the work nor released after it.
 * The answer is `canPinSession(driver)` — the presence of the driver's own
 * pinned-session hook — so nothing declares a capability it does not
 * implement, and a custom PostgreSQL driver is judged by the same fact as a
 * stock one.
 *
 * A transaction-pooling endpoint is the same failure behind an ordinary
 * session: Cloudflare Hyperdrive and Neon's `-pooler` endpoints hand
 * consecutive transactions to whichever server session is free, so the lock
 * is taken on one backend and the DDL runs on another. Those hosts, read from
 * the driver's own configuration, are refused unless the caller attests a
 * dedicated session, at their risk. Every path that mutates, or that makes a
 * concurrency-stable decision from live state, is refused HERE: before the
 * connection, before storage writes, and before any other provider work.
 * Application queries, read-only introspection, status/log, push dry-run, and
 * every offline path stay available.
 */
function admitPinnedSessionCapability(
  migrationDriver: BoundMigrationDriver,
  requirement: MigrationLiveRequirement,
  command: string
): void {
  if (requirement !== "effectful") {
    return;
  }
  const driver = migrationDriver.executionDriver;
  const meta = {
    driver: driver.driverName,
    command,
    target: formatMigrationTarget(migrationDriver.target),
  };
  if (!canPinSession(driver)) {
    throw new MigrationError(
      `${command} needs one physical database session it can hold a migration lock on, and the driver "${driver.driverName}" has no interactive session to reserve. ` +
        "Effectful and concurrency-stable live migration work is refused: a session-scoped lock taken over a stateless transport would be acquired by one request and released by another, so it would protect nothing. Runtime queries, introspection, status, log, push dry-run and every offline command remain available.",
      VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      { meta }
    );
  }
  if (driver.migrationSessionAttestation === "dedicated-session") {
    return;
  }
  const pooler = driver["migrationSessionEndpoints"]?.()
    .flatMap(endpointHosts)
    .find((host) => HYPERDRIVE_HOST.test(host) || NEON_POOLER_HOST.test(host));
  if (pooler === undefined) {
    return;
  }
  throw new MigrationError(
    `${command} is refused: "${pooler}" is a transaction pooler, which cannot hold the migration lock. Use the direct endpoint, or pass migrationSessionAttestation: "dedicated-session" at your own risk.`,
    VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    { meta }
  );
}

/** Cloudflare Hyperdrive's local endpoint, as a Worker binding names it. */
const HYPERDRIVE_HOST = /\.hyperdrive\.local\.?$/i;
/** A Neon endpoint id with the pooled-connection suffix. */
const NEON_POOLER_HOST = /^ep-[^.]*-pooler\./i;
/**
 * A URL's host list and query. Userinfo runs to the LAST `@` before the path,
 * as WHATWG URL (and so `pg-connection-string`) reads an unencoded `@`.
 */
const URL_PARTS =
  /^[a-z][a-z\d+.-]*:\/\/(?:[^/?#]*@)?([^/?#]*)[^?#]*\??([^#]*)/i;
const PORT = /:\d*$/;

/**
 * The host names one configured endpoint names, without ports: a bare host,
 * or every host of a (possibly multi-host) connection URL, including the
 * libpq `host` query parameter that overrides it.
 */
function endpointHosts(endpoint: unknown): string[] {
  if (typeof endpoint !== "string") return [];
  const url = URL_PARTS.exec(endpoint);
  const hosts = url
    ? [url[1] ?? "", ...new URLSearchParams(url[2]).getAll("host")]
    : [endpoint];
  return hosts.flatMap((list) =>
    list.split(",").map((host) => host.replace(PORT, ""))
  );
}
