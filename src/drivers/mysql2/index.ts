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
import {
  getSqlIsolationLevel,
  mysqlResultParser,
  parseMySQLUrl,
  runSavepoint,
} from "../shared";
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

/** mysql2 escapes plain Uint8Array as an object — convert to Buffer for blobs. */
function convertValuesForMySQL(values: unknown[]): unknown[] {
  return values.map((v) =>
    v instanceof Uint8Array && !Buffer.isBuffer(v)
      ? Buffer.from(v.buffer, v.byteOffset, v.byteLength)
      : v
  );
}

/** SELECT returns a row array; mutations return a ResultSetHeader. */
function toQueryResult<T>(result: unknown): QueryResult<T> {
  if (Array.isArray(result)) {
    return {
      rows: result as T[],
      rowCount: result.length,
    };
  }

  const header = result as ResultSetHeader;
  return {
    rows: [] as T[],
    rowCount: header.affectedRows,
    // insertId is 0 when the statement generated no auto-increment id
    ...(header.insertId ? { insertId: header.insertId } : {}),
  };
}

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

    let options: PoolOptions = {
      // DATETIME is stored as naive UTC wall-clock; read it back as UTC
      // instead of shifting by the process timezone
      timezone: "Z",
      // BIGINT/DECIMAL values outside Number's safe range arrive as strings
      // (the result parser converts them losslessly) instead of lossy numbers
      supportBigNumbers: true,
      // DATE as plain "YYYY-MM-DD" — the result parser builds a UTC-midnight
      // Date, matching every other driver (mysql2 would build local midnight)
      dateStrings: ["DATE"],
      ...this.driverOptions.options,
    };

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
    const [result] = await client.execute(sql, convertValuesForMySQL(params));
    return toQueryResult<T>(result);
  }

  protected async executeRaw<T>(
    client: Pool | PoolConnection,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const [result] = await client.query(
      sql,
      params && convertValuesForMySQL(params)
    );
    return toQueryResult<T>(result);
  }

  protected async transaction<T>(
    client: Pool | PoolConnection,
    fn: (tx: PoolConnection) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    if (!("getConnection" in client)) {
      // Nested transaction - use savepoint
      const connection = client as PoolConnection;
      return runSavepoint(
        (statement) => connection.query(statement),
        () => fn(connection)
      );
    }

    // Start a new transaction from pool
    const pool = client as Pool;
    const connection = await pool.getConnection();

    try {
      if (options?.isolationLevel) {
        const level = getSqlIsolationLevel(options.isolationLevel);
        await connection.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
      }

      await connection.query("BEGIN");
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
