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
  RowDataPacket,
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
  private savepointCounter = 0;

  constructor(options: MySQL2DriverOptions = {}) {
    super("mysql", "mysql2");
    this.driverOptions = options;

    if (options.pool) {
      this.client = options.pool;
    }
  }

  protected async initClient(): Promise<Pool> {
    const mysql = await import("mysql2/promise");
    return mysql.createPool(this.driverOptions.options ?? {});
  }

  protected async closeClient(pool: Pool): Promise<void> {
    await pool.end();
  }

  protected async execute<T>(
    client: Pool | PoolConnection,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const [rows] = await client.execute<RowDataPacket[]>(sql, params);
    return {
      rows: rows as T[],
      rowCount: rows.length,
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
    // Check if we're already in a transaction (client is PoolConnection)
    const isNested =
      "release" in client && typeof client.release === "function";

    if (!isNested) {
      // Start a new transaction from pool
      const pool = client as Pool;
      const connection = await pool.getConnection();

      try {
        const beginStatement = "BEGIN";
        if (options?.isolationLevel) {
          const isolationMap = {
            read_uncommitted: "READ UNCOMMITTED",
            read_committed: "READ COMMITTED",
            repeatable_read: "REPEATABLE READ",
            serializable: "SERIALIZABLE",
          };
          const level = isolationMap[options.isolationLevel];
          await connection.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
        }

        await connection.query(beginStatement);
        const result = await fn(connection);
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    }

    // Nested transaction - use savepoint
    const connection = client as PoolConnection;
    const savepointName = `sp_${++this.savepointCounter}_${Date.now()}`;
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
