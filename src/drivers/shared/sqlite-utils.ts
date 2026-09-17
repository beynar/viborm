/**
 * Shared SQLite Utilities
 *
 * Common result parser and parameter conversion for SQLite-based drivers.
 */

import { parseIntegerBoolean } from "@adapters/shared/result-parsing";
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
 * Shared result parser for the SQLite drivers. It speaks about ROW VALUES only:
 * - Boolean integer parsing (0/1 -> false/true)
 * - `json` columns, which SQLite stores as TEXT
 *
 * It says nothing about a RESULT (Arnaud's D-35). A SQLite transport answers a
 * `count`/`exist` in the shape the engine's own projection asked for — the
 * engine aliases that column `_count` and reads `_count` back — so the meaning
 * of a count and an exists answer has one authority, the engine's decoder, and
 * this middleware has nothing to add at the result boundary. Recovering a count
 * from a provider that did NOT preserve the alias is a dialect fact, stated
 * once at the adapter seam by the provider that needs it (MySQL).
 */
export const sqliteResultParser: DriverResultParser = {
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
