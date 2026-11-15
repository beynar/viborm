// viborm/ordering moves: the key a moved row takes, computed by the UPDATE
// that writes it, from the keys around its place (`keys.ts` for the grammar).
//
// A move computes its key so on PostgreSQL and SQLite (D1, libSQL, PGlite)
// only: MySQL refuses a subquery on the table an UPDATE writes, and its reads
// there take locks, so a move on MySQL reads its neighbours first, as its
// appends do. Respacing computes its keys so on every dialect, in a derived
// table its UPDATE joins (MySQL materializes it).
//
// The key is any key strictly between the two, not the midpoint `keyBetween`
// draws: the integer after `lower`'s where the gap holds one, else `lower`
// extended by a random pair of digits, behind as many zeros as keep it below
// `upper` where `upper` extends `lower`. A key grows by one or two digits
// each time a row is placed into the same gap; past MAX_KEY_LENGTH, or
// between tied keys, the expression is NULL, and the move respaces the list.

import type { ModelSql } from "../index";
import { type Sql, sql } from "../sql/sql";
import { MAX_KEY_LENGTH } from "./keys";

const ZEROS = sql.raw(`'${"0".repeat(MAX_KEY_LENGTH)}'`);
const POWERS = sql.raw("'1000000000'");

/**
 * Each field of `values` equal to its value, under `alias` where given; a
 * NULL one is `nothing` (`IS NULL`, SurrealDB's `= NONE`).
 */
export const equal = (
  q: ModelSql,
  values: Readonly<Record<string, unknown>>,
  nothing: string,
  alias?: string
): Sql[] =>
  Object.entries(values).map(([field, value]) =>
    value === null
      ? sql`${q.column(field, alias)} ${sql.raw(nothing)}`
      : sql`${q.column(field, alias)} = ${q.value(field, value)}`
  );

/** The dialect's spellings the key expression needs. */
export interface Spelling {
  /** `a` and `b` equal, NULL equal to NULL. */
  readonly same: (a: Sql, b: Sql) => Sql;
  /** `key` holds two digits or more and nothing else. */
  readonly digits: (key: Sql) => Sql;
  readonly small: (value: Sql) => Sql;
  readonly big: (value: Sql) => Sql;
  readonly pad: (text: Sql, length: Sql) => Sql;
  /** Text concatenated (MySQL's `||` is OR). */
  readonly concat: (...parts: Sql[]) => Sql;
  readonly text: (value: Sql) => Sql;
  /** `text` without its leading zeros. */
  readonly trimZeros: (text: Sql) => Sql;
  /** Ends a derived table its outer query must not flatten (PostgreSQL
   * would copy its subqueries into every reference to its columns). */
  readonly fence: Sql;
  /** `text` from its `start`th character, `count` of them or to its end. */
  readonly substr: (text: Sql, start: Sql, count?: Sql) => Sql;
  /** The characters of `text`. */
  readonly length: (text: Sql) => Sql;
  /** A condition that never holds. */
  readonly never: Sql;
  /**
   * `SELECT columns FROM body AS t JOIN body AS m ON on`: `body` named once
   * where a derived table may hold a WITH, spelled twice where not (T-SQL).
   */
  readonly selfJoin: (body: Sql, columns: Sql, on: Sql) => Sql;
}

/** PostgreSQL's and SQLite's spellings of text. */
const piped = {
  concat: (...parts: Sql[]) => sql`(${sql.join(parts, " || ")})`,
  text: (value: Sql) => sql`CAST(${value} AS TEXT)`,
  trimZeros: (text: Sql) => sql`ltrim(${text}, '0')`,
};
const integer = (value: Sql) => sql`CAST(${value} AS INTEGER)`;
const signed = (value: Sql) => sql`CAST(${value} AS SIGNED)`;
/** What every dialect but SQL Server spells alike. */
const standard = {
  substr: (text: Sql, start: Sql, count?: Sql) =>
    count === undefined
      ? sql`substr(${text}, ${start})`
      : sql`substr(${text}, ${start}, ${count})`,
  length: (text: Sql) => sql`length(${text})`,
  never: sql`FALSE`,
  selfJoin: (body: Sql, columns: Sql, on: Sql) =>
    sql`WITH g AS (${body}) SELECT ${columns} FROM g AS t JOIN g AS m ON ${on}`,
};

