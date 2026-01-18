/**
 * SQLite3 Driver
 *
 * Driver implementation for better-sqlite3 (synchronous SQLite).
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  normalizeCountResult,
  parseIntegerBoolean,
  tryParseJsonString,
} from "@adapters/shared/result-parsing";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import Database from "better-sqlite3";
import { Driver, type DriverResultParser } from "../driver";
import type { QueryResult, TransactionOptions } from "../types";

type SQLite3Database = Database.Database;

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type SQLite3Options = Database.Options;

export interface SQLite3DriverOptionsConfig extends SQLite3Options {
  filename?: string;
}

export interface SQLite3DriverOptions {
  client?: SQLite3Database;
  options?: SQLite3DriverOptionsConfig;
  /** @deprecated Use options.filename */
  filename?: string;
}

export type SQLite3ClientConfig<C extends DriverConfig> = SQLite3DriverOptions &
  C;

// ============================================================
// HELPERS
// ============================================================

function convertValuesForSQLite(values: unknown[]): unknown[] {
  return values.map((v) => {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v === undefined) return null;
    return v;
  });
}

const sqlite3ResultParser: DriverResultParser = {
  parseResult: (raw, operation, next) => {
    if (operation === "count" || operation === "exist") {
      const normalized = normalizeCountResult(raw);
      if (normalized !== undefined) return next(normalized, operation);
    }
    return next(raw, operation);
  },
  parseRelation: (value, type, next) => {
    const parsed = tryParseJsonString(value);
    if (parsed !== undefined) return next(parsed, type);
    return next(value, type);
  },
  parseField: (value, fieldType, next) => {
    if (fieldType === "boolean") {
      const parsed = parseIntegerBoolean(value);
      if (parsed !== undefined) return parsed;
    }
    return next(value, fieldType);
  },
};

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class SQLite3Driver extends Driver<SQLite3Database, SQLite3Database> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly result: DriverResultParser = sqlite3ResultParser;

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
    const opts: SQLite3Options = {};
    const explicitOptions = this.driverOptions.options;

    if (explicitOptions?.readonly !== undefined)
      opts.readonly = explicitOptions.readonly;
    if (explicitOptions?.fileMustExist !== undefined)
      opts.fileMustExist = explicitOptions.fileMustExist;
    if (explicitOptions?.timeout !== undefined)
      opts.timeout = explicitOptions.timeout;
    if (explicitOptions?.verbose !== undefined)
      opts.verbose = explicitOptions.verbose;
    if (explicitOptions?.nativeBinding !== undefined)
      opts.nativeBinding = explicitOptions.nativeBinding;

    const filename =
      explicitOptions?.filename ?? this.driverOptions.filename ?? ":memory:";

    return new Database(filename, opts);
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
  const { client, options, filename, ...restConfig } = config;

  const driver = new SQLite3Driver({ client, options, filename });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: SQLite3Driver }>;
}
