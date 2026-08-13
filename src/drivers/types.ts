/**
 * Driver Types
 *
 * Core types for database drivers.
 */

/**
 * Supported database dialects
 */
export type Dialect = "postgresql" | "mysql" | "sqlite";

/** Immutable attribution captured for one driver execution. */
export interface QueryExecutionContext {
  readonly model?: string;
  readonly operation?: string;
  readonly correlationId?: string;
}

/**
 * Normalized successful result from every driver execution.
 *
 * Contract:
 * - `rows` is always an array of non-null row objects; `[]` is a valid empty
 *   result and must not be used to represent a missing provider payload.
 * - `rowCount` is always a safe, non-negative integer; zero is valid.
 * - a batch returns exactly one `QueryResult` per submitted statement, in the
 *   same order.
 * - drivers throw when a successful provider payload cannot satisfy this
 *   shape. They never manufacture rows or counts for absent/unknown payloads.
 */
export interface QueryResult<T = Record<string, unknown>> {
  /** Returned rows */
  rows: T[];
  /** Number of affected rows (INSERT/UPDATE/DELETE) */
  rowCount: number;
  /**
   * Auto-generated id of the inserted row, when the driver reports one
   * (for example MySQL `insertId` or D1 `meta.last_row_id`). Preferred over a
   * follow-up last-id query, which can lose the producing statement's exact
   * connection or batch position.
   */
  insertId?: number | bigint;
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
  /** Attribution for this statement when it represents one ORM operation. */
  context?: QueryExecutionContext;
}

/** Internal acknowledgement fired after a native batch commits, before decoding. */
export type CommittedBatchNotification = () => Promise<void>;

/**
 * Options for batch execution
 */
export interface BatchOptions {
  /** Whether to wrap in a transaction (for drivers that support it) */
  atomic?: boolean;
}
