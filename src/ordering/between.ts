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

import { InsertValue } from "../query-engine/raptor3/shared/insert-value";
import { type Sql, sql } from "../sql/sql";
import { MAX_KEY_LENGTH } from "./keys";

const ZEROS = sql.raw(`'${"0".repeat(MAX_KEY_LENGTH)}'`);
const POWERS = sql.raw("'1000000000'");

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
}

const piped = (...parts: Sql[]) => sql`(${sql.join(parts, " || ")})`;
const asText = (value: Sql) => sql`CAST(${value} AS TEXT)`;

export const spellings: Readonly<
  Record<"postgresql" | "sqlite" | "mysql", Spelling>
> = {
  postgresql: {
    // Not IS NOT DISTINCT FROM, which no index serves.
    same: (a, b) => sql`(${a} = ${b} OR (${a} IS NULL AND ${b} IS NULL))`,
    digits: (key) => sql`${key} ~ '^[0-9]{2,}$'`,
    small: (value) => sql`CAST(${value} AS integer)`,
    big: (value) => sql`CAST(${value} AS bigint)`,
    pad: (text, length) => sql`lpad(${text}, ${length}, '0')`,
    concat: piped,
    text: asText,
    trimZeros: (text) => sql`ltrim(${text}, '0')`,
    fence: sql` OFFSET 0`,
  },
  sqlite: {
    same: (a, b) => sql`${a} IS ${b}`,
    digits: (key) => sql`length(${key}) >= 2 AND ${key} NOT GLOB '*[^0-9]*'`,
    small: (value) => sql`CAST(${value} AS INTEGER)`,
    big: (value) => sql`CAST(${value} AS INTEGER)`,
    pad: (text, length) => sql`substr('000000000' || ${text}, -(${length}))`,
    concat: piped,
    text: asText,
    trimZeros: (text) => sql`ltrim(${text}, '0')`,
    fence: sql.empty,
  },
  mysql: {
    same: (a, b) => sql`${a} <=> ${b}`,
    digits: (key) => sql`${key} REGEXP '^[0-9]{2,}$'`,
    small: (value) => sql`CAST(${value} AS SIGNED)`,
    big: (value) => sql`CAST(${value} AS SIGNED)`,
    pad: (text, length) => sql`LPAD(${text}, ${length}, '0')`,
    concat: (...parts) => sql`CONCAT(${sql.join(parts, ", ")})`,
    text: (value) => sql`CAST(${value} AS CHAR)`,
    trimZeros: (text) => sql`TRIM(LEADING '0' FROM ${text})`,
    fence: sql.empty,
  },
};

/** The integer a key's integer part encodes; NULL for a malformed one. */
function decoded(s: Spelling, key: Sql): Sql {
  const head = s.small(sql`substr(${key}, 1, 1)`);
  const second = s.small(sql`substr(${key}, 2, 1)`);
  return sql`CASE WHEN substr(${key}, 1, 1) = '0' THEN ${s.big(
    sql`NULLIF(substr(${key}, 3, 9 - ${second}), '')`
  )} - ${s.big(sql`substr(${POWERS}, 1, 10 - ${second})`)} ELSE ${s.big(
    sql`NULLIF(substr(${key}, 2, ${head}), '')`
  )} END`;
}

/** The integer part encoding `value` (a column `n`); NULL past 10^9. */
function encoded(s: Spelling, value: Sql): Sql {
  const n = sql.raw("e.n");
  const width = sql`length(${s.text(sql`-${n}`)})`;
  return sql`(SELECT CASE WHEN ${n} IS NULL OR ${n} > 999999999 OR ${n} < -999999999 THEN NULL WHEN ${n} >= 0 THEN ${s.concat(
    s.text(sql`length(${s.text(n)})`),
    s.text(n)
  )} ELSE ${s.concat(
    sql`'0'`,
    s.text(sql`9 - ${width}`),
    s.pad(
      s.text(sql`${s.big(sql`substr(${POWERS}, 1, ${width} + 1)`)} + ${n}`),
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
  const rest = sql`substr(${hi}, length(${lo}) + 1)`;
  const zeros = sql`length(${rest}) - length(${s.trimZeros(rest)}) + 1`;
  const missing =
    required === undefined
      ? sql`FALSE`
      : required === "lower"
        ? sql`${lo} IS NULL`
        : sql`${hi} IS NULL`;
  const key = sql`CASE
    WHEN ${missing} THEN NULL
    WHEN ${lo} IS NULL AND ${hi} IS NULL THEN ${s.concat(sql`'10'`, r)}
    WHEN ${hi} IS NULL THEN ${s.concat(encoded(s, sql`CASE WHEN ${il} < 0 THEN 0 ELSE ${il} + 1 END`), r)}
    WHEN ${lo} IS NULL THEN ${s.concat(encoded(s, sql`${ih} - 1`), r)}
    WHEN NOT (${lo} < ${hi}) THEN NULL
    WHEN ${ih} - ${il} >= 2 THEN ${s.concat(encoded(s, sql`${il} + 1`), r)}
    WHEN substr(${hi}, 1, length(${lo})) = ${lo} THEN ${s.concat(lo, sql`substr(${ZEROS}, 1, ${zeros})`, r)}
    ELSE ${s.concat(lo, r)}
  END`;
  return sql`(SELECT CASE WHEN length(d.k) <= ${sql.raw(String(MAX_KEY_LENGTH))} THEN d.k END FROM (SELECT ${key} AS k FROM (SELECT b.lo, b.hi, ${decoded(s, sql.raw("b.lo"))} AS il, ${decoded(s, sql.raw("b.hi"))} AS ih FROM (SELECT (${lower}) AS lo, (${upper}) AS hi${s.fence}) AS b${s.fence}) AS c${s.fence}) AS d)`;
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

/** A value the UPDATE (or INSERT) computes: the expression, as written. */
export class Computed extends InsertValue {
  readonly expression: Sql;
  constructor(expression: Sql) {
    super();
    this.expression = expression;
  }
  compute(): readonly unknown[] {
    return [this.expression];
  }
}
