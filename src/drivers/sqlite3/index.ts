/**
 * SQLite3 Driver
 *
 * Driver implementation for better-sqlite3 (synchronous SQLite).
 */

import { Buffer } from "node:buffer";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import Database from "better-sqlite3";
import { Driver, type DriverResultParser } from "../driver";
import {
  convertValuesForSQLite,
  isSQLiteBinaryValue,
  runTransactionLifecycle,
  sqliteBinaryToUint8Array,
  sqliteResultParser,
  type TransactionOptionSupport,
} from "../shared";
import type { QueryResult } from "../types";

type SQLite3Database = Database.Database;

function convertValuesForSQLite3(values: unknown[]): unknown[] {
  return convertValuesForSQLite(values).map((value) => {
    if (Buffer.isBuffer(value) || !isSQLiteBinaryValue(value)) {
      return value;
    }
    const bytes = sqliteBinaryToUint8Array(value);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  });
}

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
  protected override readonly serializeTransactions = true;

  private readonly driverOptions: SQLite3DriverOptions;

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
    const values = convertValuesForSQLite3(params);
    return this.runStatement<T>(client, sql, values, true);
  }

  protected async executeRaw<T>(
    client: SQLite3Database,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const values = params ? convertValuesForSQLite3(params) : undefined;
    // Raw results bypass the result parser — keep better-sqlite3's plain
    // numbers instead of surfacing BigInt to raw callers
    return this.runStatement<T>(client, sql, values, false);
  }

  private runStatement<T>(
    db: SQLite3Database,
    sql: string,
    values: unknown[] | undefined,
    safeIntegers: boolean
  ): QueryResult<T> {
    const stmt = db.prepare(sql);

    if (stmt.reader) {
      if (safeIntegers) {
        // INTEGER columns come back as BigInt so values >2^53 survive; the
        // result parser converts int columns back to number
        stmt.safeIntegers(true);
      }
      const rows = (values ? stmt.all(...values) : stmt.all()) as T[];
      return { rows, rowCount: rows.length };
    }

    const result = values ? stmt.run(...values) : stmt.run();
    return { rows: [] as T[], rowCount: result.changes };
  }

  /**
   * SQLite has no isolation-level statement: one writer at a time on one
   * connection makes every transaction serializable already. `Serializable` is
   * therefore honored by construction, with no SQL to emit; the three weaker
   * levels are refused because pretending to relax isolation we cannot relax
   * would misreport what the transaction actually guarantees.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "serializable-only",
      isolationLevelReason:
        "SQLite serializes transactions on a single connection and has no statement to weaken isolation, so only Serializable can be honored truthfully",
      timeout: true,
      maxWait: "queue",
    };
  }

  protected async transaction<T>(
    client: SQLite3Database,
    fn: (tx: SQLite3Database) => Promise<T>
  ): Promise<T> {
    let shouldClose = false;
    const executeOrClose = (statement: string) => {
      try {
        client.exec(statement);
      } catch (error) {
        shouldClose = true;
        throw error;
      }
    };
    return runTransactionLifecycle({
      begin: () => executeOrClose("BEGIN"),
      callback: () => fn(client),
      commit: () => executeOrClose("COMMIT"),
      rollback: () => executeOrClose("ROLLBACK"),
      close: () => {
        if (shouldClose) {
          client.close();
          this.client = null;
        }
      },
    });
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
