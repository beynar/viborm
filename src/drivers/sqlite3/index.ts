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
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import type { Sql } from "@sql";
import Database from "better-sqlite3";
import { LazyDriver } from "../base-driver";
import type { Driver, DriverResultParser } from "../driver";
import type { Dialect, QueryResult, TransactionOptions } from "../types";

type SQLite3Database = Database.Database;

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface SQLite3DriverOptionsConfig extends SQLite3Options {
  filename?: string;
}

export interface SQLite3DriverOptions {
  client?: SQLite3Database;
  options?: SQLite3DriverOptionsConfig;
  /** @deprecated Use options.filename */
  filename?: string;
}

export interface SQLite3ClientConfig<S extends Schema>
  extends SQLite3DriverOptions {
  schema: S;
}

// ============================================================
// HELPERS
// ============================================================

function buildSQLiteStatement(query: Sql): string {
  const len = query.strings.length;
  let i = 1;
  let result = query.strings[0] ?? "";
  while (i < len) {
    result += `?${query.strings[i] ?? ""}`;
    i++;
  }
  return result;
}

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

export class SQLite3Driver extends LazyDriver<SQLite3Database> {
  readonly dialect: Dialect = "sqlite";
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly result: DriverResultParser = sqlite3ResultParser;

  private readonly driverOptions: SQLite3DriverOptions;

  constructor(options: SQLite3DriverOptions = {}) {
    super();
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

  protected async executeWithClient<T>(
    db: SQLite3Database,
    query: Sql
  ): Promise<QueryResult<T>> {
    const statement = buildSQLiteStatement(query);
    const values = convertValuesForSQLite(query.values);
    return this.runStatement<T>(db, statement, values);
  }

  protected async executeRawWithClient<T>(
    db: SQLite3Database,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const values = params ? convertValuesForSQLite(params) : undefined;
    return this.runStatement<T>(db, sql, values);
  }

  private runStatement<T>(
    db: SQLite3Database,
    sql: string,
    values?: unknown[]
  ): QueryResult<T> {
    const stmt = db.prepare<T>(sql);
    const normalized = sql.trim().toUpperCase();
    const isSelect =
      normalized.startsWith("SELECT") || normalized.startsWith("WITH");
    const isReturning = normalized.includes("RETURNING");

    if (isSelect || isReturning) {
      const rows = values ? stmt.all(...values) : stmt.all();
      return { rows, rowCount: rows.length };
    }

    const result = values ? stmt.run(...values) : stmt.run();
    return { rows: [] as T[], rowCount: result.changes };
  }

  protected async transactionWithClient<T>(
    db: SQLite3Database,
    fn: (tx: Driver) => Promise<T>,
    _options?: TransactionOptions
  ): Promise<T> {
    const txDriver = new SQLite3TransactionDriver(db, this.adapter);

    db.exec("BEGIN");
    try {
      const result = await fn(txDriver);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

// ============================================================
// TRANSACTION DRIVER
// ============================================================

class SQLite3TransactionDriver implements Driver {
  readonly dialect: Dialect = "sqlite";
  readonly adapter: DatabaseAdapter;
  readonly result: DriverResultParser = sqlite3ResultParser;
  private readonly db: SQLite3Database;

  constructor(db: SQLite3Database, adapter: DatabaseAdapter) {
    this.db = db;
    this.adapter = adapter;
  }

  async execute<T = Record<string, unknown>>(
    query: Sql
  ): Promise<QueryResult<T>> {
    const statement = buildSQLiteStatement(query);
    const values = convertValuesForSQLite(query.values);
    return this.runStatement<T>(statement, values);
  }

  async executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const values = params ? convertValuesForSQLite(params) : undefined;
    return this.runStatement<T>(sql, values);
  }

  private runStatement<T>(sql: string, values?: unknown[]): QueryResult<T> {
    const stmt = this.db.prepare<T>(sql);
    const normalized = sql.trim().toUpperCase();
    const isSelect =
      normalized.startsWith("SELECT") || normalized.startsWith("WITH");
    const isReturning = normalized.includes("RETURNING");

    if (isSelect || isReturning) {
      const rows = values ? stmt.all(...values) : stmt.all();
      return { rows, rowCount: rows.length };
    }

    const result = values ? stmt.run(...values) : stmt.run();
    return { rows: [] as T[], rowCount: result.changes };
  }

  async transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
    const savepointName = `sp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.db.exec(`SAVEPOINT ${savepointName}`);

    try {
      const result = await fn(this);
      this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      throw error;
    }
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema>(
  config: SQLite3ClientConfig<S>
): VibORMClient<S> {
  const { client, options, filename, ...restConfig } = config;

  const driver = new SQLite3Driver({ client, options, filename });

  return baseCreateClient<S>({
    ...restConfig,
    driver,
  }) as VibORMClient<S>;
}
