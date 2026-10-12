/**
 * Shared MySQL Utilities
 *
 * Shared connection utilities for MySQL-based drivers.
 */

import { ClientInitializationError } from "@errors";

/**
 * The connection options a MySQL database URL carries: only the keys it
 * spells, so merged under a caller's options it fills what they left out
 * instead of replacing it with `undefined` or a default port.
 */
export interface MySQLConnectionOptions {
  [option: string]: unknown;
  ssl?: object | string;
  host: string;
  port?: number;
  /** Absent when the URL carries no database path. */
  database?: string;
  user?: string;
  password?: string;
}

const TLS_URL_OPTION_PATTERN = /^(?:ssl|tls)/i;

/**
 * A TLS request VibORM cannot honour. Its own text, which carries no part of
 * the URL, so the driver surfaces it rather than redacting it.
 */
function tlsRefusal(message: string): ClientInitializationError {
  return new ClientInitializationError(message, {
    meta: { driver: "mysql2", operation: "configuration" },
  });
}

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
      throw tlsRefusal(
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
      throw tlsRefusal(
        "Unsupported MySQL sslmode; configure options.ssl explicitly."
      );
    }
    if (
      queryOptions.ssl !== undefined &&
      (queryOptions.ssl === null ||
        (typeof queryOptions.ssl !== "object" &&
          typeof queryOptions.ssl !== "string"))
    )
      throw tlsRefusal("MySQL sslmode requires a TLS configuration");
    queryOptions.ssl ??= {};
  }
  Reflect.deleteProperty(queryOptions, "sslmode");
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  return {
    host: parsed.hostname,
    ...(parsed.port ? { port: Number.parseInt(parsed.port, 10) } : {}),
    ...(database === "" ? {} : { database }),
    ...(user === "" ? {} : { user }),
    ...(password === "" ? {} : { password }),
    ...queryOptions,
  };
}
