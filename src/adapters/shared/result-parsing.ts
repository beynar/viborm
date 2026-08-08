import { isRecord } from "@validation/value-guards";

/**
 * Shared Result Parsing Utilities
 *
 * Common parsing logic used by adapters for database-specific type conversions.
 * These utilities use `undefined` as a sentinel to indicate "not handled" -
 * allowing the caller to fall through to default parsing.
 *
 * @example
 * const parsed = tryParseJsonString(value);
 * if (parsed !== undefined) {
 *   // Use parsed value
 * } else {
 *   // Fall through to default
 * }
 */

/**
 * Normalized column name for COUNT results.
 * Used by adapters to normalize database-specific column names.
 */
export const COUNT_RESULT_KEY = "0viborm_count_result" as const;

/**
 * Parse JSON string values (MySQL/SQLite return JSON as strings).
 *
 * @param value - Raw value from database
 * @returns Parsed JSON object/array, or `undefined` if not a JSON string
 *
 * @example
 * tryParseJsonString('[1,2,3]')     // [1, 2, 3]
 * tryParseJsonString('{"a":1}')    // { a: 1 }
 * tryParseJsonString('hello')      // undefined (not JSON)
 * tryParseJsonString(123)          // undefined (not a string)
 * tryParseJsonString('[invalid')   // undefined (invalid JSON)
 */
export function tryParseJsonString(value: unknown): unknown | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Convert SQLite/MySQL integer to boolean.
 * These databases store booleans as 0/1 integers.
 *
 * @param value - Raw value from database
 * @returns `true` for 1, `false` for 0, `null` for null/undefined,
 *          or `undefined` if value is not an integer (fall through to default)
 *
 * @example
 * parseIntegerBoolean(1)         // true
 * parseIntegerBoolean(0)         // false
 * parseIntegerBoolean(null)      // null
 * parseIntegerBoolean('true')    // undefined (not handled, fall through)
 */
export function parseIntegerBoolean(
  value: unknown
): boolean | null | undefined {
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  // SQLite drivers read integers safely (BigInt), including boolean columns
  if (typeof value === "bigint") {
    if (value === 1n) return true;
    if (value === 0n) return false;
    return undefined;
  }
  if (value === null || value === undefined) {
    return null;
  }
  return undefined;
}

/**
 * Convert BigInt to Number.
 * PostgreSQL returns COUNT as bigint, which needs conversion.
 *
 * @param value - Raw value from database
 * @returns Number if value is bigint, or `undefined` to fall through
 *
 * @example
 * convertBigIntToNumber(5n)      // 5
 * convertBigIntToNumber(123)     // undefined (already a number)
 */
export function convertBigIntToNumber(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return undefined;
}

/**
 * Normalize COUNT result column name.
 * VibORM aliases simple COUNT queries with an identifier that model schemas
 * cannot define. Raw COUNT expressions are also recognized for providers that
 * do not preserve the SQL alias.
 *
 * This normalizes to `{ [COUNT_RESULT_KEY]: N }` for consistent parsing.
 *
 * @param raw - Raw database result (array or object)
 * @returns Normalized result with the private count key, or `undefined` if not a COUNT result
 *
 * @example
 * normalizeCountResult([{ 'COUNT(*)': 5 }])  // [{ '0viborm_count_result': 5 }]
 * normalizeCountResult([{ count: 5 }])       // undefined (valid model scalar)
 * normalizeCountResult([{ name: 'Alice' }])  // undefined (not a COUNT)
 */
export function normalizeCountResult(
  raw: unknown
): [{ [COUNT_RESULT_KEY]: unknown }] | undefined {
  // Handle array with single row
  if (Array.isArray(raw) && raw.length === 1) {
    const firstRow = raw[0];
    if (typeof firstRow === "object" && firstRow !== null) {
      const countValue = extractCountValue(firstRow as Record<string, unknown>);
      if (countValue !== undefined) {
        return [{ [COUNT_RESULT_KEY]: countValue }];
      }
    }
  }

  // Handle single object
  if (isRecord(raw)) {
    const countValue = extractCountValue(raw);
    if (countValue !== undefined) {
      return [{ [COUNT_RESULT_KEY]: countValue }];
    }
  }

  return undefined;
}

/**
 * Extract count value from a result row, checking common column names.
 * Case-insensitive to handle variations across databases.
 */
function extractCountValue(row: Record<string, unknown>): unknown | undefined {
  const entries = Object.entries(row);
  if (entries.length !== 1) {
    return undefined;
  }

  const [entry] = entries;
  if (!entry) {
    return undefined;
  }

  const [key, value] = entry;
  if (key === COUNT_RESULT_KEY || key.toLowerCase().startsWith("count(")) {
    return value;
  }

  return undefined;
}
