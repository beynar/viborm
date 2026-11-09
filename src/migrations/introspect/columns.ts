/**
 * One live column → one scalar field document.
 *
 * Each dialect reads the snapshot its own introspection wrote (`ColumnDef`) and
 * answers with the field whose forward serialization (`mapScalarType` and
 * `getDefaultExpression`) spells that column again — or with the reason it
 * cannot. Nothing here guesses past what the catalog proves: an exactness this
 * table cannot promise is caught afterwards by `verify.ts`, which runs the
 * forward direction for real.
 */

import { readArrayLiteralText } from "../../adapters/databases/postgres/array-literal";
import type {
  DecimalFieldDocument,
  EnumFieldDocument,
  ScalarFieldDocument,
  ValueFieldDocument,
} from "../../schema/json/document";
import type { JsonValue } from "../../validation/primitives/json";
import { MYSQL_PRINTED_CHARACTERS } from "../drivers/type-mapping";
import { normalizeDefault, normalizeType } from "../push-fingerprint";
import type { ColumnDef, EnumDef } from "../types";
import type { IntrospectionDialect } from "./types";

/** What a column becomes, before keys, keys and relations are settled. */
export interface ColumnField {
  readonly field: ScalarFieldDocument;
  /** The database enum type an enum column uses (PostgreSQL), by name. */
  readonly enumType?: string | undefined;
  /** Why the column's default is not carried, when it is not. */
  readonly skippedDefault?: string | undefined;
  /** How the field's meaning is weaker than the column proves, when it is. */
  readonly approximated?: string | undefined;
}

export type ColumnTranslation = ColumnField | { readonly skip: string };

export interface ColumnContext {
  readonly column: ColumnDef;
  /** The database enums by name (PostgreSQL). */
  readonly enums: ReadonlyMap<string, EnumDef>;
  /** A PostgreSQL identity column: the catalog default is not a default. */
  readonly identity: boolean;
  /** The dialect's spelling of a column-owned enum (SQLite's CHECK). */
  readonly enumColumnType: (values: string[]) => string;
  /**
   * A SQLite `BLOB` key column, or a foreign key to one: VibORM stores a uuid
   * key there as sixteen bytes, and a blob cannot be a key.
   */
  readonly binaryKey: boolean;
  /**
   * MySQL: the column is in a key, an index or a foreign key, where VibORM
   * writes a string as `VARCHAR(191)` (an indexed TEXT needs a length).
   */
  readonly keyed: boolean;
}

/** The scalar types that have `.array()`. */
const LIST_TYPES = new Set<string>([
  "string",
  "int",
  "number",
  "decimal",
  "boolean",
  "datetime",
  "date",
  "time",
  "bigint",
  "blob",
  "enum",
]);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type ValueDraft = Mutable<ValueFieldDocument>;
type FieldDraft =
  | ValueDraft
  | Mutable<EnumFieldDocument>
  | Mutable<DecimalFieldDocument>;

// =============================================================================
// DEFAULTS (shared literal reading)
// =============================================================================

const QUOTED = /^'([\s\S]*)'$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const INTEGER = /^[+-]?\d+$/;
const NOW_DEFAULTS = new Set([
  "now()",
  "now() at time zone 'utc'",
  "date_trunc('milliseconds',now())",
  "date_trunc('milliseconds',now() at time zone 'utc')",
  "current_date",
  "current_time",
  "localtimestamp",
  "localtime",
  "timezone('utc',current_time)",
  "timezone('utc',current_time(3))",
  // SQLite: VibORM's own millisecond UTC clock.
  "strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  // MySQL: a fractional-second clock.
  "current_timestamp(3)",
  "current_timestamp(6)",
  "(current_timestamp(3))",
]);
const DATE_LITERAL = /^\d{4}-\d{2}-\d{2}$/;
const PG_TIMESTAMP_LITERAL =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}(?::?\d{2})?|Z)?$/;

