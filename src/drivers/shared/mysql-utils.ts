/**
 * Shared MySQL Utilities
 *
 * Shared connection utilities for MySQL-based drivers.
 */

/**
 * Parse a MySQL database URL into connection options.
 */
export interface MySQLConnectionOptions {
  host: string;
  port: number;
  /** Absent when the URL carries no database path. */
  database?: string;
  user?: string;
  password?: string;
}

export function parseMySQLUrl(url: string): MySQLConnectionOptions {
  const parsed = new URL(url);
  const database = parsed.pathname.slice(1);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 3306,
    // A pathless URL selects no database. The key stays absent so merging this
    // over connection options cannot replace a configured database with "".
    ...(database === "" ? {} : { database }),
    user: parsed.username || undefined,
    password: parsed.password || undefined,
  };
}