/** A dialect a statement spells a key in: every one but SurrealDB. */
export type KeyDialect = Exclude<ModelSql["dialect"], "surrealql">;

/** Every SQL dialect spells a key: a new one is a compile error here. */
export const spellings: Readonly<Record<KeyDialect, Spelling>> = {
  postgresql: {
    // Not IS NOT DISTINCT FROM, which no index serves.
    same: (a, b) => sql`(${a} = ${b} OR (${a} IS NULL AND ${b} IS NULL))`,
    digits: (key) => sql`${key} ~ '^[0-9]{2,}$'`,
    small: (value) => sql`CAST(${value} AS integer)`,
    big: (value) => sql`CAST(${value} AS bigint)`,
    pad: (text, length) => sql`lpad(${text}, ${length}, '0')`,
    ...piped,
    ...standard,
    fence: sql` OFFSET 0`,
  },
  sqlite: {
    same: (a, b) => sql`${a} IS ${b}`,
    digits: (key) => sql`length(${key}) >= 2 AND ${key} NOT GLOB '*[^0-9]*'`,
    small: integer,
    big: integer,
    pad: (text, length) => sql`substr('000000000' || ${text}, -(${length}))`,
    ...piped,
    ...standard,
    fence: sql.empty,
  },
  mysql: {
    same: (a, b) => sql`${a} <=> ${b}`,
    digits: (key) => sql`${key} REGEXP '^[0-9]{2,}$'`,
    small: signed,
    big: signed,
    pad: (text, length) => sql`LPAD(${text}, ${length}, '0')`,
    concat: (...parts) => sql`CONCAT(${sql.join(parts, ", ")})`,
    text: (value) => sql`CAST(${value} AS CHAR)`,
    trimZeros: (text) => sql`TRIM(LEADING '0' FROM ${text})`,
    ...standard,
    fence: sql.empty,
  },
  // T-SQL: SUBSTRING and LEN, no boolean literal, no WITH inside a derived
  // table. LTRIM takes the characters to trim from SQL Server 2022.
  mssql: {
    same: (a, b) => sql`(${a} = ${b} OR (${a} IS NULL AND ${b} IS NULL))`,
    digits: (key) => sql`LEN(${key}) >= 2 AND ${key} NOT LIKE '%[^0-9]%'`,
    small: (value) => sql`CAST(${value} AS INT)`,
    big: (value) => sql`CAST(${value} AS BIGINT)`,
    pad: (text, length) =>
      sql`RIGHT(CONCAT(REPLICATE('0', ${length}), ${text}), ${length})`,
    concat: (...parts) => sql`CONCAT(${sql.join(parts, ", ")})`,
    text: (value) => sql`CAST(${value} AS VARCHAR(40))`,
    trimZeros: (text) => sql`LTRIM(${text}, '0')`,
    fence: sql.empty,
    substr: (text, start, count) =>
      sql`SUBSTRING(${text}, ${start}, ${count ?? sql`4000`})`,
    length: (text) => sql`LEN(${text})`,
    never: sql`1 = 0`,
    selfJoin: (body, columns, on) =>
      sql`SELECT ${columns} FROM (${body}) AS t JOIN (${body}) AS m ON ${on}`,
  },
};

/** The integer a key's integer part encodes; NULL for a malformed one. */
function decoded(s: Spelling, key: Sql): Sql {
  const one = sql`1`;
  const head = s.small(s.substr(key, one, one));
  const second = s.small(s.substr(key, sql`2`, one));
  return sql`CASE WHEN ${s.substr(key, one, one)} = '0' THEN ${s.big(
    sql`NULLIF(${s.substr(key, sql`3`, sql`9 - ${second}`)}, '')`
  )} - ${s.big(s.substr(POWERS, one, sql`10 - ${second}`))} ELSE ${s.big(
    sql`NULLIF(${s.substr(key, sql`2`, head)}, '')`
  )} END`;
}

