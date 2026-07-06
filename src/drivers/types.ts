/**
 * Driver Types
 *
 * Core types for database drivers.
 */

/**
 * Supported database dialects
 */
export type Dialect = "postgresql" | "mysql" | "sqlite";

/**
 * Query result from database execution
 */
export interface QueryResult<T = Record<string, unknown>> {
  /** Returned rows */
  rows: T[];
  /** Number of affected rows (INSERT/UPDATE/DELETE) */
  rowCount: number;
  /**
   * Auto-generated id of the inserted row, when the driver reports one
   * (MySQL drivers). Preferred over a follow-up SELECT LAST_INSERT_ID(),
   * which races on pooled connections outside transactions.
   */
  insertId?: number | bigint;
}

/**
 * Transaction isolation levels
 */
export type IsolationLevel =
  | "read_uncommitted"
  | "read_committed"
  | "repeatable_read"
  | "serializable";

/**
 * Transaction options
 */
export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  timeout?: number;
}

/**
 * Log function signature
 */
export type LogFunction = (
  query: string,
  params: unknown[],
  duration: number
) => void;

// =============================================================================
// BATCH EXECUTION TYPES
// =============================================================================

/**
 * A single query in a batch operation
 */
export interface BatchQuery {
  /** SQL string */
  sql: string;
  /** Query parameters */
  params?: unknown[];
}

/**
 * Options for batch execution
 */
export interface BatchOptions {
  /** Whether to wrap in a transaction (for drivers that support it) */
  atomic?: boolean;
}
