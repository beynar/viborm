/**
 * A connection string → the stock VibORM driver for it.
 *
 * The scheme names the driver, and the driver is constructed exactly as its
 * own `createClient` constructs it (`databaseUrl` / `dataDir`). Each driver
 * module is imported on demand, so only the provider package the URL names is
 * loaded — introspecting PostgreSQL never requires `better-sqlite3`.
 */

import type { AnyDriver } from "../../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../../errors";
import type { IntrospectionDialect } from "./types";

export interface OpenedDriver {
  readonly driver: AnyDriver;
  readonly dialect: IntrospectionDialect;
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const SQLITE_FILE = /\.(?:db|sqlite3?|db3)$/i;

/** A SQLite path from `file:` / `sqlite:` URLs, or a bare database file. */
function sqlitePath(url: string): string | undefined {
  for (const prefix of ["sqlite://", "sqlite:", "file://", "file:"]) {
    if (url.startsWith(prefix)) return url.slice(prefix.length);
  }
  return SCHEME.test(url) ? undefined : url;
}

export async function openDriver(url: string): Promise<OpenedDriver> {
  const scheme = SCHEME.exec(url)?.[1]?.toLowerCase();
  if (scheme === "postgres" || scheme === "postgresql") {
    const { PgDriver } = await import("../../drivers/pg");
    return {
      driver: new PgDriver({ databaseUrl: url, options: {} }),
      dialect: "postgresql",
    };
  }
  if (
    scheme === "libsql" ||
    scheme === "http" ||
    scheme === "https" ||
    scheme === "ws" ||
    scheme === "wss"
  ) {
    const { LibSQLDriver } = await import("../../drivers/libsql");
    const parsed = new URL(url);
    const authToken = parsed.searchParams.get("authToken") ?? undefined;
    parsed.searchParams.delete("authToken");
    return {
      driver: new LibSQLDriver({
        databaseUrl: parsed.href,
        ...(authToken === undefined ? {} : { authToken }),
      }),
      dialect: "sqlite",
    };
  }
  if (scheme === "mssql" || scheme === "sqlserver") {
    const { MssqlDriver } = await import("../../drivers/mssql");
    return { driver: new MssqlDriver({ databaseUrl: url }), dialect: "mssql" };
  }
  if (scheme === "mysql") {
    const { MySQL2Driver } = await import("../../drivers/mysql2");
    return { driver: new MySQL2Driver({ databaseUrl: url }), dialect: "mysql" };
  }
  if (scheme === "surrealdb" || scheme === "surreal")
    throw new MigrationError(
      "introspectSchema does not translate SurrealDB yet; PostgreSQL, SQLite, MySQL and SQL Server are supported.",
      VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      { meta: { feature: "introspect-schema" } }
    );
  const path = sqlitePath(url);
  if (
    path !== undefined &&
    (scheme !== undefined || SQLITE_FILE.test(path) || path === ":memory:")
  ) {
    const { SQLite3Driver } = await import("../../drivers/sqlite3");
    // Read-only, and only an existing file: introspection never creates a
    // database it was asked to read.
    return {
      driver: new SQLite3Driver({
        dataDir: path,
        options: { readonly: true, fileMustExist: true },
      }),
      dialect: "sqlite",
    };
  }
  throw new MigrationError(
    `introspectSchema cannot tell which database "${scheme ?? url}" names. Use postgres:// or postgresql:// for PostgreSQL, mysql:// for MySQL, mssql:// or sqlserver:// for SQL Server, file: or sqlite: (or a .db / .sqlite file) for SQLite, and libsql:// for libSQL; or pass a driver.`,
    VibORMErrorCode.INVALID_INPUT,
    { meta: { feature: "introspect-url" } }
  );
}
