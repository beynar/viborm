/**
 * SQLite3 Driver
 *
 * Driver implementation for better-sqlite3 (synchronous SQLite).
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import Database from "better-sqlite3";
import { Driver, type DriverResultParser } from "../driver";
import { convertValuesForSQLite, sqliteResultParser } from "../shared";
import type { QueryResult, TransactionOptions } from "../types";

type SQLite3Database = Database.Database;

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type SQLite3Options = Database.Options;

export interface SQLite3DriverOptions {
  client?: SQLite3Database;
  dataDir?: string;
  options?: SQLite3Options;
}

export type SQLite3ClientConfig<C extends DriverConfig> = SQLite3DriverOptions &
  C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class SQLite3Driver extends Driver<SQLite3Database, SQLite3Database> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly result: DriverResultParser = sqliteResultParser;

  private readonly driverOptions: SQLite3DriverOptions;
  private savepointCounter = 0;

  constructor(options: SQLite3DriverOptions = {}) {
    super("sqlite", "sqlite3");
    this.driverOptions = options;

    if (options.client) {
      this.client = options.client;
    }
  }

  protected async initClient(): Promise<SQLite3Database> {
    const dataDir = this.driverOptions.dataDir ?? ":memory:";
    const options = this.driverOptions.options ?? {};

    return new Database(dataDir, options);
  }

  protected async closeClient(db: SQLite3Database): Promise<void> {
    db.close();
  }

  protected async execute<T>(
    client: SQLite3Database,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const values = convertValuesForSQLite(params);
    return this.runStatement<T>(client, sql, values);
  }

  protected async executeRaw<T>(
    client: SQLite3Database,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const values = params ? convertValuesForSQLite(params) : undefined;
    return this.runStatement<T>(client, sql, values);
  }

  private runStatement<T>(
    db: SQLite3Database,
    sql: string,
    values?: unknown[]
  ): QueryResult<T> {
    const stmt = db.prepare(sql);
    const normalized = sql.trim().toUpperCase();
    const isSelect =
      normalized.startsWith("SELECT") || normalized.startsWith("WITH");
    const isReturning = normalized.includes("RETURNING");

    if (isSelect || isReturning) {
      const rows = (values ? stmt.all(...values) : stmt.all()) as T[];
      return { rows, rowCount: rows.length };
    }

    const result = values ? stmt.run(...values) : stmt.run();
    return { rows: [] as T[], rowCount: result.changes };
  }

  protected async transaction<T>(
    client: SQLite3Database,
    fn: (tx: SQLite3Database) => Promise<T>,
    _options?: TransactionOptions
  ): Promise<T> {
    if (this.inTransaction) {
      // Nested transaction - use savepoint
      const savepointName = `sp_${++this.savepointCounter}_${Date.now()}`;
      client.exec(`SAVEPOINT ${savepointName}`);
      try {
        const result = await fn(client);
        client.exec(`RELEASE SAVEPOINT ${savepointName}`);
        return result;
      } catch (error) {
        client.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        throw error;
      }
    } else {
      // Start a new transaction
      client.exec("BEGIN");
      try {
        const result = await fn(client);
        client.exec("COMMIT");
        return result;
      } catch (error) {
        client.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<C extends DriverConfig>(
  config: SQLite3ClientConfig<C>
) {
  const { client, dataDir, options, ...restConfig } = config;

  const driver = new SQLite3Driver({ client, dataDir, options });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: SQLite3Driver }>;
}
