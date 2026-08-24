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
  database: string;
  user?: string;
  password?: string;
}

export function parseMySQLUrl(url: string): MySQLConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 3306,
    database: parsed.pathname.slice(1),
    user: parsed.username || undefined,
    password: parsed.password || undefined,
  };
}
