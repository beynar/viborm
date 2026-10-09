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
export function convertValueForSQLite(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

export function convertValuesForSQLite(values: unknown[]): unknown[] {
  return values.map(convertValueForSQLite);
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
  parseField: parseSQLiteField,
};

/**
 * The shipped parser's own field hook. `sqliteResultParser` is one mutable
 * object every SQLite-family driver shares, so a driver that must recognise
 * the shipped parser compares against this definition, never against what the
 * shared object holds when its module loads. The shipped parser defines no
 * `parseRelation` or `parseResult`.
 */
export function parseSQLiteField(
  value: unknown,
  scalarType: string,
  next: (value: unknown, scalarType: string) => unknown
): unknown {
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
}

/** Raw INTEGER leaves retain exact values; only safe-range values become numbers. */
export function normalizeSQLiteRawRows<T>(rows: T[]): T[] {
  return rows.map((row) => {
    if (row === null || typeof row !== "object") return row;
    const normalized = { ...row };
    for (const key of Object.keys(normalized)) {
      const value: unknown = Reflect.get(normalized, key);
      if (
        typeof value === "bigint" &&
        value >= BigInt(Number.MIN_SAFE_INTEGER) &&
        value <= BigInt(Number.MAX_SAFE_INTEGER)
      )
        Reflect.set(normalized, key, Number(value));
    }
    return normalized;
  });
}

const STATEMENT_CACHE_LIMIT = 100;

/**
 * Compiling SQL costs about as much as running a small read (~4 µs), and the
 * engine emits the same text for the same query shape, so each database keeps
 * its recent statements. A statement's modes are its own state: a driver whose
 * paths set different modes keeps one cache per path. Only a stock `prepare`,
 * as `stockPrepare` names it for a database, is reused; a database whose
 * `prepare` was replaced sees every call. Oldest-first eviction bounds the
 * native memory held.
 */
export function createStatementCache<
  Statement,
  Database extends { prepare(sql: string): Statement },
>(
  stockPrepare: (db: Database) => unknown
): (db: Database, sql: string) => Statement {
  const caches = new WeakMap<Database, Map<string, Statement>>();
  return (db, sql) => {
    if (db.prepare !== stockPrepare(db)) return db.prepare(sql);
    let cache = caches.get(db);
    if (!cache) {
      cache = new Map();
      caches.set(db, cache);
    }
    let statement = cache.get(sql);
    if (statement === undefined) {
      statement = db.prepare(sql);
      if (cache.size === STATEMENT_CACHE_LIMIT)
        cache.delete(cache.keys().next().value as string);
    } else {
      cache.delete(sql);
    }
    cache.set(sql, statement);
    return statement;
  };
}
