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

export type SQLiteBinaryValue = ArrayBuffer | ArrayBufferView;

export function isSQLiteBinaryValue(
  value: unknown
): value is SQLiteBinaryValue {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

export function sqliteBinaryToUint8Array(value: SQLiteBinaryValue): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Convert provider-neutral scalar values to SQLite values. Binary values stay
 * in their standard Web API form; each provider owns any narrower conversion.
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
  parseField: (value, scalarType, next) => {
    if (scalarType === "boolean") {
      const parsed = parseIntegerBoolean(value);
      if (parsed !== undefined) return next(parsed, scalarType);
    }
    // SQLite stores json as TEXT — decode here where we know the string is
    // serialized JSON (the default parser never sniffs json strings)
    if (scalarType === "json" && typeof value === "string") {
      return next(JSON.parse(value), scalarType);
    }
    return next(value, scalarType);
  },
};
