/**
 * SQLite Introspection Types
 *
 * Types representing the structure of SQLite PRAGMA results.
 */

export interface SqliteTable {
  name: string;
  /**
   * The `CREATE TABLE` statement SQLite stored, verbatim.
   *
   * Read for the reserved decimal CHECK constraints, which are the only place
   * a column's declared precision and scale survive on a dialect whose type
   * name carries neither and whose `PRAGMA table_info` reports no constraint.
   * `null` for a table with no stored statement (SQLite's own internal ones,
   * which this query already excludes).
   */
  sql: string | null;
}

/**
 * A pragma's integer column. SQLite reports an integer, but the driver decides
 * how it arrives: the LibSQL driver runs with `intMode: "bigint"`, so these
 * reach the introspection as BigInt rather than number.
 */
export type SqliteInt = number | bigint;

export interface SqliteColumn {
  cid: SqliteInt;
  name: string;
  type: string;
  notnull: SqliteInt;
  dflt_value: string | null;
  pk: SqliteInt;
}

export interface SqliteIndex {
  name: string;
  unique: SqliteInt;
  origin: string;
  partial: SqliteInt;
}

export interface SqliteIndexColumn {
  seqno: SqliteInt;
  cid: SqliteInt;
  name: string;
}

export interface SqliteForeignKey {
  id: SqliteInt;
  seq: SqliteInt;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}
