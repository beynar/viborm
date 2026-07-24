/**
 * Bun SQLite Driver
 *
 * Driver implementation for Bun's built-in SQLite (bun:sqlite).
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import { Driver, type DriverResultParser } from "../driver";
import {
  convertValuesForSQLite,
  isSQLiteBinaryValue,
  runTransactionLifecycle,
  sqliteBinaryToUint8Array,
  sqliteResultParser,
} from "../shared";
import type { QueryResult } from "../types";

// ============================================================
// TYPE DECLARATIONS FOR BUN:SQLITE
// ============================================================

// Bun's Database type - we define inline to avoid requiring bun types at compile time
interface BunSQLiteDatabase {
  query<T = unknown>(sql: string): BunSQLiteStatement<T>;
  prepare<T = unknown>(sql: string): BunSQLiteStatement<T>;
  run(sql: string, ...params: unknown[]): void;
  exec(sql: string): void;
  close(): void;
  transaction<T>(fn: () => T): () => T;
}

interface BunSQLiteStatement<T = unknown> {
  readonly columnNames: string[];
  all(...params: unknown[]): T[];
  get(...params: unknown[]): T | null;
  run(...params: unknown[]): {
    changes: number;
    lastInsertRowid: number | bigint;
  };
  values(...params: unknown[]): unknown[][];
}

function convertValuesForBunSQLite(values: unknown[]): unknown[] {
  return convertValuesForSQLite(values).map((value) => {
    if (value instanceof Uint8Array || !isSQLiteBinaryValue(value)) {
      return value;
    }
    return sqliteBinaryToUint8Array(value);
  });
}

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface BunSQLiteOptions {
  readonly?: boolean;
  create?: boolean;
  readwrite?: boolean;
  strict?: boolean;
}

export interface BunSQLiteDriverOptions {
  client?: BunSQLiteDatabase;
  dataDir?: string;
  options?: BunSQLiteOptions;
}

export type BunSQLiteClientConfig<C extends DriverConfig> =
  BunSQLiteDriverOptions & C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class BunSQLiteDriver extends Driver<
  BunSQLiteDatabase,
  BunSQLiteDatabase
> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly result: DriverResultParser = sqliteResultParser;
  protected override readonly serializeTransactions = true;

  private readonly driverOptions: BunSQLiteDriverOptions;

  constructor(options: BunSQLiteDriverOptions = {}) {
    super("sqlite", "bun-sqlite");
    this.driverOptions = options;

    if (options.client) {
      this.client = options.client;
    }
  }

  protected async initClient(): Promise<BunSQLiteDatabase> {
    // Dynamic import for bun:sqlite
    const { Database } = await import("bun:sqlite");

    const dataDir = this.driverOptions.dataDir ?? ":memory:";
    const options = this.driverOptions.options ?? {};

    return new Database(dataDir, options) as unknown as BunSQLiteDatabase;
  }

  protected async closeClient(db: BunSQLiteDatabase): Promise<void> {
    db.close();
  }

  protected async execute<T>(
    client: BunSQLiteDatabase,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const values = convertValuesForBunSQLite(params);
    return this.runStatement<T>(client, sql, values);
  }

  protected async executeRaw<T>(
    client: BunSQLiteDatabase,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const values = params ? convertValuesForBunSQLite(params) : undefined;
    return this.runStatement<T>(client, sql, values);
  }

  private runStatement<T>(
    db: BunSQLiteDatabase,
    sql: string,
    values?: unknown[]
  ): QueryResult<T> {
    const stmt = db.prepare(sql);

    if (stmt.columnNames.length > 0) {
      const rows = (values ? stmt.all(...values) : stmt.all()) as T[];
      return { rows, rowCount: rows.length };
    }

    const result = values ? stmt.run(...values) : stmt.run();
    return { rows: [] as T[], rowCount: result.changes };
  }

  protected async transaction<T>(
    client: BunSQLiteDatabase,
    fn: (tx: BunSQLiteDatabase) => Promise<T>
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
  config: BunSQLiteClientConfig<C>
) {
  const { client, dataDir, options, ...restConfig } = config;

  const driver = new BunSQLiteDriver({ client, dataDir, options });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: BunSQLiteDriver }>;
}
