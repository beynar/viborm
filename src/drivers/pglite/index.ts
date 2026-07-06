/**
 * PGlite Driver
 *
 * Driver implementation for PGlite (PostgreSQL in WebAssembly).
 * Supports optional pgvector and PostGIS extensions.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import {
  PGlite,
  type PGliteOptions,
  type Transaction,
} from "@electric-sql/pglite";
import { unsupportedGeospatial, unsupportedVector } from "@errors";
import { Driver } from "../driver";
import { getSqlIsolationLevel } from "../shared";
import type { QueryResult, TransactionOptions } from "../types";

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type { PGliteOptions } from "@electric-sql/pglite";

export interface PGliteDriverOptions {
  client?: PGlite;
  dataDir?: string;
  options?: PGliteOptions;
  pgvector?: boolean;
  postgis?: boolean;
}

export type PGliteConfig<C extends DriverConfig> = PGliteDriverOptions & C;

// ===  ======================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PGliteDriver extends Driver<PGlite, Transaction> {
  readonly adapter: DatabaseAdapter;

  private readonly driverOptions: PGliteDriverOptions;

  constructor(options: PGliteDriverOptions = {}) {
    super("postgresql", "pglite");
    this.driverOptions = options;

    if (options.client) {
      this.client = options.client;
    }

    const adapter = new PostgresAdapter();
    if (!options.pgvector) adapter.vector = unsupportedVector;
    if (!options.postgis) adapter.geospatial = unsupportedGeospatial;
    this.adapter = adapter;
  }

  protected async initClient(): Promise<PGlite> {
    const dataDir = this.driverOptions.dataDir;
    const userOptions = this.driverOptions.options ?? {};
    const options: PGliteOptions = {
      ...userOptions,
      parsers: {
        // TIMESTAMP WITHOUT TIME ZONE: PGlite builds process-local Dates,
        // shifting the stored UTC wall clock. Keep the raw string — the
        // shared result parser builds a UTC Date, matching other drivers.
        1114: (value: string) => value,
        ...userOptions.parsers,
      },
    };

    // PGlite.create accepts dataDir as first argument or in options
    if (dataDir) {
      return PGlite.create(dataDir, options);
    }
    return PGlite.create(options);
  }

  protected async closeClient(client: PGlite): Promise<void> {
    await client.close();
  }

  protected async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await client.query<T>(sql, params);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }

  protected async executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await client.query<T>(sql, params);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }

  protected transaction<T>(
    client: PGlite | Transaction,
    fn: (tx: Transaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    if (client instanceof PGlite) {
      // Start a new transaction
      if (options?.isolationLevel) {
        const level = getSqlIsolationLevel(options.isolationLevel);
        return client.transaction(async (tx) => {
          await tx.exec(`SET TRANSACTION ISOLATION LEVEL ${level}`);
          return fn(tx);
        });
      }
      return client.transaction(fn);
    }
    // Nested transactions not supported in PGlite
    return fn(client);
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<C extends DriverConfig>(config: PGliteConfig<C>) {
  const { client, dataDir, options, pgvector, postgis, ...restConfig } = config;

  const driver = new PGliteDriver({
    client,
    dataDir,
    options,
    pgvector,
    postgis,
  });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: PGliteDriver }>;
}
