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
 * The private column name a COUNT result carries in a RESULT SHAPE.
 *
 * It names a shape's single raw key, never a provider's row: its readers are
 * `query-engine/result/result-shape.ts` and `client/typescript-type-renderer.ts`,
 * both over DECODED values. A live row's
 * count arrives under the alias the engine asked for (`_count`), which the
 * engine's own decoder reads back (Arnaud's D-40).
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
