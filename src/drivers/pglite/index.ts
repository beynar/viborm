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
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import type { Sql } from "@sql";
import { LazyDriver } from "../base-driver";
import type { Driver } from "../driver";
import { unsupportedGeospatial, unsupportedVector } from "../errors";
import { buildPostgresStatement } from "../postgres-utils";
import type { Dialect, QueryResult, TransactionOptions } from "../types";

type PGliteClient = PGlite;

interface PGliteTransaction {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[]; affectedRows?: number }>;
}

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type { PGliteOptions } from "@electric-sql/pglite";

export interface PGliteDriverOptions {
  client?: PGliteClient;
  options?: PGliteOptions;
  /** @deprecated Use options.dataDir */
  dataDir?: string;
  pgvector?: boolean;
  postgis?: boolean;
}

export interface PGliteClientConfig<S extends Schema>
  extends PGliteDriverOptions {
  schema: S;
}

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PGliteDriver extends LazyDriver<PGliteClient> {
  readonly dialect: Dialect = "postgresql";
  readonly adapter: DatabaseAdapter;

  private readonly driverOptions: PGliteDriverOptions;

  constructor(options: PGliteDriverOptions = {}) {
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

  protected initClient(): Promise<PGliteClient> {
    // Build options
    const pgliteOptions: PGliteOptions = this.driverOptions.options
      ? { ...this.driverOptions.options }
      : {};

    // Fallback to deprecated dataDir
    if (!pgliteOptions.dataDir && this.driverOptions.dataDir) {
      pgliteOptions.dataDir = this.driverOptions.dataDir;
    }

    // Default to .pglite if nothing specified
    if (!pgliteOptions.dataDir) {
      pgliteOptions.dataDir = ".pglite";
    }

    return PGlite.create(pgliteOptions);
  }

  protected async closeClient(client: PGliteClient): Promise<void> {
    await client.close();
  }

  protected async executeWithClient<T>(
    client: PGliteClient,
    query: Sql
  ): Promise<QueryResult<T>> {
    const statement = buildPostgresStatement(query);
    const result = await client.query<T>(statement, query.values);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }

  protected async executeRawWithClient<T>(
    client: PGliteClient,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await client.query<T>(sql, params);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }

  protected transactionWithClient<T>(
    client: PGliteClient,
    fn: (tx: Driver) => Promise<T>,
    _options?: TransactionOptions
  ): Promise<T> {
    // PGlite doesn't support isolation levels
    return client.transaction((tx) => {
      return fn(new PGliteTransactionDriver(tx, this.adapter));
    });
  }
}

// ============================================================
// TRANSACTION DRIVER
// ============================================================

class PGliteTransactionDriver implements Driver {
  readonly dialect: Dialect = "postgresql";
  readonly adapter: DatabaseAdapter;
  private readonly tx: PGliteTransaction;

  constructor(tx: PGliteTransaction, adapter: DatabaseAdapter) {
    this.tx = tx;
    this.adapter = adapter;
  }

  async execute<T = Record<string, unknown>>(
    query: Sql
  ): Promise<QueryResult<T>> {
    const statement = buildPostgresStatement(query);
    const result = await this.tx.query<T>(statement, query.values);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }

  async executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await this.tx.query<T>(sql, params);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }

  transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
    // PGlite doesn't support nested transactions/savepoints
    return fn(this);
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema>(
  config: PGliteClientConfig<S>
): VibORMClient<S> {
  const { client, options, dataDir, pgvector, postgis, ...restConfig } = config;

  const driverOptions: PGliteDriverOptions = {};
  if (client) driverOptions.client = client;
  if (options) driverOptions.options = options;
  if (dataDir) driverOptions.dataDir = dataDir;
  if (pgvector !== undefined) driverOptions.pgvector = pgvector;
  if (postgis !== undefined) driverOptions.postgis = postgis;

  const driver = new PGliteDriver(driverOptions);

  return baseCreateClient<S>({
    ...restConfig,
    driver,
  }) as VibORMClient<S>;
}
