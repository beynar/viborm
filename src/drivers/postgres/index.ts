/**
 * PostgreSQL Driver (postgres.js)
 *
 * Driver implementation for postgres.js - a modern, fast PostgreSQL client.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import postgres, {
  type Options as PostgresOptionsType,
  type Sql as PostgresSql,
} from "postgres";
import { unsupportedGeospatial, unsupportedVector } from "@errors";
import { Driver } from "../driver";
import type { QueryResult, TransactionOptions } from "../types";

export type PostgresOptions = PostgresOptionsType<
  Record<string, postgres.PostgresType>
>;

type PostgresTransaction = postgres.TransactionSql<Record<string, unknown>>;

export interface PostgresDriverOptions {
  client?: PostgresSql<Record<string, unknown>>;
  options?: PostgresOptions;
  pgvector?: boolean;
  postgis?: boolean;
}

export type PostgresClientConfig<C extends DriverConfig> = PostgresDriverOptions &
  C;

type PostgresClient = PostgresSql<Record<string, unknown>>;

const isTransaction = (
  client: PostgresClient | PostgresTransaction
): client is PostgresTransaction => {
  return "savepoint" in client;
};

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PostgresDriver extends Driver<
  PostgresClient,
  PostgresTransaction
> {
  readonly adapter: DatabaseAdapter;

  private readonly driverOptions: PostgresDriverOptions;
  private savepointCounter = 0;

  constructor(options: PostgresDriverOptions = {}) {
    super("postgresql", "postgres");
    this.driverOptions = options;

    if (options.client) {
      this.client = options.client;
    }

    const adapter = new PostgresAdapter();
    if (!options.pgvector) adapter.vector = unsupportedVector;
    if (!options.postgis) adapter.geospatial = unsupportedGeospatial;
    this.adapter = adapter;
  }

  protected async initClient(): Promise<PostgresClient> {
    return postgres(this.driverOptions.options);
  }

  protected async closeClient(sql: PostgresClient): Promise<void> {
    await sql.end();
  }

  protected async execute<T>(
    client: PostgresClient | PostgresTransaction,
    sqlStr: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    // postgres.js unsafe() takes (query, parameters?, queryOptions?)
    // parameters must be cast as postgres expects specific types
    const result = await client.unsafe<T[]>(sqlStr, params);
    return {
      rows: result,
      rowCount: result.count,
    };
  }

  protected async executeRaw<T>(
    client: PostgresClient | PostgresTransaction,
    sqlStr: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await client.unsafe<T[]>(sqlStr, params);
    return {
      rows: result,
      rowCount: result.count,
    };
  }

  protected async transaction<T>(
    client: PostgresClient | PostgresTransaction,
    fn: (tx: PostgresTransaction) => Promise<T>,
    _options?: TransactionOptions
  ): Promise<T> {
    // postgres.js begin()/savepoint() return Promise<UnwrapPromiseArray<T>>
    // Since we don't use pipelining (returning arrays of promises), cast to T
    if (isTransaction(client)) {
      // Nested transaction - use savepoint
      const savepointName = `sp_${++this.savepointCounter}`;
      return client.savepoint(savepointName, fn) as Promise<T>;
    }
    return client.begin(fn) as Promise<T>;
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<C extends DriverConfig>(
  config: PostgresClientConfig<C>
) {
  const { client, options, pgvector, postgis, ...restConfig } = config;

  const driver = new PostgresDriver({
    client,
    options,
    pgvector,
    postgis,
  });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: PostgresDriver }>;
}
