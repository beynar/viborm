/**
 * Driver Types
 *
 * Core types for database drivers.
 */

import type { Sql } from "@sql";

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
