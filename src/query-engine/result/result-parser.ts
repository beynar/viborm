/**
 * Result Parser
 *
 * Transforms raw database rows into typed objects.
 * Handles JSON parsing for MySQL/SQLite and null coalescing.
 */

import type { Operation, QueryContext } from "../types";

/**
 * Parse query result based on operation type
 *
 * @param ctx - Query context
 * @param operation - The operation that was executed
 * @param raw - Raw database result
 * @returns Parsed and typed result
 */
export function parseResult<T>(
  ctx: QueryContext,
  operation: Operation,
  raw: unknown
): T {
  // Handle null/undefined
  if (raw === null || raw === undefined) {
    return getDefaultResult(operation) as T;
  }

  // Handle exist operation - convert count to boolean
  if (operation === "exist") {
    const count = parseCountResult(raw);
    const hasRecords =
      typeof count === "number"
        ? count > 0
        : Object.values(count).some((v) => v > 0);
    return hasRecords as T;
  }

  // Handle array results
  if (Array.isArray(raw)) {
    // For operations that return single records
    if (isSingleRecordOperation(operation)) {
      const first = raw[0];
      if (!first) {
        return null as T;
      }
      return parseRow(ctx, first) as T;
    }

    // For operations that return arrays
    return raw.map((row) => parseRow(ctx, row)) as T;
  }

  // Single row result
  if (typeof raw === "object") {
    return parseRow(ctx, raw as Record<string, unknown>) as T;
  }

  // Scalar result (count, etc.)
  return raw as T;
}

/**
 * Parse a single row, handling JSON columns
 */
function parseRow(
  ctx: QueryContext,
  row: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    result[key] = parseValue(value);
  }

  return result;
}

/**
 * Parse a single value, handling JSON strings and BigInt
 */
function parseValue(value: unknown): unknown {
  // Null passthrough
  if (value === null || value === undefined) {
    return null;
  }

  // Handle BigInt - keep as BigInt to preserve precision for large values
  // Users can convert to Number if needed for smaller values
  if (typeof value === "bigint") {
    return value;
  }

  // Try to parse JSON strings (MySQL/SQLite may return JSON as strings)
  if (typeof value === "string") {
    // Check if it looks like JSON
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(value);
      } catch {
        // Not valid JSON, return as-is
        return value;
      }
    }
    return value;
  }

  // Already parsed object (PostgreSQL returns JSON as objects)
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      return value.map(parseValue);
    }
    // Recursively parse nested objects
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = parseValue(v);
    }
    return result;
  }

  // Primitive values
  return value;
}

/**
 * Check if operation returns a single record (vs array)
 */
function isSingleRecordOperation(operation: Operation): boolean {
  return [
    "findFirst",
    "findUnique",
    "create",
    "update",
    "delete",
    "upsert",
  ].includes(operation);
}

/**
 * Get default result for empty results based on operation
 */
function getDefaultResult(operation: Operation): unknown {
  switch (operation) {
    case "findFirst":
    case "findUnique":
    case "create":
    case "update":
    case "delete":
    case "upsert":
      return null;

    case "findMany":
      return [];

    case "createMany":
    case "updateMany":
    case "deleteMany":
      return { count: 0 };

    case "count":
      return 0;

    case "aggregate":
    case "groupBy":
      return {};

    case "exist":
      return false;

    default:
      return null;
  }
}

/**
 * Parse count result
 */
export function parseCountResult(
  raw: unknown
): number | Record<string, number> {
  if (raw === null || raw === undefined) {
    return 0;
  }

  // Single count value
  if (typeof raw === "number") {
    return raw;
  }

  // BigInt from database
  if (typeof raw === "bigint") {
    return Number(raw);
  }

  // Array with single row containing count
  if (Array.isArray(raw) && raw.length > 0) {
    const firstRow = raw[0];
    if (typeof firstRow === "object" && firstRow !== null) {
      // Multiple counts (with select)
      const result: Record<string, number> = {};
      for (const [key, value] of Object.entries(firstRow)) {
        result[key] = typeof value === "bigint" ? Number(value) : Number(value);
      }
      return result;
    }
  }

  // Object with count(s)
  if (typeof raw === "object" && raw !== null) {
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      result[key] = typeof value === "bigint" ? Number(value) : Number(value);
    }
    return result;
  }

  return 0;
}

/**
 * Parse mutation result to get affected count
 */
export function parseMutationCount(raw: unknown): { count: number } {
  if (raw === null || raw === undefined) {
    return { count: 0 };
  }

  // Direct count
  if (typeof raw === "number") {
    return { count: raw };
  }

  // Object with count or rowCount
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if ("count" in obj) {
      return { count: Number(obj.count) };
    }
    if ("rowCount" in obj) {
      return { count: Number(obj.rowCount) };
    }
    if ("affectedRows" in obj) {
      return { count: Number(obj.affectedRows) };
    }
  }

  return { count: 0 };
}
