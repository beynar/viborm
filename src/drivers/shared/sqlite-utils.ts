/**
 * Shared SQLite Utilities
 *
 * Common result parser and parameter conversion for SQLite-based drivers.
 */

import { parseIntegerBoolean } from "@adapters/shared/result-parsing";
import type { DriverResultParser } from "../driver";
import { getExecutionTransactionPhases } from "../execution-context";
import type { QueryExecutionContext } from "../types";
import type { TransactionOptionSupport } from "./transaction-options";
import { runTransactionLifecycle } from "./transactions";

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

/**
 * SQLite has no isolation-level statement: one writer at a time on one
 * connection makes every transaction serializable already. `Serializable` is
 * therefore honored by construction, with no SQL to emit; the three weaker
 * levels are refused because pretending to relax isolation we cannot relax
 * would misreport what the transaction actually guarantees.
 */
export const LOCAL_SQLITE_TRANSACTION_SUPPORT: TransactionOptionSupport =
  Object.freeze({
    isolationLevel: "serializable-only",
    isolationLevelReason:
      "SQLite serializes transactions on a single connection and has no statement to weaken isolation, so only Serializable can be honored truthfully",
    timeout: true,
    maxWait: "queue",
  });

/** One transaction on a local, synchronous, single-connection SQLite handle. */
export function runLocalSQLiteTransaction<
  Client extends {
    exec(sql: string): unknown;
    readonly inTransaction: boolean;
  },
  T,
>(
  client: Client,
  fn: (tx: Client) => Promise<T>,
  context: QueryExecutionContext | undefined
): Promise<T> {
  return runTransactionLifecycle({
    begin: () => client.exec("BEGIN IMMEDIATE"),
    callback: () => fn(client),
    commit: () => client.exec("COMMIT"),
    // A failed BEGIN never grants rollback ownership. After a failed COMMIT,
    // successful rollback restores this same database, including :memory:.
    rollback: () => {
      if (client.inTransaction) client.exec("ROLLBACK");
    },
    phases: getExecutionTransactionPhases(context),
  });
}
