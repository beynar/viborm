/**
 * PostgreSQL Driver (postgres.js)
 *
 * Driver implementation for postgres.js - a modern, fast PostgreSQL client.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  createClient as baseCreateClient,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import type { Sql } from "@sql";
import { LazyDriver } from "../base-driver";
import type { Driver } from "../driver";
import { unsupportedGeospatial, unsupportedVector } from "../errors";
import { buildPostgresStatement } from "../postgres-utils";
import type { Dialect, QueryResult, TransactionOptions } from "../types";

// ============================================================
// INTERFACES (matching postgres.js types)
// ============================================================

interface PostgresSql {
  unsafe<T extends Record<string, unknown>[] = Record<string, unknown>[]>(
    query: string,
    parameters?: unknown[]
  ): PostgresPromise<T>;

  begin<T>(fn: (sql: PostgresSql) => Promise<T>): Promise<T>;
  begin<T>(
    options: string | PostgresTransactionOptions,
    fn: (sql: PostgresSql) => Promise<T>
  ): Promise<T>;

  end(options?: { timeout?: number }): Promise<void>;
}

interface PostgresPromise<T> extends Promise<T> {
  count: number;
}

interface PostgresTransactionOptions {
  isolationLevel?:
    | "read uncommitted"
    | "read committed"
    | "repeatable read"
    | "serializable";
}

type PostgresConstructor = (
  connectionString?: string | PostgresOptions
) => PostgresSql;

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface PostgresOptions {
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  user?: string;
  password?: string;
  ssl?: boolean | "require" | "prefer" | "allow" | "verify-full";
  max?: number;
  idle_timeout?: number;
  connect_timeout?: number;
}

export interface PostgresDriverOptions {
  client?: PostgresSql;
  options?: PostgresOptions;
  /** @deprecated Use options directly */
  connectionString?: string;
  pgvector?: boolean;
  postgis?: boolean;
}

export interface PostgresClientConfig<S extends Schema> {
  schema: S;
  client?: PostgresSql;
  options?: PostgresOptions;
  connectionString?: string;
  pgvector?: boolean;
  postgis?: boolean;
}

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PostgresDriver extends LazyDriver<PostgresSql> {
  readonly dialect: Dialect = "postgresql";
  readonly adapter: DatabaseAdapter;

  private readonly driverOptions: PostgresDriverOptions;

  constructor(options: PostgresDriverOptions = {}) {
    super();
    this.driverOptions = options;

    // If client provided, set it directly
    if (options.client) {
      this.client = options.client;
    }

    // Configure adapter
    const adapter = new PostgresAdapter();
    if (!options.pgvector) adapter.vector = unsupportedVector;
    if (!options.postgis) adapter.geospatial = unsupportedGeospatial;
    this.adapter = adapter;
  }

  protected async initClient(): Promise<PostgresSql> {
    // @ts-expect-error - postgres types may not be installed
    const module = await import("postgres");
    const postgres = (module.default || module) as PostgresConstructor;

    if (!postgres) {
      throw new Error("postgres is not installed. Run: npm install postgres");
    }

    if (this.driverOptions.options) {
      return postgres(this.driverOptions.options);
    }
    if (this.driverOptions.connectionString) {
      return postgres(this.driverOptions.connectionString);
    }
    return postgres();
  }

  protected async closeClient(sql: PostgresSql): Promise<void> {
    await sql.end();
  }

  protected async executeWithClient<T>(
    sql: PostgresSql,
    query: Sql
  ): Promise<QueryResult<T>> {
    const statement = buildPostgresStatement(query);
    const result = await sql.unsafe<T[]>(statement, query.values);
    return {
      rows: result as T[],
      rowCount:
        (result as unknown as PostgresPromise<T[]>).count ?? result.length,
    };
  }

  protected async executeRawWithClient<T>(
    sql: PostgresSql,
    sqlStr: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await sql.unsafe<T[]>(sqlStr, params);
    return {
      rows: result as T[],
      rowCount:
        (result as unknown as PostgresPromise<T[]>).count ?? result.length,
    };
  }

  protected async transactionWithClient<T>(
    sql: PostgresSql,
    fn: (tx: Driver) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const txOptions = options?.isolationLevel
      ? {
          isolationLevel: {
            ReadUncommitted: "read uncommitted",
            ReadCommitted: "read committed",
            RepeatableRead: "repeatable read",
            Serializable: "serializable",
          }[
            options.isolationLevel
          ] as PostgresTransactionOptions["isolationLevel"],
        }
      : undefined;

    if (txOptions) {
      return sql.begin(txOptions, async (txSql) => {
        return fn(new PostgresTransactionDriver(txSql, this.adapter));
      });
    }

    return sql.begin(async (txSql) => {
      return fn(new PostgresTransactionDriver(txSql, this.adapter));
    });
  }
}

// ============================================================
// TRANSACTION DRIVER
// ============================================================

class PostgresTransactionDriver implements Driver {
  readonly dialect: Dialect = "postgresql";
  readonly adapter: DatabaseAdapter;
  private readonly sql: PostgresSql;
  private savepointCounter = 0;

  constructor(sql: PostgresSql, adapter: DatabaseAdapter) {
    this.sql = sql;
    this.adapter = adapter;
  }

  async execute<T = Record<string, unknown>>(
    query: Sql
  ): Promise<QueryResult<T>> {
    const statement = buildPostgresStatement(query);
    const result = await this.sql.unsafe<T[]>(statement, query.values);
    return {
      rows: result as T[],
      rowCount:
        (result as unknown as PostgresPromise<T[]>).count ?? result.length,
    };
  }

  async executeRaw<T = Record<string, unknown>>(
    sqlStr: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await this.sql.unsafe<T[]>(sqlStr, params);
    return {
      rows: result as T[],
      rowCount:
        (result as unknown as PostgresPromise<T[]>).count ?? result.length,
    };
  }

  async transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
    const savepointName = `sp_${++this.savepointCounter}`;
    await this.sql.unsafe(`SAVEPOINT ${savepointName}`);

    try {
      const result = await fn(this);
      await this.sql.unsafe(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      await this.sql.unsafe(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      throw error;
    }
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema>(
  config: PostgresClientConfig<S>
): VibORMClient<S> {
  const {
    client,
    options,
    connectionString,
    pgvector,
    postgis,
    ...restConfig
  } = config;

  const driver = new PostgresDriver({
    client,
    options,
    connectionString,
    pgvector,
    postgis,
  });

  return baseCreateClient<S>({
    ...restConfig,
    driver,
  }) as VibORMClient<S>;
}
