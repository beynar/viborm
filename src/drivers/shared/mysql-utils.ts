/**
 * Shared MySQL Utilities
 *
 * Common result parser for MySQL-based drivers.
 */

import {
  normalizeCountResult,
  parseIntegerBoolean,
  tryParseJsonString,
} from "@adapters/shared/result-parsing";
import type { DriverResultParser } from "../driver";

/**
 * Shared result parser for MySQL drivers.
 * Handles:
 * - COUNT normalization (BigInt -> number)
 * - JSON string parsing for relations
 * - Boolean integer parsing (0/1 -> false/true)
 */
export const mysqlResultParser: DriverResultParser = {
  parseResult: (raw, operation, next) => {
    if (operation === "count" || operation === "exist") {
      const normalized = normalizeCountResult(raw);
      if (normalized !== undefined) return next(normalized, operation);
    }
    return next(raw, operation);
  },
  parseRelation: (value, type, next) => {
    const parsed = tryParseJsonString(value);
    if (parsed !== undefined) return next(parsed, type);
    return next(value, type);
  },
  parseField: (value, fieldType, next) => {
    if (fieldType === "boolean") {
      const parsed = parseIntegerBoolean(value);
      if (parsed !== undefined) return parsed;
    }
    return next(value, fieldType);
  },
};

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
