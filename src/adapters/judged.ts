/**
 * How each SQL dialect spells the judgement of the rows a write produces
 * (permissions plan K4, R4): the assertion a produced row is held to, and
 * the produced rows as one FROM item typed by their table. Only what judges
 * written rows imports this module, by the dialect of the call's driver, so
 * an application that judges none does not carry these spellings; the
 * call's adapter quotes the identifiers.
 */
import type { Dialect, SqlDialect } from "@drivers/types";
import { type Sql, sql } from "@sql";
import type { DatabaseAdapter } from "./database-adapter";
import { MYSQL_JUDGED } from "./databases/mysql/judged";
import { POSTGRES_JUDGED } from "./databases/postgres/judged";
import { SQLITE_JUDGED } from "./databases/sqlite/judged";

/** The produced rows' table, read empty: what types their columns. */
export interface TypedHead {
  /** The empty read of those columns (`… WHERE FALSE`). */
  readonly head: Sql;
  readonly from: Sql;
  /** The table itself, unaliased: its row type names the columns' types. */
  readonly table: Sql;
  readonly alias: string;
  readonly columns: readonly string[];
}

/** One dialect's spelling of a judged write. */
export interface JudgedSpelling {
  /**
   * What fails the statement where a produced row is refused: an error
   * naming the sentinel `__viborm_refused__`, which no caller's own failure
   * in the same statement does (E5.6), so the driver maps it by the
   * sentinel and the marker of {@link holds}.
   */
  readonly refused: string;
  /**
   * `rows` as ONE FROM item `alias` whose columns are `typed.columns`, each
   * typed as that column of the table `typed.from` reads under
   * `typed.alias`; a row lists its values in `columns`' order and may refer
   * to the enclosing query. The form is the dialect's, because every one
   * spends a different limit on the row count first; the bind budget stays
   * the only bound on a chunk (ENG-3, review 2).
   */
  readonly typedRows: (
    a: DatabaseAdapter,
    typed: TypedHead,
    rows: readonly (readonly Sql[])[],
    alias: string
  ) => Sql;
}

/**
 * The produced rows after their typed head, as one derived table: the head's
 * columns type every row (the forms of SQLite and MySQL).
 */
export const afterHead = (
  a: DatabaseAdapter,
  typed: TypedHead,
  rows: Sql,
  alias: string
): Sql =>
  sql`(${typed.head} UNION ALL ${rows}) AS ${a.identifiers.escape(alias)}`;

/**
 * Each SQL dialect's spelling, by the name its drivers declare. The adapter
 * interface no longer makes a new SQL dialect spell a judged write, so this
 * table does: one left out is a compile error, not a judged write failing
 * on `undefined` at its first call.
 */
export const JUDGED: Partial<Record<Dialect, JudgedSpelling>> = {
  postgresql: POSTGRES_JUDGED,
  sqlite: SQLITE_JUDGED,
  mysql: MYSQL_JUDGED,
} satisfies Record<SqlDialect, JudgedSpelling>;

/**
 * A one-column SELECT answering 1 where `condition` holds (over `from`'s
 * row when given), failing the statement it is part of otherwise, NULL
 * included: the guard a write carries for the row it produces, read as a
 * scalar inside that write, and marked as a judgement by its column's name.
 */
export const holds = (
  a: DatabaseAdapter,
  spelling: JudgedSpelling,
  condition: Sql,
  from?: Sql
): Sql =>
  sql`SELECT CASE WHEN ${condition} THEN 1 ELSE ${sql.raw(spelling.refused)} END AS ${a.identifiers.escape("__viborm_judged__")}${from ? sql` FROM ${from}` : sql``}`;
