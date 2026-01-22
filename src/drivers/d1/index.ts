/**
 * Cloudflare D1 Driver (Bindings)
 *
 * Driver implementation for Cloudflare D1 using Worker bindings.
 * Note: D1 does not support true transactions - batch() provides atomicity only.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import type { D1Database } from "@cloudflare/workers-types";
import { Driver, type DriverResultParser } from "../driver";
import { convertValuesForSQLite, sqliteResultParser } from "../shared";
import type { BatchQuery, QueryResult, TransactionOptions } from "../types";

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface D1DriverOptions {
  database: D1Database;
}

export type D1ClientConfig<C extends DriverConfig> = D1DriverOptions & C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class D1Driver extends Driver<D1Database, D1Database> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly result: DriverResultParser = sqliteResultParser;
  readonly supportsTransactions = false;
  readonly supportsBatch = true;

  private readonly driverOptions: D1DriverOptions;

  constructor(options: D1DriverOptions) {
    super("sqlite", "d1");
    this.driverOptions = options;
    // D1 database is passed directly from Worker environment
    this.client = options.database;
  }

  protected async initClient(): Promise<D1Database> {
    // D1 database binding is passed in constructor
    return this.driverOptions.database;
  }

  protected async closeClient(_db: D1Database): Promise<void> {
    // D1 bindings don't need to be closed
  }

  protected async execute<T>(
    client: D1Database,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const values = convertValuesForSQLite(params);
    const stmt = client.prepare(sql).bind(...values);

    const normalized = sql.trim().toUpperCase();
    const isSelect =
      normalized.startsWith("SELECT") || normalized.startsWith("WITH");
    const isReturning = normalized.includes("RETURNING");

    if (isSelect || isReturning) {
      const result = await stmt.all<T>();
      return {
        rows: result.results,
        rowCount: result.results.length,
      };
    }

    const result = await stmt.run<T>();
    return {
      rows: result.results,
      rowCount: result.meta.changes,
    };
  }

  protected async executeRaw<T>(
    client: D1Database,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.execute<T>(client, sql, params ?? []);
  }

  protected async transaction<T>(
    client: D1Database,
    fn: (tx: D1Database) => Promise<T>,
    _options?: TransactionOptions
  ): Promise<T> {
    // D1 does not support true transactions
    // batch() provides atomicity but not isolation
    // We execute the function directly - user code should use batch() for atomic operations
    console.warn(
      "D1 does not support transactions. Operations will execute without transaction isolation. " +
        "Use batch() for atomic operations."
    );
    return fn(client);
  }

  /**
   * Execute multiple queries atomically using D1's native batch() API.
   * All queries succeed or all fail together.
   */
  protected async executeBatch<T>(
    client: D1Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    // Prepare all statements
    const statements = queries.map((query) => {
      const values = query.params ? convertValuesForSQLite(query.params) : [];
      return client.prepare(query.sql).bind(...values);
    });

    // Execute all statements atomically
    const results = await client.batch<T>(statements);

    // Map results to QueryResult format
    return results.map((result) => ({
      rows: result.results,
      rowCount: result.meta.changes ?? result.results.length,
    }));
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<C extends DriverConfig>(
  config: D1ClientConfig<C>
) {
  const { database, ...restConfig } = config;

  const driver = new D1Driver({ database });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: D1Driver }>;
}
