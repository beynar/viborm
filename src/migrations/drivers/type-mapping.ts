/**
 * Centralized Type Mapping for Migration Drivers
 *
 * Maps VibORM scalar types to native database column types.
 * Uses constants from native-types.ts to ensure consistency.
 */

import { PG, SQLITE } from "@schema/scalars/native-types";
import {
  type DecimalDescriptor,
  decimalColumnType,
} from "@validation/primitives/decimal-codec";
import { MigrationError, VibORMErrorCode } from "../../errors";
import { SQLITE_DECIMAL_LIST_TYPE } from "../decimal";
import { SQLITE_GEO_POINT_TYPE } from "./sqlite/geo-point";

// =============================================================================
// TYPE MAPPING CONSTANTS
// =============================================================================

/**
 * Default PostgreSQL type mappings for each VibORM scalar type.
 * Uses the same type names as defined in native-types.ts.
 */
export const PG_TYPE_DEFAULTS = {
  string: PG.STRING.TEXT.type,
  int: PG.INT.INTEGER.type,
  number: PG.FLOAT.DOUBLE_PRECISION.type,
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
  point: "geography(Point,4326)",
  enum: PG.STRING.TEXT.type,
} as const;

/**
 * Default SQLite type mappings for each VibORM scalar type.
 * SQLite has limited type affinity - most types map to TEXT, INTEGER, REAL, or BLOB.
 */
export const SQLITE_TYPE_DEFAULTS = {
  string: SQLITE.STRING.TEXT.type,
  int: SQLITE.INT.INTEGER.type,
  number: SQLITE.FLOAT.REAL.type,
  boolean: SQLITE.BOOLEAN.INTEGER.type,
  datetime: SQLITE.DATETIME.TEXT.type,
  date: SQLITE.DATETIME.TEXT.type,
  time: SQLITE.DATETIME.TEXT.type,
  bigint: SQLITE.BIGINT.INTEGER.type,
  json: "JSON", // SQLite JSON functions work with TEXT but JSON is more semantic
  blob: SQLITE.BLOB.BLOB.type,
  vector: "JSON", // Store as JSON array in SQLite
  point: SQLITE_GEO_POINT_TYPE,
  enum: SQLITE.STRING.TEXT.type,
} as const;

/**
 * Default MySQL type mappings for each VibORM scalar type.
 * MySQL has full type support but uses TINYINT(1) for booleans
 * and doesn't support native arrays (use JSON instead).
 */
export const MYSQL_TYPE_DEFAULTS = {
  string: "TEXT",
  int: "INT",
  number: "DOUBLE",
  boolean: "TINYINT(1)", // MySQL uses TINYINT(1) for boolean
  datetime: "DATETIME(3)", // Use DATETIME(3) to preserve JavaScript Date millisecond precision
  datetimetz: "DATETIME(3)", // MySQL DATETIME can store with timezone via application
  date: "DATE",
  time: "TIME(3)", // Use TIME(3) to preserve millisecond precision
  timetz: "TIME(3)", // MySQL TIME doesn't have timezone variant
  bigint: "BIGINT",
  json: "JSON",
  blob: "BLOB",
  vector: "JSON", // No native vector support, use JSON
  point: "POINT SRID 4326",
  enum: "TEXT", // Default for unspecified enums; usually use inline ENUM()
} as const;

/**
 * THE MySQL inline enum type — one spelling, both snapshot producers.
 *
 * MySQL has no standalone enum object: the values ARE the column type, so this
 * text is also the enum's identity in a snapshot. The desired side spells it
 * (`MySQLMigrationDriver.getEnumColumnType`) and the live side re-spells the
 * catalog's `COLUMN_TYPE` through the very same function
 * (`mysql/introspect.ts`), because `information_schema` prints its own
 * canonical rendering — `enum('a','b')`, no space after the comma, and an
 * identity of its own invention — and two spellings of ONE type read as a
 * changed column on every push and as the mismatch the final push attestation
 * refuses.
 *
 * A member IS a MySQL string literal, so it is spelled by the one function that
 * spells those (`mysqlStringLiteral` below) rather than by a second rule of its
 * own. Doubling `'` alone was that second rule: `ENUM('a\b')` declared a member
 * holding a BACKSPACE, `ENUM('end\')` did not parse at all, and once the
 * default beside such a member went through the shared spelling the two
 * disagreed and MySQL refused the CREATE/MODIFY with errno 1067 (all measured).
 */
