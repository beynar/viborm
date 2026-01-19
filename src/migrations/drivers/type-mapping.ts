/**
 * Centralized Type Mapping for Migration Drivers
 *
 * Maps VibORM field types to native database column types.
 * Uses constants from native-types.ts to ensure consistency.
 */

import { PG, SQLITE } from "@schema/fields/native-types";

// =============================================================================
// TYPE MAPPING CONSTANTS
// =============================================================================

/**
 * Default PostgreSQL type mappings for each VibORM field type.
 * Uses the same type names as defined in native-types.ts.
 */
export const PG_TYPE_DEFAULTS = {
  string: PG.STRING.TEXT.type,
  int: PG.INT.INTEGER.type,
  float: PG.FLOAT.DOUBLE_PRECISION.type,
  decimal: "numeric", // PG.DECIMAL.NUMERIC() returns a function, use literal
  boolean: PG.BOOLEAN.BOOLEAN.type,
  datetime: "timestamp",
  datetimetz: "timestamptz",
  date: PG.DATETIME.DATE.type,
  time: "time",
  timetz: "timetz",
  bigint: PG.BIGINT.BIGINT.type,
  json: PG.JSON.JSONB.type,
  blob: PG.BLOB.BYTEA.type,
  vector: "vector",
  point: PG.POINT.POINT.type,
  enum: PG.STRING.TEXT.type,
} as const;

/**
 * Default SQLite type mappings for each VibORM field type.
 * SQLite has limited type affinity - most types map to TEXT, INTEGER, REAL, or BLOB.
 */
export const SQLITE_TYPE_DEFAULTS = {
  string: SQLITE.STRING.TEXT.type,
  int: SQLITE.INT.INTEGER.type,
  float: SQLITE.FLOAT.REAL.type,
  decimal: SQLITE.DECIMAL.REAL.type,
  boolean: SQLITE.BOOLEAN.INTEGER.type,
  datetime: SQLITE.DATETIME.TEXT.type,
  date: SQLITE.DATETIME.TEXT.type,
  time: SQLITE.DATETIME.TEXT.type,
  bigint: SQLITE.BIGINT.INTEGER.type,
  json: "JSON", // SQLite JSON functions work with TEXT but JSON is more semantic
  blob: SQLITE.BLOB.BLOB.type,
  vector: "JSON", // Store as JSON array in SQLite
  point: "JSON", // Store as JSON object in SQLite
  enum: SQLITE.STRING.TEXT.type,
} as const;

// =============================================================================
// TYPE MAPPING FUNCTIONS
// =============================================================================

export type VibORMFieldType =
  | "string"
  | "int"
  | "float"
  | "decimal"
  | "boolean"
  | "datetime"
  | "date"
  | "time"
  | "bigint"
  | "json"
  | "blob"
  | "vector"
  | "point"
  | "enum";

export interface FieldTypeContext {
  type: string;
  array?: boolean;
  withTimezone?: boolean;
}

/**
 * Gets the PostgreSQL column type for a VibORM field type.
 */
export function getPostgresType(context: FieldTypeContext): string {
  let baseType: string;

  switch (context.type) {
    case "string":
      baseType = PG_TYPE_DEFAULTS.string;
      break;
    case "int":
      baseType = PG_TYPE_DEFAULTS.int;
      break;
    case "float":
      baseType = PG_TYPE_DEFAULTS.float;
      break;
    case "decimal":
      baseType = PG_TYPE_DEFAULTS.decimal;
      break;
    case "boolean":
      baseType = PG_TYPE_DEFAULTS.boolean;
      break;
    case "datetime":
      baseType = context.withTimezone
        ? PG_TYPE_DEFAULTS.datetimetz
        : PG_TYPE_DEFAULTS.datetime;
      break;
    case "date":
      baseType = PG_TYPE_DEFAULTS.date;
      break;
    case "time":
      baseType = context.withTimezone
        ? PG_TYPE_DEFAULTS.timetz
        : PG_TYPE_DEFAULTS.time;
      break;
    case "bigint":
      baseType = PG_TYPE_DEFAULTS.bigint;
      break;
    case "json":
      baseType = PG_TYPE_DEFAULTS.json;
      break;
    case "blob":
      baseType = PG_TYPE_DEFAULTS.blob;
      break;
    case "vector":
      baseType = PG_TYPE_DEFAULTS.vector;
      break;
    case "point":
      baseType = PG_TYPE_DEFAULTS.point;
      break;
    case "enum":
      baseType = PG_TYPE_DEFAULTS.enum;
      break;
    default:
      baseType = PG_TYPE_DEFAULTS.string;
  }

  return context.array ? `${baseType}[]` : baseType;
}

/**
 * Gets the SQLite column type for a VibORM field type.
 * SQLite doesn't support native arrays - they are stored as JSON.
 */
export function getSQLiteType(context: FieldTypeContext): string {
  // SQLite doesn't support native arrays - use JSON
  if (context.array) {
    return "JSON";
  }

  switch (context.type) {
    case "string":
    case "enum":
      return SQLITE_TYPE_DEFAULTS.string;
    case "json":
    case "vector":
    case "point":
      return "JSON";
    case "int":
    case "bigint":
    case "boolean":
      return SQLITE_TYPE_DEFAULTS.int;
    case "float":
    case "decimal":
      return SQLITE_TYPE_DEFAULTS.float;
    case "datetime":
    case "date":
    case "time":
      return SQLITE_TYPE_DEFAULTS.datetime;
    case "blob":
      return SQLITE_TYPE_DEFAULTS.blob;
    default:
      return SQLITE_TYPE_DEFAULTS.string;
  }
}
