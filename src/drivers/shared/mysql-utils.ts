/**
 * Shared MySQL Utilities
 *
 * Shared connection utilities for MySQL-based drivers.
 */

/**
 * Parse a MySQL database URL into connection options.
 */
export interface MySQLConnectionOptions {
  [option: string]: unknown;
  ssl?: object | string;
  host: string;
  port: number;
  /** Absent when the URL carries no database path. */
  database?: string;
  user?: string;
  password?: string;
}

const TLS_URL_OPTION_PATTERN = /^(?:ssl|tls)/i;

export function parseMySQLUrl(url: string): MySQLConnectionOptions {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  const queryOptions: Record<string, unknown> = {};
  for (const [key, value] of parsed.searchParams) {
    if (
      TLS_URL_OPTION_PATTERN.test(key) &&
      key !== "ssl" &&
      key !== "sslmode"
    ) {
      throw new TypeError(
        "Unsupported MySQL TLS URL option; configure options.ssl explicitly."
      );
    }
    try {
      queryOptions[key] = JSON.parse(value);
    } catch {
      queryOptions[key] = value;
    }
  }
  // mysql2 understands ssl, but not libpq's sslmode. Refuse a TLS request
  // whose policy cannot be represented instead of silently opening plaintext.
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode && sslmode !== "disable") {
    if (!["require", "verify-ca", "verify-full"].includes(sslmode)) {
      throw new TypeError(
        "Unsupported MySQL sslmode; configure options.ssl explicitly."
      );
    }
    if (
      queryOptions.ssl !== undefined &&
      (queryOptions.ssl === null ||
        (typeof queryOptions.ssl !== "object" &&
          typeof queryOptions.ssl !== "string"))
    )
      throw new TypeError("MySQL sslmode requires a TLS configuration");
    queryOptions.ssl ??= {};
  }
  Reflect.deleteProperty(queryOptions, "sslmode");
  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 3306,
    // A pathless URL selects no database. The key stays absent so merging this
    // over connection options cannot replace a configured database with "".
    ...(database === "" ? {} : { database }),
    user: decodeURIComponent(parsed.username) || undefined,
    password: decodeURIComponent(parsed.password) || undefined,
    ...queryOptions,
  };
}
