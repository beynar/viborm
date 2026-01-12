/**
 * PostgreSQL Driver (node-postgres)
 *
 * Driver implementation for pg (node-postgres) with connection pooling.
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
// INTERFACES (matching pg package types)
// ============================================================

interface PgPool {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<PgQueryResult<T>>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

interface PgPoolClient {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<PgQueryResult<T>>;
  release(err?: Error | boolean): void;
}

interface PgQueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

interface PgPoolConstructor {
  new (config?: PgPoolConfig): PgPool;
}

interface PgPoolConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  max?: number;
  min?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface PgOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  max?: number;
  min?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export interface PgDriverOptions {
  pool?: PgPool;
  options?: PgOptions;
  /** @deprecated Use options.connectionString */
  connectionString?: string;
  pgvector?: boolean;
  postgis?: boolean;
}

export interface PgClientConfig<S extends Schema> {
  schema: S;
  pool?: PgPool;
  options?: PgOptions;
  connectionString?: string;
  pgvector?: boolean;
  postgis?: boolean;
}

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PgDriver extends LazyDriver<PgPool> {
  readonly dialect: Dialect = "postgresql";
  readonly adapter: DatabaseAdapter;

  private readonly driverOptions: PgDriverOptions;

  constructor(options: PgDriverOptions = {}) {
    super();
    this.driverOptions = options;

    // If pool provided, set it directly (bypass lazy init)
    if (options.pool) {
      this.client = options.pool;
    }

    // Configure adapter
    const adapter = new PostgresAdapter();
    if (!options.pgvector) adapter.vector = unsupportedVector;
    if (!options.postgis) adapter.geospatial = unsupportedGeospatial;
    this.adapter = adapter;
  }

  protected async initClient(): Promise<PgPool> {
    // @ts-expect-error - pg types may not be installed
    const module = await import("pg");
    const Pool = (module.Pool || module.default?.Pool) as PgPoolConstructor;

    if (!Pool) {
      throw new Error("pg is not installed. Run: npm install pg");
    }

    const config: PgPoolConfig = this.driverOptions.options
      ? { ...this.driverOptions.options }
      : {};

    if (!config.connectionString && this.driverOptions.connectionString) {
      config.connectionString = this.driverOptions.connectionString;
    }

    return new Pool(config);
  }

  protected async closeClient(pool: PgPool): Promise<void> {
    await pool.end();
  }

  protected async executeWithClient<T>(
    pool: PgPool,
    query: Sql
  ): Promise<QueryResult<T>> {
    const statement = buildPostgresStatement(query);
    const result = await pool.query<T>(statement, query.values);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  protected async executeRawWithClient<T>(
    pool: PgPool,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await pool.query<T>(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  protected async transactionWithClient<T>(
    pool: PgPool,
    fn: (tx: Driver) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const client = await pool.connect();

    try {
      let beginStatement = "BEGIN";
      if (options?.isolationLevel) {
        const isolationMap = {
          ReadUncommitted: "READ UNCOMMITTED",
          ReadCommitted: "READ COMMITTED",
          RepeatableRead: "REPEATABLE READ",
          Serializable: "SERIALIZABLE",
        };
        beginStatement = `BEGIN ISOLATION LEVEL ${isolationMap[options.isolationLevel]}`;
      }

      await client.query(beginStatement);
      const txDriver = new PgTransactionDriver(client, this.adapter);
      const result = await fn(txDriver);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

// ============================================================
// TRANSACTION DRIVER
// ============================================================

class PgTransactionDriver implements Driver {
  readonly dialect: Dialect = "postgresql";
  readonly adapter: DatabaseAdapter;
  private readonly client: PgPoolClient;
  private savepointCounter = 0;

  constructor(client: PgPoolClient, adapter: DatabaseAdapter) {
    this.client = client;
    this.adapter = adapter;
  }

  async execute<T = Record<string, unknown>>(
    query: Sql
  ): Promise<QueryResult<T>> {
    const statement = buildPostgresStatement(query);
    const result = await this.client.query<T>(statement, query.values);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  async executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await this.client.query<T>(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  async transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
    const savepointName = `sp_${++this.savepointCounter}`;
    await this.client.query(`SAVEPOINT ${savepointName}`);

    try {
      const result = await fn(this);
      await this.client.query(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      throw error;
    }
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema>(
  config: PgClientConfig<S>
): VibORMClient<S> {
  const { pool, options, connectionString, pgvector, postgis, ...restConfig } =
    config;

  const driver = new PgDriver({
    pool,
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