export function mysqlEnumType(values: readonly string[]): string {
  return `ENUM(${values.map((value) => mysqlStringLiteral(value)).join(", ")})`;
}

/**
 * THE characters MySQL's string literals carry as an escape — the one table
 * both directions read.
 *
 * MySQL reads `\` inside a string literal as an escape introducer (only
 * `NO_BACKSLASH_ESCAPES` stops it, a mode this estate never sets and the
 * pinned session does not promise), so doubling `'` alone spells a DIFFERENT
 * value: `DEFAULT ('a\b')` stored a BACKSPACE and `DEFAULT ('end\')` did not
 * even parse. The four control characters are escaped for the same reason
 * they cannot be written raw: a generated statement is also the review blob,
 * which is UTF-8/LF with no carriage returns (`sql-blob.ts`).
 *
 * `information_schema` prints an expression default with exactly these escapes
 * plus `\'` (measured on 8.4.11 — every other character, tab and backspace
 * included, is printed raw), so `mysql/introspect.ts` undoes this same table
 * before re-spelling the value through `mysqlStringLiteral` below.
 */
export const MYSQL_LITERAL_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["\\", "\\\\"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\0", "\\0"],
  ["\u001a", "\\Z"],
]);

/**
 * THE MySQL string literal — one spelling, both snapshot producers.
 *
 * The desired side writes it (`MySQLMigrationDriver.escapeValue`) and the live
 * side re-spells the value it read out of the catalog through the very same
 * function (`mysql/introspect.ts`), because two spellings of ONE value read as
 * a changed column on every push and as the mismatch the final push
 * attestation refuses.
 */
export function mysqlStringLiteral(value: string): string {
  let escaped = "";
  for (const character of value) {
    escaped += MYSQL_LITERAL_ESCAPES.get(character) ?? character;
  }
  return `'${escaped.replace(/'/g, "''")}'`;
}

// =============================================================================
// TYPE MAPPING FUNCTIONS
// =============================================================================

export interface ScalarTypeContext {
  type: string;
  array?: boolean;
  withTimezone?: boolean;
  dimension?: number | undefined;
  /**
   * The declared fixed-decimal domain, for a `decimal` scalar. Every decimal
   * type on every dialect is DERIVED from it — there is no unconstrained
   * `numeric`, no `DECIMAL(65,30)`, and no TEXT decimal to fall back to.
   */
  decimal?: DecimalDescriptor | undefined;
}

/**
 * The declared domain of a decimal context.
 *
 * A decimal column with no descriptor has no physical type at all: the numbers
 * cannot be inferred from storage, a value, a driver, or an operation (plan
 * §1.1), so the alternative to refusing is inventing a second precision — which
 * is exactly the `DECIMAL(65,30)` this program deletes. The public decimal
 * factory cannot produce such a state; a hand-built or externally-deserialized
 * scalar state can, and this is where it stops.
 */
function requireDecimalDomain(context: ScalarTypeContext): DecimalDescriptor {
  if (context.decimal) return context.decimal;
  throw new MigrationError(
    "A decimal column has no declared precision and scale. " +
      "The fixed-decimal domain is declared once, on the scalar, and every physical type is derived from it.",
    VibORMErrorCode.INVALID_INPUT,
    { meta: { scalarType: "decimal" } }
  );
}

/**
 * Gets the PostgreSQL column type for a VibORM scalar type.
 */