/** A JSON value a document can carry untagged, or wrapped in `$raw`. */
function jsonDefault(value: JsonValue): JsonValue {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.keys(value)[0]?.startsWith("$")
  )
    return { $raw: value };
  return value;
}

const MYSQL_ESCAPE = /\\(.)/g;

/**
 * A quoted literal's value. MySQL prints `\\`, `\n`, `\r`, `\0`, `\Z` and `\'`
 * (`MYSQL_PRINTED_CHARACTERS`); an escape outside that table is not one it
 * printed for a value VibORM can name, so there is no value.
 */
function unquote(
  body: string,
  dialect: IntrospectionDialect
): string | undefined {
  const doubled = body.replaceAll("''", "'");
  if (dialect !== "mysql") return doubled;
  let known = true;
  const value = doubled.replace(
    MYSQL_ESCAPE,
    (_sequence, character: string) => {
      const printed = MYSQL_PRINTED_CHARACTERS.get(character);
      if (printed === undefined) known = false;
      return printed ?? character;
    }
  );
  return known ? value : undefined;
}

/** A decimal's text from its unscaled integer coefficient. */
function coefficientText(coefficient: string, scale: number): string {
  if (scale === 0) return BigInt(coefficient).toString();
  const negative = coefficient.startsWith("-");
  const digits = BigInt(negative ? coefficient.slice(1) : coefficient)
    .toString()
    .padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** Whether a date and a clock name a real instant, with nothing rolled over. */
function isCalendarDate(day: string, clock: string): boolean {
  const [year, month, date] = day.split("-").map(Number);
  const [hours, minutes, seconds] = clock.split(":").map(Number);
  const instant = new Date(
    Date.UTC(year!, month! - 1, date!, hours!, minutes!, Math.trunc(seconds!))
  );
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month! - 1 &&
    instant.getUTCDate() === date &&
    instant.getUTCHours() === hours &&
    instant.getUTCMinutes() === minutes &&
    instant.getUTCSeconds() === Math.trunc(seconds!)
  );
}

