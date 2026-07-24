import type { Sql } from "@sql";

/**
 * Type for query parts assembly
 */
export interface QueryParts {
  columns: Sql;
  from: Sql;
  joins?: Sql[];
  where?: Sql;
  groupBy?: Sql;
  having?: Sql;
  orderBy?: Sql;
  limit?: Sql;
  offset?: Sql;
  /** DISTINCT ON columns (PostgreSQL), or simulated via ROW_NUMBER() (MySQL/SQLite) */
  distinct?: Sql;
  /** Column alias names for outer SELECT when using DISTINCT simulation (MySQL/SQLite) */
  distinctColumnAliases?: string[];
  /**
   * Add FOR UPDATE clause for row locking.
   * Used by identity-bearing mutation and relation-target probes.
   * PostgreSQL/MySQL: FOR UPDATE
   * SQLite: No-op (SQLite uses database-level locking)
   */
  forUpdate?: boolean;
}

/**
 * Type for insert parts assembly
 */
export interface InsertParts {
  table: Sql;
  columns: string[];
  values: Sql[][];
  onConflict?: Sql;
  returning?: Sql;
}

/**
 * Type for update parts assembly
 */
export interface UpdateParts {
  table: Sql;
  set: Sql;
  where?: Sql;
  returning?: Sql;
}

/**
 * Type for delete parts assembly
 */
export interface DeleteParts {
  table: Sql;
  where?: Sql;
  returning?: Sql;
}
