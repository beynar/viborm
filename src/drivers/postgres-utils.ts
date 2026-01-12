/**
 * PostgreSQL Driver Utilities
 *
 * Shared utilities for PostgreSQL-compatible drivers (pg, postgres.js, PGlite).
 */

import type { Sql } from "@sql";

/**
 * Build a PostgreSQL statement with $1, $2, etc. placeholders
 *
 * Converts a Sql template into a parameterized PostgreSQL query string.
 *
 * @example
 * const query = sql`SELECT * FROM users WHERE id = ${id} AND name = ${name}`;
 * buildPostgresStatement(query);
 * // Returns: "SELECT * FROM users WHERE id = $1 AND name = $2"
 */
export function buildPostgresStatement(query: Sql): string {
  const len = query.strings.length;
  let i = 1;
  let result = query.strings[0] ?? "";
  while (i < len) {
    result += `$${i}${query.strings[i] ?? ""}`;
    i++;
  }
  return result;
}
