/**
 * PostgreSQL Driver (node-postgres)
 *
 * Driver implementation for pg (node-postgres) with connection pooling.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import { unsupportedGeospatial, unsupportedVector } from "@errors";
import { Pool, type PoolClient, type PoolConfig, types as pgTypes } from "pg";
import { Driver } from "../driver";
import { getSqlIsolationLevel, runSavepoint } from "../shared";
import type { QueryResult, TransactionOptions } from "../types";

// DATE (1082) and TIMESTAMP WITHOUT TIME ZONE (1114): pg's default parsers
// build process-local Dates, shifting the stored value by the process
// timezone. Return the raw strings instead — the shared result parser builds
// UTC Dates from them, matching every other driver.
const DATE_OID = 1082;
const TIMESTAMP_OID = 1114;
const identityParser = (value: string) => value;
const utcSafeTypes: PoolConfig["types"] = {
  getTypeParser: (oid: number, format?: string) => {
    if ((oid === DATE_OID || oid === TIMESTAMP_OID) && format !== "binary") {
      return identityParser;
    }
    return pgTypes.getTypeParser(oid as never, format as never);
  },
};

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type { PoolConfig as PgOptions } from "pg";

export interface PgDriverOptions {
  pool?: Pool;
  options?: PoolConfig;
  pgvector?: boolean;
  postgis?: boolean;
  databaseUrl?: string;
}

export type PgClientConfig<C extends DriverConfig> = PgDriverOptions & C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PgDriver extends Driver<Pool, PoolClient> {
  readonly adapter: DatabaseAdapter;

  private readonly driverOptions: PgDriverOptions;

  constructor(options: PgDriverOptions = {}) {
    super("postgresql", "pg");
    this.driverOptions = options;

    if (options.pool) {
      this.client = options.pool;
    }

    const adapter = new PostgresAdapter();
    if (!options.pgvector) adapter.vector = unsupportedVector;
    if (!options.postgis) adapter.geospatial = unsupportedGeospatial;
    this.adapter = adapter;
  }

  protected initClient(): Promise<Pool> {
    const options: PoolConfig = {
      types: utcSafeTypes,
      ...this.driverOptions.options,
    };
    if (this.driverOptions.databaseUrl !== undefined) {
      options.connectionString ??= this.driverOptions.databaseUrl;
    }
    return Promise.resolve(new Pool(options));
  }

  protected async closeClient(pool: Pool): Promise<void> {
    await pool.end();
  }

  protected async execute<T>(
    client: Pool | PoolClient,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await client.query(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  protected async executeRaw<T>(
    client: Pool | PoolClient,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await client.query(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  protected async transaction<T>(
    client: Pool | PoolClient,
    fn: (tx: PoolClient) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    if ("release" in client) {
      // Nested transaction - use savepoint
      const poolClient = client as PoolClient;
      return runSavepoint(
        (statement) => poolClient.query(statement),
        () => fn(poolClient)
      );
    }

    // Start a new transaction
    const pool = client as Pool;
    const poolClient = await pool.connect();

    try {
      let beginStatement = "BEGIN";
      if (options?.isolationLevel) {
        beginStatement = `BEGIN ISOLATION LEVEL ${getSqlIsolationLevel(
          options.isolationLevel
        )}`;
      }

      await poolClient.query(beginStatement);
      const result = await fn(poolClient);
      await poolClient.query("COMMIT");
      return result;
    } catch (error) {
      await poolClient.query("ROLLBACK");
      throw error;
    } finally {
      poolClient.release();
    }
    // Note: this.inTransaction reset is handled by base Driver._transaction()
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<C extends DriverConfig>(
  config: PgClientConfig<C>
) {
  const {
    pool,
    options = {},
    pgvector,
    postgis,
    databaseUrl,
    ...restConfig
  } = config;

  const driverOptions: PgDriverOptions = {};
  if (databaseUrl !== undefined) options.connectionString = databaseUrl;
  if (pool) driverOptions.pool = pool;
  if (options) driverOptions.options = options;
  if (pgvector !== undefined) driverOptions.pgvector = pgvector;
  if (postgis !== undefined) driverOptions.postgis = postgis;

  const driver = new PgDriver(driverOptions);

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: PgDriver }>;
}
