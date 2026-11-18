/**
 * A statement's text with every bound value written as a literal of its
 * dialect: the body of a view, which `CREATE VIEW … AS SELECT …` takes
 * without parameters (`docs/architecture/schema-views-plan.md` §3.1).
 *
 * Only the migrations layer imports this module, by path: no adapter, no
 * adapter barrel and nothing the client or the engine imports reaches it, so
 * an application's bundle never carries it.
 *
 * Each literal means what the dialect's reference driver sends for the value
 * in the same position, so the inlined text reads the rows the bound statement
 * reads:
 *
 * - PostgreSQL: node-postgres sends a string, a number, a bigint and a boolean
 *   as text of unknown type, which is what a quoted constant is to the
 *   server's type resolution (`'10'`, `'true'`); a bare `10` would be `int4`.
 *   Bytes are `bytea`, a JSON carrier its text, a JavaScript array one array
 *   literal (node-postgres' `arrayString`).
 * - MySQL: mysql2 runs the text protocol, where the driver itself writes each
 *   value into the statement (`sqlstring`); these are its literals.
 * - SQLite: better-sqlite3 binds every JavaScript number as REAL, a boolean
 *   too once `convertValueForSQLite` made it 1 or 0, a bigint as INTEGER,
 *   bytes as a blob.
 *
 * A value kind no read of the dialect binds has no literal here and is
 * refused, never guessed.
 */
import type { SqlDialect } from "@drivers/types";
import { UnsupportedOperationError } from "@errors";
import { Sql } from "@sql";
import { JsonParameter } from "../sql/json-parameter";
import { mysqlStringLiteral } from "./databases/mysql/string-literal";
import { arrayLiteralText } from "./databases/postgres/array-literal";

const DIALECT_NAMES: Record<SqlDialect, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
};

const QUOTE = /'/g;
const BACKSLASH = /\\/g;
const INTEGER_TEXT = /^-?\d+$/;

/** The kind a refusal names. */
const kindOf = (value: unknown): string => {
  if (value instanceof Date) return "Date";
  if (Array.isArray(value)) return "array";
  if (value instanceof JsonParameter) return "JsonParameter";
  return typeof value;
};

function refuse(dialect: SqlDialect, value: unknown): never {
  const kind = kindOf(value);
  throw new UnsupportedOperationError(
    `A view body binds a value of kind "${kind}", which has no ${DIALECT_NAMES[dialect]} literal: no read of this dialect binds one.`,
    { meta: { dialect, feature: "view literal", type: kind } }
  );
}

/**
 * A string holding NUL: no PostgreSQL text holds one, and SQLite ends a
 * statement's text at it. Refused while the body is written, so a migration
 * generated without a database is not one that fails only when applied.
 */
function refuseNul(dialect: SqlDialect): never {
  throw new UnsupportedOperationError(
    `A view body binds a string holding a NUL character, which a ${DIALECT_NAMES[dialect]} string literal cannot hold.`,
    { meta: { dialect, feature: "view literal", type: "string" } }
  );
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A scalar node-postgres writes into an array literal as its own text. */
const isArrayMember = (member: unknown): boolean =>
  typeof member === "string" ||
  typeof member === "number" ||
  typeof member === "bigint" ||
  typeof member === "boolean";

/**
 * A PostgreSQL string constant of unknown type that reads the same under
 * either `standard_conforming_strings`: one holding a backslash is an escape
 * string, whose backslashes are doubled.
 */
function postgresString(text: string): string {
  if (text.includes("\0")) refuseNul("postgresql");
  const quoted = text.replace(QUOTE, "''");
  return text.includes("\\")
    ? `E'${quoted.replace(BACKSLASH, "\\\\")}'`
    : `'${quoted}'`;
}

function postgresLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return postgresString(value);
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  )
    return postgresString(String(value));
  if (value instanceof Uint8Array)
    return `${postgresString(`\\x${hex(value)}`)}::bytea`;
  if (value instanceof JsonParameter) return postgresString(value.json);
  if (Array.isArray(value) && value.every(isArrayMember))
    return postgresString(arrayLiteralText(value));
  return refuse("postgresql", value);
}

function mysqlLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return mysqlStringLiteral(value);
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Uint8Array) return `X'${hex(value)}'`;
  return refuse("mysql", value);
}

/**
 * A signed SQLite number, parenthesized when negative: after a `-` of the
 * statement's own, `--` would open a comment.
 */
const signed = (text: string): string =>
  text.startsWith("-") ? `(${text})` : text;

function sqliteLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") {
    if (value.includes("\0")) refuseNul("sqlite");
    return `'${value.replace(QUOTE, "''")}'`;
  }
  if (typeof value === "number") {
    // The shortest text that reads back as the same double, made REAL where
    // it would read as an INTEGER (`1` → `1.0`), as the driver binds it.
    const text = String(value);
    return signed(INTEGER_TEXT.test(text) ? `${text}.0` : text);
  }
  // Signed 64-bit: `SQLITE_LITERALS.value` refuses any other bigint.
  if (typeof value === "bigint") return signed(String(value));
  // `convertValueForSQLite` makes a boolean the number 1 or 0: REAL too.
  if (typeof value === "boolean") return value ? "1.0" : "0.0";
  if (value instanceof Uint8Array) return `X'${hex(value)}'`;
  return refuse("sqlite", value);
}

const LITERALS: Record<SqlDialect, (value: unknown) => string> = {
  postgresql: postgresLiteral,
  mysql: mysqlLiteral,
  sqlite: sqliteLiteral,
};

/**
 * `statement` as parameter-free text for `dialect`: the sibling of
 * `Sql.toStatement`, with each placeholder replaced by its value's literal.
 * No SQL text is read, and nothing is cached on or changed in the shared
 * fragments (`Sql.peek`).
 */
export function inlineLiterals(dialect: SqlDialect, statement: Sql): string {
  const literal = LITERALS[dialect];
  const { strings, values } = Sql.peek(statement);
  let text = strings[0]!;
  for (const [index, value] of values.entries())
    text += literal(value) + strings[index + 1]!;
  return text;
}
