/**
 * Result Parser
 *
 * Transforms raw database rows into typed objects.
 * Delegates database-specific parsing through a middleware chain:
 * Driver (optional) -> Adapter -> Default parsing
 *
 * Applies schema-aware type conversion for relation data (datetime, bigint).
 */

import {
  COUNT_RESULT_KEY,
  tryParseJsonString,
} from "@adapters/shared/result-parsing";
import type { AnyRelation } from "@schema/relation";
import type { RelationType } from "@schema/relation/types";
import type { Scalar } from "@schema/scalars";
import {
  isBatchOperation,
  type Operation,
  type QueryContext,
  QueryEngineError,
} from "../types";
import {
  assignRelationCount,
  getRelationCountName,
} from "./relation-count-parser";

/**
 * Check if a key is a recognized count result column name.
 * Adapters normalize to COUNT_RESULT_KEY, but we also accept "count" for compatibility.
 */
function isCountKey(key: string): boolean {
  return key === COUNT_RESULT_KEY || key === "count";
}

function parseVectorDistanceValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim() !== "") {
    const distance = Number(value);
    if (Number.isFinite(distance)) {
      return distance;
    }
  }

  throw new QueryEngineError("Cannot parse vector distance result.");
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
function getParseRelationChain(
  ctx: QueryContext,
  relationName: string,
  relation: AnyRelation
) {
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
function createParseFieldChain(
  ctx: QueryContext,
  scalarType: string,
  isList: boolean
) {
  // Default parsing (end of chain)
  const defaultParse = (value: unknown, _type: string) => {
    // List columns come back as JSON text on MySQL/SQLite drivers; decode to
    // an array before per-element conversion. PG lists arrive as arrays.
    if (isList && typeof value === "string") {
      const parsed = tryParseJsonString(value);
      if (parsed !== undefined) {
        return parseTypedValueDefault(parsed, scalarType);
      }
    }
    return parseTypedValueDefault(value, scalarType);
  };

  // Adapter wraps default
  const adapterParse = (value: unknown, type: string) =>
    ctx.adapter.result.parseField(value, type, (transformed) =>
      defaultParse(transformed ?? value, type)
    );

  // Driver wraps adapter (if driver has result parsing)
  if (ctx.driver?.result?.parseField) {
    return (value: unknown) =>
      ctx.driver!.result!.parseField!(value, scalarType, adapterParse);
  }

  return (value: unknown) => adapterParse(value, scalarType);
}

/**
 * Get or create the cached parseField chain for a scalar's type + list-ness
 */
function getParseFieldChain(ctx: QueryContext, scalar: Scalar) {
  const scalarType = scalar["~"].state.type;
  const isList = scalar["~"].state.array === true;
  const cacheKey = isList ? `${scalarType}[]` : scalarType;
  ctx._parseFieldChains ??= new Map();
  let chain = ctx._parseFieldChains.get(cacheKey);
  if (!chain) {
    chain = createParseFieldChain(ctx, scalarType, isList);
    ctx._parseFieldChains.set(cacheKey, chain);
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

    // For operations that return arrays: all rows of one statement share the
    // same columns, so resolve the per-column parser once and run a flat loop.
    const len = raw.length;
    if (len === 0) {
      return [];
    }
    const model = ctx.model;
    const rowParser = createRowParser(
      ctx,
      Object.keys(raw[0] as Record<string, unknown>),
      model["~"].state.scalars,
      model["~"].state.relations
    );
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = rowParser(raw[i] as Record<string, unknown>);
    }
    return out;
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
    assignParsedField(ctx, result, key, value, scalars, relations);
  }

  return result;
}

/**
 * Build a row parser for a fixed set of columns: the scalar/relation/count
 * dispatch is resolved once per result set instead of once per row per field.
 */
