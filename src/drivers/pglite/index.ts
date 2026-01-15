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
import type { Schema } from "@client/types";
import {
  PGlite,
  type PGliteOptions,
  type Transaction,
} from "@electric-sql/pglite";
import { unsupportedGeospatial, unsupportedVector } from "@errors";
import { Driver } from "../driver";
import type { QueryResult, TransactionOptions } from "../types";

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type { PGliteOptions } from "@electric-sql/pglite";

export interface PGliteDriverOptions {
  client?: PGlite;
  options?: PGliteOptions;
  pgvector?: boolean;
  postgis?: boolean;
}

export type PGliteConfig<S extends Schema> = PGliteDriverOptions &
  DriverConfig<S>;

// ============================================================
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
    return PGlite.create(this.driverOptions.options || {});
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
    _options?: TransactionOptions
  ): Promise<T> {
    if (client instanceof PGlite) {
      // Start a new transaction
      return client.transaction(fn);
    }
    // Nested transactions not supported in PGlite
    return fn(client);
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema>(
  config: PGliteConfig<S>
): VibORMClient<S> {
  const { client, options, pgvector, postgis, ...restConfig } = config;

  const driverOptions: PGliteDriverOptions = {};
  if (client) driverOptions.client = client;
  if (options) driverOptions.options = options;
  if (pgvector !== undefined) driverOptions.pgvector = pgvector;
  if (postgis !== undefined) driverOptions.postgis = postgis;

  const driver = new PGliteDriver(driverOptions);

  return baseCreateClient<S>({
    ...restConfig,
    driver,
  }) as VibORMClient<S>;
}
