/**
 * Shared SQLite Utilities
 *
 * Common result parser and parameter conversion for SQLite-based drivers.
 */

import {
  normalizeCountResult,
  parseIntegerBoolean,
  tryParseJsonString,
} from "@adapters/shared/result-parsing";
import type { DriverResultParser } from "../driver";

/**
 * Convert JavaScript values to SQLite-compatible values.
 * - Booleans become 0/1
 * - undefined becomes null
 */
export function convertValuesForSQLite(values: unknown[]): unknown[] {
  return values.map((v) => {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v === undefined) return null;
    return v;
  });
}

/**
 * Shared result parser for SQLite drivers.
 * Handles:
 * - COUNT normalization (BigInt -> number)
 * - JSON string parsing for relations
 * - Boolean integer parsing (0/1 -> false/true)
 */
export const sqliteResultParser: DriverResultParser = {
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