/** The integer part encoding `value` (a column `n`); NULL past 10^9. */
function encoded(s: Spelling, value: Sql): Sql {
  const n = sql.raw("e.n");
  const width = s.length(s.text(sql`-${n}`));
  return sql`(SELECT CASE WHEN ${n} IS NULL OR ${n} > 999999999 OR ${n} < -999999999 THEN NULL WHEN ${n} >= 0 THEN ${s.concat(
    s.text(s.length(s.text(n))),
    s.text(n)
  )} ELSE ${s.concat(
    sql`'0'`,
    s.text(sql`9 - ${width}`),
    s.pad(
      s.text(sql`${s.big(s.substr(POWERS, sql`1`, sql`${width} + 1`))} + ${n}`),
      width
    )
  )} END FROM (SELECT ${value} AS n${s.fence}) AS e)`;
}

/**
 * A key strictly between `lower` and `upper` (SQL scalars, NULL an open
 * end), with `jitter` (two digits, the last not zero) as its random part;
 * NULL where none is computed: tied or unordered bounds, a malformed one, an
 * anchor (`required`) that is missing, a key past MAX_KEY_LENGTH. `jitter`
 * may be an expression (respacing's rank digits, fixed width, the last
 * not zero).
 */
export function between(
  s: Spelling,
  lower: Sql,
  upper: Sql,
  jitter: string | Sql,
  required?: "lower" | "upper"
): Sql {
  const lo = sql.raw("c.lo");
  const hi = sql.raw("c.hi");
  const il = sql.raw("c.il");
  const ih = sql.raw("c.ih");
  const r = typeof jitter === "string" ? sql`${jitter}` : jitter;
  const rest = s.substr(hi, sql`${s.length(lo)} + 1`);
  const zeros = sql`${s.length(rest)} - ${s.length(s.trimZeros(rest))} + 1`;
  const missing = required
    ? sql`${required === "lower" ? lo : hi} IS NULL`
    : s.never;
  const key = sql`CASE
    WHEN ${missing} THEN NULL
    WHEN ${lo} IS NULL AND ${hi} IS NULL THEN ${s.concat(sql`'10'`, r)}
    WHEN ${hi} IS NULL THEN ${s.concat(encoded(s, sql`CASE WHEN ${il} < 0 THEN 0 ELSE ${il} + 1 END`), r)}
    WHEN ${lo} IS NULL THEN ${s.concat(encoded(s, sql`${ih} - 1`), r)}
    WHEN NOT (${lo} < ${hi}) THEN NULL
    WHEN ${ih} - ${il} >= 2 THEN ${s.concat(encoded(s, sql`${il} + 1`), r)}
    WHEN ${s.substr(hi, sql`1`, s.length(lo))} = ${lo} THEN ${s.concat(lo, s.substr(ZEROS, sql`1`, zeros), r)}
    ELSE ${s.concat(lo, r)}
  END`;
  return sql`(SELECT CASE WHEN ${s.length(sql.raw("d.k"))} <= ${sql.raw(String(MAX_KEY_LENGTH))} THEN d.k END FROM (SELECT ${key} AS k FROM (SELECT b.lo, b.hi, ${decoded(s, sql.raw("b.lo"))} AS il, ${decoded(s, sql.raw("b.hi"))} AS ih FROM (SELECT (${lower}) AS lo, (${upper}) AS hi${s.fence}) AS b${s.fence}) AS c${s.fence}) AS d)`;
}

/** Two random digits, the last not zero: a moved key's random part. */
export function jitter(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const digits = [...bytes].filter((byte) => byte < 250).map((b) => b % 10);
  const first = digits[0] ?? 5;
  const last = digits.slice(1).find((digit) => digit !== 0) ?? 5;
  return `${first}${last}`;
}
