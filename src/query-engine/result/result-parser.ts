/**
 * Result Parser
 *
 * Transforms raw database rows into typed objects.
 * Delegates database-specific parsing through a middleware chain:
 * Driver (optional) -> Adapter -> Default parsing
 *
 * Applies schema-aware type conversion for relation data (datetime, bigint).
 */

import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import type { Field } from "@schema/fields";
import type { AnyRelation } from "@schema/relation";
import type { RelationType } from "@schema/relation/types";
import { isBatchOperation, type Operation, type QueryContext } from "../types";

/**
 * Check if a key is a recognized count result column name.
 * Adapters normalize to COUNT_RESULT_KEY, but we also accept "count" for compatibility.
 */
function isCountKey(key: string): boolean {
  return key === COUNT_RESULT_KEY || key === "count";
}

/**
 * Create the chained parseResult function.
 * Chain: Driver (if present) -> Adapter -> Default
 */
function createParseResultChain(ctx: QueryContext) {
  // Default parsing (end of chain)
  const defaultParse = (value: unknown, op: Operation) =>
    parseResultDefault(ctx, op, value);

  // Adapter wraps default
  const adapterParse = (value: unknown, op: Operation) =>
    ctx.adapter.result.parseResult(value, op, (transformed) =>
      defaultParse(transformed ?? value, op)
    );

  // Driver wraps adapter (if driver has result parsing)
  if (ctx.driver?.result?.parseResult) {
    return (value: unknown, op: Operation) =>
      ctx.driver!.result!.parseResult!(value, op, adapterParse);
  }

  return adapterParse;
}

/**
 * Get or create the cached parseResult chain for this context
 */
function getParseResultChain(ctx: QueryContext) {
  return (ctx._parseResultChain ??= createParseResultChain(ctx));
}

/**
 * Create the chained parseRelation function.
 * Chain: Driver (if present) -> Adapter -> Default
 */
function createParseRelationChain(ctx: QueryContext, relation: AnyRelation) {
  const relationType = relation["~"].state.type;

  // Default parsing (end of chain)
  const defaultParse = (value: unknown, _type: RelationType) =>
    parseRelationValueDefault(ctx, relation, value);

  // Adapter wraps default
  const adapterParse = (value: unknown, type: RelationType) =>
    ctx.adapter.result.parseRelation(value, type, (transformed) =>
      defaultParse(transformed ?? value, type)
    );

  // Driver wraps adapter (if driver has result parsing)
  if (ctx.driver?.result?.parseRelation) {
    return (value: unknown) =>
      ctx.driver!.result!.parseRelation!(value, relationType, adapterParse);
  }

  return (value: unknown) => adapterParse(value, relationType);
}

/**
 * Get or create the cached parseRelation chain for a relation
 */
function getParseRelationChain(ctx: QueryContext, relationName: string, relation: AnyRelation) {
  ctx._parseRelationChains ??= new Map();
  let chain = ctx._parseRelationChains.get(relationName);
  if (!chain) {
    chain = createParseRelationChain(ctx, relation);
    ctx._parseRelationChains.set(relationName, chain);
  }
  return chain;
}

/**
 * Create the chained parseField function.
 * Chain: Driver (if present) -> Adapter -> Default
 */
function createParseFieldChain(ctx: QueryContext, fieldType: string) {
  // Default parsing (end of chain)
  const defaultParse = (value: unknown, _type: string) =>
    parseTypedValueDefault(value, fieldType);

  // Adapter wraps default
  const adapterParse = (value: unknown, type: string) =>
    ctx.adapter.result.parseField(value, type, (transformed) =>
      defaultParse(transformed ?? value, type)
    );

  // Driver wraps adapter (if driver has result parsing)
  if (ctx.driver?.result?.parseField) {
    return (value: unknown) =>
      ctx.driver!.result!.parseField!(value, fieldType, adapterParse);
  }

  return (value: unknown) => adapterParse(value, fieldType);
}

/**
 * Get or create the cached parseField chain for a field type
 */
function getParseFieldChain(ctx: QueryContext, fieldType: string) {
  ctx._parseFieldChains ??= new Map();
  let chain = ctx._parseFieldChains.get(fieldType);
  if (!chain) {
    chain = createParseFieldChain(ctx, fieldType);
    ctx._parseFieldChains.set(fieldType, chain);
  }
  return chain;
}

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

  // Use cached chained parsing: Driver -> Adapter -> Default
  const parse = getParseResultChain(ctx);
  return parse(raw, operation) as T;
}

