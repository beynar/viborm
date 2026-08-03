/**
 * PostgreSQL Driver (node-postgres)
 *
 * Driver implementation for pg (node-postgres) with connection pooling.
 *
 * No statement pipelining. node-postgres has no pipeline mode: a `Client` holds
 * one query active at a time and drains the rest from an internal queue, so the
 * statements of a transaction always cost one round trip each no matter how
 * they are issued. Nothing here can change that, and nothing here tries to —
 * see the Phase 9 disposition in `docs/architecture/query-performance-plan.md`,
 * which measured the same limit on the postgres.js driver for different
 * reasons.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  createClientFromDriverConfig,
  type DriverConfig,
  type NoExtraDriverConfigKeys,
  type NoExtraNestedConfigKeys,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import {
  TransactionError,
  unsupportedGeospatial,
  unsupportedVector,
} from "@errors";
import { Pool, type PoolClient, type PoolConfig, types as pgTypes } from "pg";
import { Driver, type QueryExecutionContext } from "../driver";
import {
  acquireWithMaxWait,
  type DriverTransactionOptions,
  nestedTransactionDispatchError,
  normalizePostgresRowCount,
  runTransactionLifecycle,
  type TransactionOptionSupport,
} from "../shared";
import type { QueryResult } from "../types";

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
    adapter.capabilities.supportsVector = options.pgvector === true;
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
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "execute";
    const result = await client.query(sql, params);
    return {
      rows: result.rows,
      rowCount: normalizePostgresRowCount(
        result.rowCount,
        result.command,
        result.rows,
        { provider: "pg", operation }
      ),
    };
  }

  protected async executeRaw<T>(
    client: Pool | PoolClient,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "executeRaw";
    const result = await client.query(sql, params);
    return {
      rows: result.rows,
      rowCount: normalizePostgresRowCount(
        result.rowCount,
        result.command,
        result.rows,
        { provider: "pg", operation }
      ),
    };
  }

  /**
   * PostgreSQL takes the isolation level as the first statement inside the
   * transaction, and node-postgres hands out a pooled client we can wait for
   * with a bound (and release if we stop waiting).
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "post-begin",
      timeout: true,
      maxWait: "acquisition",
    };
  }

  protected async transaction<T>(
    client: Pool | PoolClient,
    fn: (tx: PoolClient) => Promise<T>,
    _context?: QueryExecutionContext,
    options?: DriverTransactionOptions
  ): Promise<T> {
    if ("release" in client) {
      throw nestedTransactionDispatchError(this.driverName);
    }

    // Start a new transaction
    const pool = client as Pool;
    const poolClient = await acquireWithMaxWait(
      () => pool.connect(),
      (acquired) => acquired.release(),
      options?.maxWaitMs,
      { driverName: this.driverName, form: "callback" }
    );
    let releaseError: Error | boolean | undefined;
    const queryOrDiscard = async (statement: string) => {
      try {
        await poolClient.query(statement);
      } catch (error) {
        releaseError ??= error instanceof Error ? error : true;
        throw error;
      }
    };
    return runTransactionLifecycle({
      begin: () => queryOrDiscard("BEGIN"),
      callback: () => fn(poolClient),
      commit: () => queryOrDiscard("COMMIT"),
      rollback: () => queryOrDiscard("ROLLBACK"),
      close: () => {
        try {
          if (releaseError) {
            poolClient.release(releaseError);
            return;
          }
          poolClient.release();
        } catch (error) {
          super.transactionCleanupFailed(
            new TransactionError(
              'Driver "pg" could not release an unsafe transaction connection.',
              { meta: { driver: "pg", method: "$transaction" } }
            )
          );
          throw error;
        }
      },
    });
  }

  protected override transactionCleanupFailed(_error: Error): void {
    // The failed PoolClient was discarded with release(error); the pool stays usable.
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: PgClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, PgDriverOptions, S> &
    NoExtraNestedConfigKeys<C, S>
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

  return createClientFromDriverConfig({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: PgDriver }>;
}
