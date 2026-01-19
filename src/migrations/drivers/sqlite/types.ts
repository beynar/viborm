/**
 * SQLite Introspection Types
 *
 * Types representing the structure of SQLite PRAGMA results.
 */

export interface SqliteTable {
  name: string;
}

export interface SqliteColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface SqliteIndex {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

export interface SqliteIndexColumn {
  seqno: number;
  cid: number;
  name: string;
}

export interface SqliteForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}
