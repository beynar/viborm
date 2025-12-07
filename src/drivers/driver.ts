/**
 * Driver Interface
 *
 * Single interface for all database drivers.
 * Passed to createClient() and used by the query engine.
 */

import type { Sql } from "@sql";
import type { Dialect, QueryResult, TransactionOptions } from "./types";

/**
 * Database Driver Interface
 *
 * All database drivers (pg, mysql2, better-sqlite3, D1, etc.) implement this interface.
 * The driver is passed to createClient and used internally by the query engine.
 *
 * @example
 * ```ts
 * import { PgDriver } from "viborm/drivers/pg";
 * import { createClient } from "viborm";
 *
 * const driver = new PgDriver({ connectionString: "..." });
 * const client = createClient(driver, { user, post });
 *
 * // Driver accessible on client
 * await client.$driver.execute(sql`SELECT 1`);
 *
 * // Client operations use query engine → driver
 * await client.user.findMany({ where: { name: "Alice" } });
 * ```
 */
export interface Driver {
  /**
   * Database dialect
   */
  readonly dialect: Dialect;

  /**
   * Execute a parameterized SQL query
   *
   * @param query - SQL query built with sql template tag
   * @returns Query result with rows and rowCount
   */
  execute<T = Record<string, unknown>>(query: Sql): Promise<QueryResult<T>>;

  /**
   * Execute a raw SQL string
   *
   * ⚠️ No SQL injection protection - use with caution
   *
   * @param sql - Raw SQL string
   * @param params - Query parameters
   * @returns Query result
   */
  executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;

  /**
   * Execute a transaction
   *
   * Automatically commits on success, rolls back on error.
   * The callback receives a transactional driver instance.
   *
   * @param fn - Callback receiving transactional driver
   * @param options - Transaction options
   * @returns Result of callback
   *
   * @example
   * ```ts
   * const user = await driver.transaction(async (tx) => {
   *   const result = await tx.execute(sql`INSERT INTO users ...`);
   *   await tx.execute(sql`INSERT INTO profiles ...`);
   *   return result.rows[0];
   * });
   * ```
   */
  transaction<T>(
    fn: (tx: Driver) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T>;

  /**
   * Connect to the database (if needed)
   *
   * Some drivers (like D1) don't need explicit connection.
   * For pooled drivers, this initializes the pool.
   */
  connect?(): Promise<void>;

  /**
   * Disconnect from the database
   *
   * Closes connections/pool. Call when shutting down.
   */
  disconnect?(): Promise<void>;
}

/**
 * Type guard to check if an object is a Driver
 */
export function isDriver(obj: unknown): obj is Driver {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "dialect" in obj &&
    "execute" in obj &&
    "executeRaw" in obj &&
    "transaction" in obj
  );
}