function createRowParser(
  ctx: QueryContext,
  keys: string[],
  scalars: Record<string, Scalar>,
  relations: Record<string, AnyRelation>
): (row: Record<string, unknown>) => Record<string, unknown> {
  const len = keys.length;
  const steps: ((result: Record<string, unknown>, value: unknown) => void)[] =
    new Array(len);

  for (let i = 0; i < len; i++) {
    const key = keys[i]!;

    const relationCountName = getRelationCountName(key, relations);
    if (relationCountName) {
      steps[i] = (result, value) =>
        assignRelationCount(result, relationCountName, value);
      continue;
    }

    if (key === "_distance") {
      // Reserved result alias (like `_count`): a `_distance` select is a vector
      // distance score, always numeric. A user scalar column literally named
      // `_distance` would be routed here too — accepted trade-off for the alias.
      steps[i] = (result, value) => {
        result[key] = parseVectorDistanceValue(value);
      };
      continue;
    }

    const scalar = scalars[key];
    if (scalar) {
      const parse = getParseFieldChain(ctx, scalar);
      steps[i] = (result, value) => {
        result[key] = parse(value);
      };
      continue;
    }

    const relation = relations[key];
    if (relation) {
      const parse = getParseRelationChain(ctx, key, relation);
      steps[i] = (result, value) => {
        result[key] = parse(value);
      };
      continue;
    }

    if (AGGREGATE_RESULT_KEYS.has(key)) {
      steps[i] = (result, value) => {
        result[key] = parseAggregateResult(ctx, key, value);
      };
      continue;
    }

    steps[i] = (result, value) => {
      result[key] = parseValue(value);
    };
  }

  return (row) => {
    const result: Record<string, unknown> = {};
    for (let i = 0; i < len; i++) {
      steps[i]!(result, row[keys[i]!]);
    }
    return result;
  };
}

function assignParsedField(
  ctx: QueryContext,
  result: Record<string, unknown>,
  key: string,
  value: unknown,
  scalars: Record<string, Scalar>,
  relations: Record<string, AnyRelation>
): void {
  const relationCountName = getRelationCountName(key, relations);
  if (relationCountName) {
    assignRelationCount(result, relationCountName, value);
    return;
  }

  if (key === "_distance") {
    // Reserved result alias (see the batch-parse path above): vector distance
    // score, always numeric.
    result[key] = parseVectorDistanceValue(value);
    return;
  }

  const scalar = scalars[key];
  if (scalar) {
    const parse = getParseFieldChain(ctx, scalar);
    result[key] = parse(value);
    return;
  }

  const relation = relations[key];
  if (relation) {
    const parse = getParseRelationChain(ctx, key, relation);
    result[key] = parse(value);
    return;
  }

  if (AGGREGATE_RESULT_KEYS.has(key)) {
    result[key] = parseAggregateResult(ctx, key, value);
    return;
  }

  result[key] = parseValue(value);
}

const AGGREGATE_RESULT_KEYS = new Set([
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
]);

/**
 * Parse aggregate/groupBy result columns with schema awareness:
 * - `_count: true` arrives as a bare value (a string on PG) → number
 * - `_count`/`_avg` objects → numbers per field
 * - `_sum`/`_min`/`_max` objects → parsed through each field's scalar type,
 *   so bigint sums come back as BigInt and datetime min/max as Dates
 */
function parseAggregateResult(
  ctx: QueryContext,
  key: string,
  raw: unknown
): unknown {
  if (raw === null || raw === undefined) {
    return null;
  }

  let value: unknown = raw;
  if (typeof value === "string") {
    // SQLite/MySQL return the JSON-built aggregate object as text
    const parsed = tryParseJsonString(value);
    if (parsed !== undefined) {
      value = parsed;
    }
  }

  if (typeof value !== "object" || value === null) {
    return Number(value);
  }

  const scalars = ctx.model["~"].state.scalars;
  const typed = key === "_sum" || key === "_min" || key === "_max";
  const result: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (fieldValue === null || fieldValue === undefined) {
      result[field] = null;
      continue;
    }
    const scalar = typed ? scalars[field] : undefined;
    result[field] = scalar
      ? getParseFieldChain(ctx, scalar)(fieldValue)
      : Number(fieldValue);
  }
  return result;
}

/**
 * Timestamp text without timezone info ("2024-01-15 10:30:00[.123]").
 * The write path stores the UTC wall clock (validation serializes via
 * toISOString), so these must be read back as UTC — JS Date would otherwise
 * interpret them in the process timezone and shift the instant.
 */
const ZONELESS_DATETIME_REGEX =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** Trailing timezone marker on a time string: "+00", "+00:00", "-0530", "Z" */
const TIME_ZONE_SUFFIX_REGEX = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/** Redundant zeros in a fractional-seconds suffix: ".000000" or ".1230" → ".123" */
const TRAILING_FRACTION_ZEROS_REGEX = /\.?0+$/;

function parseDateTimeString(value: string): Date {
  if (ZONELESS_DATETIME_REGEX.test(value)) {
    return new Date(`${value.replace(" ", "T")}Z`);
  }
  return new Date(value);
}