/**
 * Default result parsing logic (called via adapter's next())
 */
function parseResultDefault(
  ctx: QueryContext,
  operation: Operation,
  raw: unknown
): unknown {
  // Handle exist operation - convert count to boolean
  if (operation === "exist") {
    const count = parseCountResultDefault(raw);
    const hasRecords =
      typeof count === "number"
        ? count > 0
        : Object.values(count).some((v) => v > 0);
    return hasRecords;
  }

  // Handle count operation - return number or object with counts
  if (operation === "count") {
    return parseCountResultDefault(raw);
  }

  // Handle batch operations - return { count: number }
  if (isBatchOperation(operation)) {
    return parseMutationCount(raw);
  }

  // Handle array results
  if (Array.isArray(raw)) {
    // For operations that return single records
    if (isSingleRecordOperation(operation)) {
      const first = raw[0];
      if (!first) {
        return null;
      }
      return parseRow(ctx, first);
    }

    // For operations that return arrays
    return raw.map((row) => parseRow(ctx, row));
  }

  // Single row result
  if (typeof raw === "object") {
    return parseRow(ctx, raw as Record<string, unknown>);
  }

  // Scalar result (count, etc.)
  return raw;
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

  // Use Object.keys + direct access instead of Object.entries to avoid tuple allocation
  const keys = Object.keys(row);
  for (const key of keys) {
    const value = row[key];
    const field = scalars[key];
    const relation = relations[key];

    if (field) {
      const fieldType = field["~"].state.type;
      // Use cached chained parsing: Driver -> Adapter -> Default
      const parse = getParseFieldChain(ctx, fieldType);
      result[key] = parse(value);
    } else if (relation) {
      // Use cached chained parsing: Driver -> Adapter -> Default
      const parse = getParseRelationChain(ctx, key, relation);
      result[key] = parse(value);
    } else {
      // Unknown field - parse generically
      result[key] = parseValue(value);
    }
  }

  return result;
}

/**
 * Default field value parsing (called via adapter's next())
 */
function parseTypedValueDefault(value: unknown, fieldType: string): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  // Handle arrays - apply typed conversion to each element
  if (Array.isArray(value)) {
    return value.map((item) => parseTypedValueDefault(item, fieldType));
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
 * Default relation value parsing (called via adapter's next())
 * Note: JSON string parsing is handled by adapter.result.parseRelation
 */
function parseRelationValueDefault(
  ctx: QueryContext,
  relation: AnyRelation,
  value: unknown
): unknown {
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
        ctx,
        item as Record<string, unknown>,
        targetScalars,
        targetRelations
      )
    );
  }

  if (typeof value === "object") {
    // To-one relation
    return deserializeWithSchema(
      ctx,
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
  ctx: QueryContext,
  obj: Record<string, unknown>,
  scalars: Record<string, Field>,
  relations: Record<string, AnyRelation>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Use Object.keys + direct access instead of Object.entries to avoid tuple allocation
  const keys = Object.keys(obj);
  for (const key of keys) {
    const value = obj[key];
    const field = scalars[key];
    const relation = relations[key];

    if (field) {
      const fieldType = field["~"].state.type;
      // Use cached chained parsing: Driver -> Adapter -> Default
      const parse = getParseFieldChain(ctx, fieldType);
      result[key] = parse(value);
    } else if (relation) {
      // Use cached chained parsing: Driver -> Adapter -> Default
      const parse = getParseRelationChain(ctx, key, relation);
      result[key] = parse(value);
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
 * Default count result parsing (called via adapter's next())
 *
 * Returns a plain number for simple count, or an object with multiple counts
 * when using select (e.g., { _all: 5, name: 4 })
 */
function parseCountResultDefault(
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
      const firstEntry = entries[0];
      // Simple count: single normalized key -> return just the number
      if (entries.length === 1 && firstEntry && isCountKey(firstEntry[0])) {
        const value = firstEntry[1];
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
    const firstEntry = entries[0];
    // Simple count: single normalized key -> return just the number
    if (entries.length === 1 && firstEntry && isCountKey(firstEntry[0])) {
      const value = firstEntry[1];
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
 * Parse count result (exported for external use)
 * @deprecated Use parseResult with 'count' operation instead
 */
export function parseCountResult(
  raw: unknown
): number | Record<string, number> {
  return parseCountResultDefault(raw);
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