/** One literal default member, read as the field's own domain. */
function literalValue(
  field: FieldDraft,
  text: string,
  quoted: boolean
): JsonValue | undefined {
  switch (field.type) {
    case "string":
      return quoted ? text : undefined;
    case "enum":
      return Array.isArray(field.enum) && field.enum.includes(text)
        ? text
        : undefined;
    case "int":
    case "number":
      return NUMBER.test(text) &&
        (field.type === "number" || INTEGER.test(text))
        ? Number(text)
        : undefined;
    case "bigint":
      return INTEGER.test(text)
        ? { $bigint: BigInt(text).toString() }
        : undefined;
    case "decimal":
      return NUMBER.test(text) ? text : undefined;
    case "boolean": {
      const lower = text.toLowerCase();
      if (lower === "true" || lower === "t" || lower === "1") return true;
      if (lower === "false" || lower === "f" || lower === "0") return false;
      return;
    }
    case "json":
      try {
        const parsed: JsonValue = JSON.parse(text);
        return jsonDefault(parsed);
      } catch {
        return;
      }
    case "datetime": {
      const match = PG_TIMESTAMP_LITERAL.exec(text);
      if (!match) return;
      // `Date` rolls an impossible date (`2020-02-30`) into another day; such
      // a literal is no instant, so it has no value here.
      if (!isCalendarDate(match[1]!, match[2]!)) return;
      // PostgreSQL prints an offset as `+00`; ISO 8601 wants `+00:00`.
      const zone = match[3] ?? "Z";
      const offset = zone.length === 3 ? `${zone}:00` : zone;
      const date = new Date(`${match[1]}T${match[2]}${offset}`);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    case "date":
      return DATE_LITERAL.test(text) && isCalendarDate(text, "00:00:00")
        ? text
        : undefined;
    default:
      return;
  }
}

/**
 * The default of one column, as `default`/`generate` keys on its field draft,
 * or the reason it has no document spelling.
 */
function readDefault(
  field: FieldDraft,
  column: ColumnDef,
  sqlText: string,
  dialect: IntrospectionDialect
): string | undefined {
  const normalized = normalizeDefault(sqlText, column.type);
  if (normalized === undefined) return; // NULL: no default
  const unsupported = `the default \`${sqlText}\` has no document spelling`;

  if (
    NOW_DEFAULTS.has(normalized) ||
    NOW_DEFAULTS.has(normalized.toLowerCase())
  ) {
    if (
      field.type === "datetime" ||
      field.type === "date" ||
      field.type === "time"
    ) {
      if (field.array) return unsupported;
      field.generate = { kind: "now" };
      return;
    }
    return unsupported;
  }
  if (normalized === "gen_random_uuid()" || normalized === "uuidv7()") {
    if (field.type !== "string" || field.array) return unsupported;
    field.generate = {
      kind: normalized === "gen_random_uuid()" ? "uuid" : "uuidv7",
    };
    return;
  }

  const quoted = QUOTED.exec(sqlText.trim());
  const literal = quoted ? unquote(quoted[1]!, dialect) : sqlText.trim();
  if (literal === undefined) return unsupported;
  if (field.array) {
    if (!(quoted && dialect === "postgresql")) {
      // SQLite and MySQL hold a list as one JSON text.
      if (!quoted) return unsupported;
      try {
        const values: unknown = JSON.parse(literal);
        if (!Array.isArray(values)) return unsupported;
        const members: JsonValue[] = [];
        for (const value of values) {
          const member =
            value === null
              ? null
              : literalValue(
                  field,
                  typeof value === "string" ? value : JSON.stringify(value),
                  typeof value === "string"
                );
          if (member === undefined) return unsupported;
          members.push(member);
        }
        field.default = members;
        return;
      } catch {
        return unsupported;
      }
    }
    const members = readArrayLiteralText(literal);
    if (members === undefined) return unsupported;
    const values: JsonValue[] = [];
    for (const member of members) {
      const value = member === null ? null : literalValue(field, member, true);
      if (value === undefined) return unsupported;
      values.push(value);
    }
    field.default = values;
    return;
  }
  // SQLite stores a scalar decimal default as its coefficient.
  const text =
    field.type === "decimal" && dialect === "sqlite" && INTEGER.test(literal)
      ? coefficientText(literal, field.scale)
      : literal;
  const value = literalValue(field, text, quoted !== null);
  if (value === undefined) return unsupported;
  field.default = value;
  return;
}

// =============================================================================
// POSTGRESQL
// =============================================================================

const PG_VARCHAR = /^varchar\((\d+)\)$/;
const PG_CHAR = /^char\((\d+)\)$/;
const PG_BIT = /^(bit|varbit)(\((\d+)\))?$/;
const PG_NUMERIC = /^numeric\((\d+),(\d+)\)$/;
const PG_TIMESTAMP = /^timestamp(?:\((\d)\))?( with time zone)?$/;
const PG_TIME = /^time(?:\((\d)\))?( with time zone)?$/;
const PG_STRING_NATIVES = new Set([
  "citext",
  "xml",
  "inet",
  "cidr",
  "macaddr",
  "macaddr8",
  "tsvector",
  "tsquery",
]);

function pgNative(type: string): { db: "pg"; type: string } {
  return { db: "pg", type };
}

/** PostgreSQL's base type (no `[]`), normalized, as a field draft. */
function postgresBase(
  base: string,
  column: ColumnDef,
  array: boolean
): FieldDraft | string {
  if (base === "text") return { type: "string" };
  if (PG_VARCHAR.test(base) || PG_CHAR.test(base))
    return { type: "string", native: pgNative(base) };
  if (PG_STRING_NATIVES.has(base))
    return { type: "string", native: pgNative(base) };
  const bit = PG_BIT.exec(base);
  if (bit) return { type: "string", native: pgNative(base) };
  if (base === "uuid")
    // A uuid list keeps the column type itself; a scalar uuid is the uuid
    // domain, whose PostgreSQL storage is this same `uuid` column.
    return array
      ? { type: "string", native: pgNative("uuid") }
      : { type: "string", generate: { kind: "uuid", generate: false } };
  if (base === "integer") return { type: "int" };
  if (base === "smallint" || base === "oid")
    return { type: "int", native: pgNative(base) };
  if (base === "bigint") return { type: "bigint" };
  if (base === "real") return { type: "number", native: pgNative("real") };
  if (base === "double precision") return { type: "number" };
  if (base === "boolean") return { type: "boolean" };
  if (base === "date") return { type: "date" };
  if (base === "bytea") return { type: "blob" };
  if (base === "jsonb") return { type: "json" };
  if (base === "json") return { type: "json", native: pgNative("json") };
  const numeric = PG_NUMERIC.exec(base);
  if (numeric) {
    const descriptor = column.decimal;
    if (descriptor === undefined)
      return `numeric(${numeric[1]},${numeric[2]}) is outside VibORM's fixed-decimal domain`;
    return {
      type: "decimal",
      precision: descriptor.precision,
      scale: descriptor.scale,
    };
  }
  if (base === "numeric")
    return "an unconstrained `numeric` has no precision and scale, and a VibORM decimal declares both";
  if (base === "varchar")
    return "`varchar` without a length has no document spelling (use `text`, or a length)";
  const timestamp = PG_TIMESTAMP.exec(base);
  if (timestamp) {
    const precision = timestamp[1];
    const zoned = timestamp[2] !== undefined;
    const draft: ValueDraft = { type: "datetime" };
    if (!zoned) draft.withoutTimezone = true;
    if (precision !== "3") {
      const name = zoned ? "timestamptz" : "timestamp";
      draft.native = pgNative(
        precision === undefined ? name : `${name}(${precision})`
      );
    }
    return draft;
  }
  const time = PG_TIME.exec(base);
  if (time) {
    const precision = time[1];
    const zoned = time[2] !== undefined;
    const draft: ValueDraft = { type: "time" };
    if (zoned || precision !== "3") {
      const name = zoned ? "timetz" : "time";
      draft.native = pgNative(
        precision === undefined ? name : `${name}(${precision})`
      );
    }
    return draft;
  }
  return `the type \`${column.type}\` has no VibORM scalar`;
}

export function translatePostgresColumn(
  context: ColumnContext
): ColumnTranslation {
  const { column } = context;
  const array = column.type.endsWith("[]");
  const rawBase = array ? column.type.slice(0, -2) : column.type;
  const enumDef = context.enums.get(rawBase);
  let draft: FieldDraft;
  if (enumDef) {
    draft = { type: "enum", enum: [...enumDef.values] };
  } else {
    const base = postgresBase(normalizeType(rawBase), column, array);
    if (typeof base === "string") return { skip: base };
    draft = base;
  }
  return finish(draft, context, array, "postgresql", enumDef?.name);
}

/** The modifiers every dialect reads the same way: list, null, default. */
function finish(
  draft: FieldDraft,
  context: ColumnContext,
  array: boolean,
  dialect: IntrospectionDialect,
  enumType?: string,
  approximated?: string
): ColumnTranslation {
  const { column } = context;
  if (array) {
    if (!LIST_TYPES.has(draft.type))
      return { skip: `a list of ${draft.type} has no VibORM scalar` };
    draft.array = true;
  }
  if (column.nullable) draft.nullable = true;
  let skippedDefault: string | undefined;
  if (context.identity || column.autoIncrement) {
    if (draft.type === "int" || draft.type === "bigint")
      draft.generate = { kind: "increment" };
    else
      skippedDefault = `an auto-increment ${draft.type} has no document spelling`;
  } else if (column.default !== undefined) {
    skippedDefault = readDefault(draft, column, column.default, dialect);
  }
  return {
    field: draft,
    enumType,
    skippedDefault,
    approximated,
  };
}

// =============================================================================
// SQLITE
// =============================================================================

const SQLITE_ENUM = /^TEXT CHECK\(/;
const SQLITE_ENUM_MEMBER = /'((?:[^']|'')*)'/g;
const SQLITE_NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

