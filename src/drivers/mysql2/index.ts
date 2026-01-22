/**
 * MySQL2 Driver
 *
 * Driver implementation for mysql2/promise with connection pooling.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import type {
  Pool,
  PoolConnection,
  PoolOptions,
  ResultSetHeader,
} from "mysql2/promise";
import { Driver, type DriverResultParser } from "../driver";
import { mysqlResultParser, parseMySQLUrl } from "../shared";
import type { QueryResult, TransactionOptions } from "../types";

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type MySQL2Options = PoolOptions;

export interface MySQL2DriverOptions {
  pool?: Pool;
  options?: PoolOptions;
  databaseUrl?: string;
}

export type MySQL2ClientConfig<C extends DriverConfig> = MySQL2DriverOptions &
  C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class MySQL2Driver extends Driver<Pool, PoolConnection> {
  readonly adapter: DatabaseAdapter = new MySQLAdapter();
  readonly result: DriverResultParser = mysqlResultParser;

  private readonly driverOptions: MySQL2DriverOptions;

  constructor(options: MySQL2DriverOptions = {}) {
    super("mysql", "mysql2");
    this.driverOptions = options;

    if (options.pool) {
      this.client = options.pool;
    }
  }

  protected async initClient(): Promise<Pool> {
    const mysql = await import("mysql2/promise");

    let options = this.driverOptions.options ?? {};

    // Parse databaseUrl if provided (same logic as createClient)
    if (this.driverOptions.databaseUrl) {
      options = {
        ...options,
        ...parseMySQLUrl(this.driverOptions.databaseUrl),
      };
    }

    return mysql.createPool(options);
  }

  protected async closeClient(pool: Pool): Promise<void> {
    await pool.end();
  }

  protected async execute<T>(
    client: Pool | PoolConnection,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const [result] = await client.execute(sql, params);

    // Check if this is a SELECT query (returns rows) or mutation (returns ResultSetHeader)
    if (Array.isArray(result)) {
      return {
        rows: result as T[],
        rowCount: result.length,
      };
    }

    // Mutation query - result is ResultSetHeader
    const header = result as ResultSetHeader;
    return {
      rows: [] as T[],
      rowCount: header.affectedRows,
    };
  }

  protected async executeRaw<T>(
    client: Pool | PoolConnection,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const [result] = await client.query(sql, params);

    // Check if this is a SELECT query (returns rows) or mutation (returns ResultSetHeader)
    if (Array.isArray(result)) {
      return {
        rows: result as T[],
        rowCount: result.length,
      };
    }

    // Mutation query - result is ResultSetHeader
    const header = result as ResultSetHeader;
    return {
      rows: [] as T[],
      rowCount: header.affectedRows,
    };
  }

  protected async transaction<T>(
    client: Pool | PoolConnection,
    fn: (tx: PoolConnection) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    if (this.inTransaction) {
      // Nested transaction - use savepoint
      const connection = client as PoolConnection;
      const savepointName = `sp_${crypto.randomUUID().replace(/-/g, "")}`;
      await connection.query(`SAVEPOINT ${savepointName}`);

      try {
        const result = await fn(connection);
        await connection.query(`RELEASE SAVEPOINT ${savepointName}`);
        return result;
      } catch (error) {
        await connection.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        throw error;
      }
    }

    // Start a new transaction from pool
    const pool = client as Pool;
    const connection = await pool.getConnection();

    try {
      if (options?.isolationLevel) {
        const isolationMap: Record<string, string> = {
          read_uncommitted: "READ UNCOMMITTED",
          read_committed: "READ COMMITTED",
          repeatable_read: "REPEATABLE READ",
          serializable: "SERIALIZABLE",
        };
        const level = isolationMap[options.isolationLevel];
        if (!level) {
          throw new Error(`Unknown isolation level: ${options.isolationLevel}`);
        }
        await connection.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
      }

      await connection.query("BEGIN");
      this.inTransaction = true;
      const result = await fn(connection);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    // Note: this.inTransaction reset is handled by base Driver._transaction()
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<C extends DriverConfig>(
  config: MySQL2ClientConfig<C>
) {
  const { pool, options = {}, databaseUrl, ...restConfig } = config;

  if (databaseUrl) {
    Object.assign(options, parseMySQLUrl(databaseUrl));
  }

  const driver = new MySQL2Driver({
    pool,
    options,
  });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: MySQL2Driver }>;
}
