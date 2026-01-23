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
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { Driver } from "../driver";
import type { QueryResult, TransactionOptions } from "../types";

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
    return Promise.resolve(new Pool(this.driverOptions.options));
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
    if (this.inTransaction) {
      // Nested transaction - use savepoint
      const poolClient = client as PoolClient;
      const savepointName = `sp_${crypto.randomUUID().replace(/-/g, "")}`;
      await poolClient.query(`SAVEPOINT ${savepointName}`);

      try {
        const result = await fn(poolClient);
        await poolClient.query(`RELEASE SAVEPOINT ${savepointName}`);
        return result;
      } catch (error) {
        await poolClient.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        throw error;
      }
    }

    // Start a new transaction
    const pool = client as Pool;
    const poolClient = await pool.connect();

    try {
      let beginStatement = "BEGIN";
      if (options?.isolationLevel) {
        const isolationMap = {
          read_uncommitted: "READ UNCOMMITTED",
          read_committed: "READ COMMITTED",
          repeatable_read: "REPEATABLE READ",
          serializable: "SERIALIZABLE",
        };
        beginStatement = `BEGIN ISOLATION LEVEL ${isolationMap[options.isolationLevel]}`;
      }

      await poolClient.query(beginStatement);
      this.inTransaction = true;
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