/** The enum values a SQLite CHECK spells, when the driver spells them so. */
function sqliteEnumValues(context: ColumnContext): string[] | undefined {
  const { type } = context.column;
  const open = type.indexOf(" IN (");
  if (open === -1) return;
  const values = [...type.slice(open).matchAll(SQLITE_ENUM_MEMBER)].map(
    (match) => match[1]!.replaceAll("''", "'")
  );
  return context.enumColumnType(values) === type ? values : undefined;
}

/** A declared SQLite type outside VibORM's spellings, read by affinity. */
function sqliteAffinity(type: string): FieldDraft {
  if (type.includes("INT")) return { type: "int" };
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT"))
    return { type: "string" };
  if (type === "" || type.includes("BLOB")) return { type: "blob" };
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB"))
    return { type: "number" };
  if (type.includes("BOOL")) return { type: "boolean" };
  if (type.includes("DATETIME") || type.includes("TIMESTAMP"))
    return { type: "datetime" };
  if (type === "DATE") return { type: "date" };
  return { type: "number" };
}

export function translateSqliteColumn(
  context: ColumnContext
): ColumnTranslation {
  const { column } = context;
  const type = column.type.trim().toUpperCase();
  if (column.decimal)
    return finish(
      {
        type: "decimal",
        precision: column.decimal.precision,
        scale: column.decimal.scale,
      },
      context,
      type === "TEXT",
      "sqlite"
    );
  if (SQLITE_ENUM.test(column.type)) {
    const values = sqliteEnumValues(context);
    if (values === undefined)
      return { skip: `the CHECK in \`${column.type}\` is not a VibORM enum` };
    return finish({ type: "enum", enum: values }, context, false, "sqlite");
  }
  let draft: FieldDraft;
  let approximated: string | undefined;
  switch (type) {
    case "TEXT":
      draft =
        column.default?.trim() === SQLITE_NOW
          ? { type: "datetime" }
          : { type: "string" };
      break;
    case "INTEGER":
      draft = { type: "int" };
      break;
    case "REAL":
      draft = { type: "number" };
      break;
    case "BLOB":
      if (context.binaryKey) {
        draft = { type: "string", generate: { kind: "uuid", generate: false } };
        approximated =
          "a BLOB key is read as a UUID, the key VibORM stores as sixteen bytes on SQLite; a key holding other bytes does not decode";
      } else draft = { type: "blob" };
      break;
    case "JSON":
      draft = { type: "json" };
      break;
    default:
      draft = sqliteAffinity(type);
      approximated = `the declared type \`${column.type}\` is read by SQLite's affinity rules as ${draft.type}, which VibORM spells \`${draft.type === "string" ? "TEXT" : draft.type === "number" ? "REAL" : draft.type === "blob" ? "BLOB" : draft.type === "datetime" || draft.type === "date" ? "TEXT" : "INTEGER"}\``;
  }
  return finish(draft, context, false, "sqlite", undefined, approximated);
}

