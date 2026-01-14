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
import postgres, {
  type Options as PostgresOptions,
  type Sql as PostgresSql,
} from "postgres";
import { LazyDriver } from "../base-driver";
import type { Driver } from "../driver";
import { unsupportedGeospatial, unsupportedVector } from "../../errors";
import { buildPostgresStatement } from "../postgres-utils";
import type { Dialect, QueryResult, TransactionOptions } from "../types";

export interface PostgresDriverOptions {
  client?: PostgresSql<Record<string, unknown>>;
  options?: PostgresOptions<Record<string, unknown>>;
  /** @deprecated Use options directly */
  connectionString?: string;
  pgvector?: boolean;
  postgis?: boolean;
}

export interface PostgresClientConfig<S extends Schema>
  extends PostgresDriverOptions {
  schema: S;
}

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PostgresDriver extends LazyDriver<
  PostgresSql<Record<string, unknown>>
> {
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

  protected async initClient(): Promise<PostgresSql<Record<string, unknown>>> {
    if (this.driverOptions.options) {
      return postgres(this.driverOptions.options);
    }
    if (this.driverOptions.connectionString) {
      return postgres(this.driverOptions.connectionString);
    }
    return postgres();
  }

  protected async closeClient(
    sql: PostgresSql<Record<string, unknown>>
  ): Promise<void> {
    await sql.end();
  }

  protected async executeWithClient<T>(
    sql: PostgresSql<Record<string, unknown>>,
    query: Sql
  ): Promise<QueryResult<T>> {
    const statement = buildPostgresStatement(query);
    const result = await sql.unsafe<T[]>(statement, query.values);
    return {
      rows: result as T[],
      rowCount: (result as RowList<T[]>).count ?? result.length,
    };
  }

  protected async executeRawWithClient<T>(
    sql: PostgresSql<Record<string, unknown>>,
    sqlStr: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await sql.unsafe<T[]>(sqlStr, params);
    return {
      rows: result as T[],
      rowCount: (result as RowList<T[]>).count ?? result.length,
    };
  }

  protected async transactionWithClient<T>(
    sql: PostgresSql<Record<string, unknown>>,
    fn: (tx: Driver) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const isolationMap = {
      ReadUncommitted: "read uncommitted",
      ReadCommitted: "read committed",
      RepeatableRead: "repeatable read",
      Serializable: "serializable",
    } as const;

    const isolation = options?.isolationLevel
      ? isolationMap[options.isolationLevel]
      : undefined;

    if (isolation) {
      return sql.begin(isolation, async (txSql) => {
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
  private readonly sql: PostgresSql<Record<string, unknown>>;
  private savepointCounter = 0;

  constructor(
    sql: PostgresSql<Record<string, unknown>>,
    adapter: DatabaseAdapter
  ) {
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
      rowCount: (result as RowList<T[]>).count ?? result.length,
    };
  }

  async executeRaw<T = Record<string, unknown>>(
    sqlStr: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await this.sql.unsafe<T[]>(sqlStr, params);
    return {
      rows: result as T[],
      rowCount: (result as RowList<T[]>).count ?? result.length,
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
