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
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { LazyDriver } from "../base-driver";
import type { Driver } from "../driver";
import { unsupportedGeospatial, unsupportedVector } from "../errors";
import { buildPostgresStatement } from "../postgres-utils";
import type { Dialect, QueryResult, TransactionOptions } from "../types";

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface PgDriverOptions {
  pool?: Pool;
  options?: PoolConfig;
  /** @deprecated Use options.connectionString */
  connectionString?: string;
  pgvector?: boolean;
  postgis?: boolean;
}

export interface PgClientConfig<S extends Schema> extends PgDriverOptions {
  schema: S;
}

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PgDriver extends LazyDriver<Pool> {
  readonly dialect: Dialect = "postgresql";
  readonly adapter: DatabaseAdapter;

  private readonly driverOptions: PgDriverOptions;

  constructor(options: PgDriverOptions = {}) {
    super();
    this.driverOptions = options;

    // If pool provided, set it directly
    if (options.pool) {
      this.client = options.pool;
    }

    // Configure adapter
    const adapter = new PostgresAdapter();
    if (!options.pgvector) adapter.vector = unsupportedVector;
    if (!options.postgis) adapter.geospatial = unsupportedGeospatial;
    this.adapter = adapter;
  }

  protected initClient(): Promise<Pool> {
    const config: PoolConfig = this.driverOptions.options
      ? { ...this.driverOptions.options }
      : {};

    if (!config.connectionString && this.driverOptions.connectionString) {
      config.connectionString = this.driverOptions.connectionString;
    }

    return Promise.resolve(new Pool(config));
  }

  protected async closeClient(pool: Pool): Promise<void> {
    await pool.end();
  }

  protected async executeWithClient<T>(
    pool: Pool,
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
    pool: Pool,
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
    pool: Pool,
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
  private readonly client: PoolClient;
  private savepointCounter = 0;

  constructor(client: PoolClient, adapter: DatabaseAdapter) {
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

  const driverOptions: PgDriverOptions = {};
  if (pool) driverOptions.pool = pool;
  if (options) driverOptions.options = options;
  if (connectionString) driverOptions.connectionString = connectionString;
  if (pgvector !== undefined) driverOptions.pgvector = pgvector;
  if (postgis !== undefined) driverOptions.postgis = postgis;

  const driver = new PgDriver(driverOptions);

  return baseCreateClient<S>({
    ...restConfig,
    driver,
  }) as VibORMClient<S>;
}