function hexToUint8Array(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Normalize every driver's binary representation to a plain Uint8Array —
 * the one public blob type. Strings are hex ("\x..." from PG JSON,
 * "base64:typeNNN:..." from MySQL JSON, plain hex from our blobToHex cast).
 */
function parseBlobValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    // Buffer (and other subclasses) → plain Uint8Array, copied out of any pool
    return value.constructor === Uint8Array ? value : new Uint8Array(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value as number[]);
  }
  if (typeof value === "string") {
    if (value.startsWith("\\x")) {
      return hexToUint8Array(value.slice(2));
    }
    if (value.startsWith("base64:type")) {
      return Uint8Array.from(
        Buffer.from(value.slice(value.indexOf(":", 11) + 1), "base64")
      );
    }
    return hexToUint8Array(value);
  }
  return value;
}

/**
 * Default field value parsing (called via adapter's next())
 */
function parseTypedValueDefault(value: unknown, scalarType: string): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  // Blob before the array branch: a number[] is one binary value, not a list
  if (scalarType === "blob") {
    return parseBlobValue(value);
  }

  // Handle arrays - apply typed conversion to each element
  if (Array.isArray(value)) {
    return value.map((item) => parseTypedValueDefault(item, scalarType));
  }

  switch (scalarType) {
    case "datetime":
      if (value instanceof Date) return value;
      if (typeof value === "string") return parseDateTimeString(value);
      if (typeof value === "number") return new Date(value);
      return value;

    case "date":
      // "YYYY-MM-DD" parses as UTC midnight — the cross-driver contract
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

    case "int":
    case "float":
      // BigInt arrives when SQLite drivers read integers safely; int/float
      // columns are within Number range by contract
      if (typeof value === "bigint" || typeof value === "string") {
        return Number(value);
      }
      return value;

    case "decimal":
      // Convert strings to numbers (databases often return decimals as strings to preserve precision)
      if (typeof value === "number") return value;
      if (typeof value === "bigint" || typeof value === "string") {
        return Number(value);
      }
      return value;

    case "boolean":
      // 0/1 conversion happens in driver parsers; BigInt slips through when
      // SQLite integers are read safely
      if (typeof value === "bigint") return value === 1n;
      return value;

    case "time": {
      // Time is a plain "HH:MM:SS[.fff]" string; PG timetz appends the
      // session offset ("+00") and MySQL's JSON casting pads microseconds
      // ("13:45:30.000000") — strip both so all drivers agree.
      // ponytail: assumes UTC sessions; a non-UTC-offset timetz would need
      // conversion, but the write path only ever stores naive time strings
      if (typeof value === "string") {
        let time = value.replace(TIME_ZONE_SUFFIX_REGEX, "");
        if (time.includes(".")) {
          time = time.replace(TRAILING_FRACTION_ZEROS_REGEX, "");
        }
        return time;
      }
      return String(value);
    }

    case "string":
    case "enum":
      // Never JSON-sniff string scalars: a string column containing
      // '{"a":1}' must round-trip as a string, not an object
      return value;

    case "json":
      // Already decoded by the driver (PG/MySQL native, SQLite driver parser).
      // Never sniff: a json column can legitimately hold the string '"123"'.
      // SQLite JSON columns have NUMERIC affinity, so integer JSON values
      // arrive as BigInt under safe-integer reads — JSON numbers are doubles
      if (typeof value === "bigint") return Number(value);
      return value;

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
    // To-many relation - items share the shape of the JSON aggregation, so
    // resolve the per-key parser once from the first item.
    const len = value.length;
    if (len === 0) {
      return value;
    }
    const itemParser = createRowParser(
      ctx,
      Object.keys(value[0] as Record<string, unknown>),
      targetScalars,
      targetRelations
    );
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = itemParser(value[i] as Record<string, unknown>);
    }
    return out;
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
  scalars: Record<string, Scalar>,
  relations: Record<string, AnyRelation>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Use Object.keys + direct access instead of Object.entries to avoid tuple allocation
  const keys = Object.keys(obj);
  for (const key of keys) {
    const value = obj[key];
    assignParsedField(ctx, result, key, value, scalars, relations);
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

    // Recursively parse nested objects (JSON scalars, etc.)
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
    case "createManyAndReturn":
    case "updateManyAndReturn":
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
