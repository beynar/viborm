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
import type { Schema } from "@client/types";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { unsupportedGeospatial, unsupportedVector } from "@errors";
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
}

export type PgClientConfig<S extends Schema> = PgDriverOptions &
  DriverConfig<S>;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PgDriver extends Driver<Pool, PoolClient> {
  readonly adapter: DatabaseAdapter;

  private readonly driverOptions: PgDriverOptions;
  private savepointCounter = 0;

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
    if (client instanceof Pool) {
      // Start a new transaction
      const poolClient = await client.connect();

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
    } else {
      // Nested transaction - use savepoint
      const savepointName = `sp_${++this.savepointCounter}`;
      await client.query(`SAVEPOINT ${savepointName}`);

      try {
        const result = await fn(client);
        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        return result;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        throw error;
      }
    }
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema>(
  config: PgClientConfig<S>
): VibORMClient<S> {
  const { pool, options, pgvector, postgis, ...restConfig } = config;

  const driverOptions: PgDriverOptions = {};
  if (pool) driverOptions.pool = pool;
  if (options) driverOptions.options = options;
  if (pgvector !== undefined) driverOptions.pgvector = pgvector;
  if (postgis !== undefined) driverOptions.postgis = postgis;

  const driver = new PgDriver(driverOptions);

  return baseCreateClient<S>({
    ...restConfig,
    driver,
  }) as VibORMClient<S>;
}