export function getPostgresType(context: ScalarTypeContext): string {
  let baseType: string;

  switch (context.type) {
    case "string":
      baseType = PG_TYPE_DEFAULTS.string;
      break;
    case "int":
      baseType = PG_TYPE_DEFAULTS.int;
      break;
    case "number":
      baseType = PG_TYPE_DEFAULTS.number;
      break;
    case "decimal":
      // `NUMERIC(p,s)`, and `NUMERIC(p,s)[]` through the array suffix below:
      // PostgreSQL carries the domain in the element typmod, which is the one
      // place introspection can read it back from.
      baseType = decimalColumnType("pg", requireDecimalDomain(context));
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
      baseType =
        context.dimension === undefined
          ? PG_TYPE_DEFAULTS.vector
          : `${PG_TYPE_DEFAULTS.vector}(${context.dimension})`;
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
 * Gets the SQLite column type for a VibORM scalar type.
 * SQLite doesn't support native arrays - they are stored as JSON.
 */
export function getSQLiteType(context: ScalarTypeContext): string {
  // SQLite doesn't support native arrays - use JSON.
  //
  // A decimal list is the one exception, and it is TEXT rather than JSON for a
  // physical reason: its reserved CHECK asserts `typeof = 'text'`, and the
  // literal type `JSON` has NUMERIC affinity under SQLite's rules, which would
  // convert a numeric-looking container on the way in.
  if (context.array) {
    return context.type === "decimal" ? SQLITE_DECIMAL_LIST_TYPE : "JSON";
  }

  switch (context.type) {
    case "string":
    case "enum":
      return SQLITE_TYPE_DEFAULTS.string;
    case "json":
    case "vector":
      return "JSON";
    case "point":
      return SQLITE_TYPE_DEFAULTS.point;
    case "int":
    case "bigint":
    case "boolean":
      return SQLITE_TYPE_DEFAULTS.int;
    case "number":
      return SQLITE_TYPE_DEFAULTS.number;
    // The signed INTEGER coefficient scaled by 10^scale. SQLite has no exact
    // decimal type at all — `DECIMAL(10,5)` is a NUMERIC-affinity spelling
    // whose numbers it ignores, and REAL rounds a fractional value into a
    // double as it is stored — so the exact value lives in an integer and the
    // declared precision is made real by the reserved CHECK the driver adds.
    case "decimal":
      return decimalColumnType("sqlite", requireDecimalDomain(context));
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

/**
 * Gets the MySQL column type for a VibORM scalar type.
 * MySQL doesn't support native arrays - they are stored as JSON.
 */
export function getMySQLType(context: ScalarTypeContext): string {
  // MySQL doesn't support native arrays - use JSON
  if (context.array) {
    return "JSON";
  }

  switch (context.type) {
    case "string":
      return MYSQL_TYPE_DEFAULTS.string;
    case "int":
      return MYSQL_TYPE_DEFAULTS.int;
    case "number":
      return MYSQL_TYPE_DEFAULTS.number;
    // Never bare `DECIMAL`: MySQL reads that as `DECIMAL(10,0)` and silently
    // truncates every fraction. A decimal LIST is caught by the array arm
    // above, where it is JSON like every other MySQL list and carries its
    // domain in the column-comment marker instead.
    case "decimal":
      return decimalColumnType("mysql", requireDecimalDomain(context));
    case "boolean":
      return MYSQL_TYPE_DEFAULTS.boolean;
    case "datetime":
      return context.withTimezone
        ? MYSQL_TYPE_DEFAULTS.datetimetz
        : MYSQL_TYPE_DEFAULTS.datetime;
    case "date":
      return MYSQL_TYPE_DEFAULTS.date;
    case "time":
      return context.withTimezone
        ? MYSQL_TYPE_DEFAULTS.timetz
        : MYSQL_TYPE_DEFAULTS.time;
    case "bigint":
      return MYSQL_TYPE_DEFAULTS.bigint;
    case "json":
      return MYSQL_TYPE_DEFAULTS.json;
    case "blob":
      return MYSQL_TYPE_DEFAULTS.blob;
    case "vector":
      return MYSQL_TYPE_DEFAULTS.vector;
    case "point":
      return MYSQL_TYPE_DEFAULTS.point;
    case "enum":
      return MYSQL_TYPE_DEFAULTS.enum;
    default:
      return MYSQL_TYPE_DEFAULTS.string;
  }
}