// =============================================================================
// MYSQL
// =============================================================================

const MYSQL_SIZED = /^(varchar|char|binary|varbinary|bit)\((\d+)\)$/;
const MYSQL_TEMPORAL = /^(datetime|timestamp|time)(?:\((\d)\))?$/;
const MYSQL_INTEGERS = new Set([
  "tinyint",
  "tinyint unsigned",
  "smallint",
  "smallint unsigned",
  "mediumint",
  "mediumint unsigned",
  "int unsigned",
  "year",
]);
const MYSQL_TEXTS = new Set(["tinytext", "mediumtext", "longtext"]);
const MYSQL_BLOBS = new Set(["tinyblob", "mediumblob", "longblob"]);
const MYSQL_DISPLAY_WIDTH = /^(tinyint|smallint|mediumint|int|bigint)\(\d+\)/;

function mysqlNative(type: string): { db: "mysql"; type: string } {
  return { db: "mysql", type };
}

/** MySQL's column type (lowercased, display width dropped) as a field draft. */
function mysqlBase(type: string, context: ColumnContext): FieldDraft | string {
  const { column } = context;
  if (type === "text") return { type: "string" };
  if (type === "tinyint(1)") return { type: "boolean" };
  const base = type.replace(MYSQL_DISPLAY_WIDTH, "$1");
  if (base === "int") return { type: "int" };
  if (base === "bigint") return { type: "bigint" };
  if (base === "bigint unsigned")
    return { type: "bigint", native: mysqlNative("BIGINT UNSIGNED") };
  if (MYSQL_INTEGERS.has(base))
    return { type: "int", native: mysqlNative(base.toUpperCase()) };
  if (base === "double") return { type: "number" };
  if (base === "float") return { type: "number", native: mysqlNative("FLOAT") };
  if (base === "json") return { type: "json" };
  if (base === "blob") return { type: "blob" };
  if (MYSQL_BLOBS.has(base))
    return { type: "blob", native: mysqlNative(base.toUpperCase()) };
  if (MYSQL_TEXTS.has(base))
    return { type: "string", native: mysqlNative(base.toUpperCase()) };
  if (base === "date") return { type: "date" };
  if (base.startsWith("decimal(")) {
    const descriptor = column.decimal;
    if (descriptor === undefined)
      return `${column.type} is outside VibORM's fixed-decimal domain`;
    return {
      type: "decimal",
      precision: descriptor.precision,
      scale: descriptor.scale,
    };
  }
  const sized = MYSQL_SIZED.exec(base);
  if (sized) {
    const [, name, size] = sized;
    if (name === "binary" && size === "16" && context.binaryKey)
      return { type: "string", generate: { kind: "uuid", generate: false } };
    if (name === "varchar" && size === "191" && context.keyed)
      return { type: "string" };
    const native = mysqlNative(`${name!.toUpperCase()}(${size})`);
    return name === "binary" || name === "varbinary"
      ? { type: "blob", native }
      : { type: "string", native };
  }
  const temporal = MYSQL_TEMPORAL.exec(base);
  if (temporal) {
    const [, name, precision] = temporal;
    const draft: ValueDraft = { type: name === "time" ? "time" : "datetime" };
    if (name === "timestamp" || precision !== "3")
      draft.native = mysqlNative(
        precision === undefined
          ? name!.toUpperCase()
          : `${name!.toUpperCase()}(${precision})`
      );
    return draft;
  }
  return `the type \`${column.type}\` has no VibORM scalar`;
}

export function translateMysqlColumn(
  context: ColumnContext
): ColumnTranslation {
  const { column } = context;
  if (column.type.toUpperCase().startsWith("ENUM(")) {
    const enumDef = context.enums.get(column.type);
    if (
      enumDef === undefined ||
      context.enumColumnType(enumDef.values) !== column.type
    )
      return { skip: `the enum \`${column.type}\` is not one VibORM spells` };
    return finish(
      { type: "enum", enum: [...enumDef.values] },
      context,
      false,
      "mysql"
    );
  }
  const base = mysqlBase(column.type.trim().toLowerCase(), context);
  if (typeof base === "string") return { skip: base };
  const approximated =
    base.type === "string" && base.generate?.kind === "uuid"
      ? "a BINARY(16) key is read as a UUID, the key VibORM stores as sixteen bytes on MySQL; a key holding other bytes does not decode"
      : undefined;
  return finish(base, context, false, "mysql", undefined, approximated);
}
