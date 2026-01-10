/**
 * Result Parser
 *
 * Transforms raw database rows into typed objects.
 * Handles JSON parsing for MySQL/SQLite and null coalescing.
 * Applies schema-aware type conversion for relation data (datetime, bigint).
 */

import type { Field } from "@schema/fields";
import type { AnyRelation } from "@schema/relation";
import { isBatchOperation, type Operation, type QueryContext } from "../types";

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

  // Handle count operation - return number or object with counts
  if (operation === "count") {
    return parseCountResult(raw) as T;
  }

  // Handle batch operations - return { count: number }
  if (isBatchOperation(operation)) {
    return parseMutationCount(raw) as T;
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
 * Parse a single row, using schema info for type-aware conversion
 */
function parseRow(
  ctx: QueryContext,
  row: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const model = ctx.model;
  const scalars = model["~"].state.scalars;
  const relations = model["~"].state.relations;

  for (const [key, value] of Object.entries(row)) {
    // Check if this is a scalar field with a known type
    const field = scalars[key];
    if (field) {
      const fieldType = field["~"].state.type;
      result[key] = parseTypedValue(value, fieldType);
    } else if (relations[key]) {
      // It's a relation - parse with target model schema
      result[key] = parseRelationValue(relations[key], value);
    } else {
      // Unknown field - parse generically
      result[key] = parseValue(value);
    }
  }

  return result;
}

/**
 * Parse a value with knowledge of its expected type
 */
function parseTypedValue(value: unknown, fieldType: string): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  // Handle arrays - apply typed conversion to each element
  if (Array.isArray(value)) {
    return value.map((item) => parseTypedValue(item, fieldType));
  }

  switch (fieldType) {
    case "datetime":
    case "date":
      // Convert ISO strings to Date objects
      if (value instanceof Date) return value;
      if (typeof value === "string" || typeof value === "number") {
        return new Date(value);
      }
      return value;

    case "bigint":
      // Convert numbers/strings to BigInt
      if (typeof value === "bigint") return value;
      if (typeof value === "number" || typeof value === "string") {
        return BigInt(value);
      }
      return value;

    case "time":
      // Time stays as string
      if (typeof value === "string") return value;
      return String(value);

    default:
      return parseValue(value);
  }
}

/**
 * Parse relation values (nested objects from json_agg)
 */
function parseRelationValue(relation: AnyRelation, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  // Get target model from relation thunk
  const targetModel = relation["~"].state.getter();
  const targetScalars = targetModel["~"].state.scalars;
  const targetRelations = targetModel["~"].state.relations;

  if (Array.isArray(value)) {
    // To-many relation - deserialize each item
    return value.map((item) =>
      deserializeWithSchema(
        item as Record<string, unknown>,
        targetScalars,
        targetRelations
      )
    );
  }

  if (typeof value === "object") {
    // To-one relation
    return deserializeWithSchema(
      value as Record<string, unknown>,
      targetScalars,
      targetRelations
    );
  }

  return value;
}

/**
 * Deserialize an object using schema information
 */
function deserializeWithSchema(
  obj: Record<string, unknown>,
  scalars: Record<string, Field>,
  relations: Record<string, AnyRelation>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const field = scalars[key];
    if (field) {
      result[key] = parseTypedValue(value, field["~"].state.type);
    } else if (relations[key]) {
      // Nested relation - recursive
      result[key] = parseRelationValue(relations[key], value);
    } else {
      result[key] = parseValue(value);
    }
  }

  return result;
}

/**
 * Parse a single value, handling JSON strings and BigInt
 * (Generic parser for unknown fields)
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
    // Preserve Date objects - they have no enumerable properties
    // so Object.entries would return empty array
    if (value instanceof Date) {
      return value;
    }

    // Preserve Buffer/Uint8Array for blob fields
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(parseValue);
    }

    // Recursively parse nested objects (JSON fields, etc.)
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
    "aggregate", // aggregate returns a single row with aggregate values
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
 *
 * Returns a plain number for simple count, or an object with multiple counts
 * when using select (e.g., { _all: 5, name: 4 })
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

  // Array with single row containing count(s)
  if (Array.isArray(raw) && raw.length > 0) {
    const firstRow = raw[0];
    if (typeof firstRow === "object" && firstRow !== null) {
      const entries = Object.entries(firstRow);
      // Simple count: single "count" key -> return just the number
      if (entries.length === 1 && entries[0][0] === "count") {
        const value = entries[0][1];
        return typeof value === "bigint" ? Number(value) : Number(value);
      }
      // Multiple counts (with select) -> return object
      const result: Record<string, number> = {};
      for (const [key, value] of entries) {
        result[key] = typeof value === "bigint" ? Number(value) : Number(value);
      }
      return result;
    }
  }

  // Object with count(s)
  if (typeof raw === "object" && raw !== null) {
    const entries = Object.entries(raw as Record<string, unknown>);
    // Simple count: single "count" key -> return just the number
    if (entries.length === 1 && entries[0][0] === "count") {
      const value = entries[0][1];
      return typeof value === "bigint" ? Number(value) : Number(value);
    }
    // Multiple counts -> return object
    const result: Record<string, number> = {};
    for (const [key, value] of entries) {
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
