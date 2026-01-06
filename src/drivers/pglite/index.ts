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
import type { Sql } from "@sql";
import type { Driver } from "../driver";
import { unsupportedGeospatial, unsupportedVector } from "../errors";
import type { Dialect, QueryResult, TransactionOptions } from "../types";

/**
 * PGlite client interface (from @electric-sql/pglite)
 */
interface PGliteClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[]; affectedRows?: number }>;
  transaction<T>(fn: (tx: PGliteTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * PGlite transaction interface
 */
interface PGliteTransaction {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[]; affectedRows?: number }>;
}

/**
 * PGlite constructor interface (for auto-creation)
 */
interface PGliteConstructor {
  new (dataDir?: string): PGliteClient;
}

/**
 * PGlite driver options
 */
export interface PGliteDriverOptions {
  /**
   * PGlite client instance.
   * If not provided, a new PGlite instance will be created with the dataDir option.
   */
  client?: PGliteClient;
  /**
   * Data directory for PGlite persistence.
   * Only used when client is not provided.
   * Defaults to ".pglite"
   */
  dataDir?: string;
  /** Enable pgvector extension support (default: false) */
  pgvector?: boolean;
  /** Enable PostGIS extension support (default: false) */
  postgis?: boolean;
}

/**
 * PGlite client config for createClient
 */
export interface PGliteClientConfig<S extends Schema> {
  /** Schema models */
  schema: S;
  /**
   * PGlite client instance.
   * If not provided, a new PGlite instance will be created with the dataDir option.
   */
  client?: PGliteClient;
  /**
   * Data directory for PGlite persistence.
   * Only used when client is not provided.
   * Defaults to ".pglite"
   */
  dataDir?: string;
  /** Enable pgvector extension support (default: false) */
  pgvector?: boolean;
  /** Enable PostGIS extension support (default: false) */
  postgis?: boolean;
}

// Lazily loaded PGlite constructor
let PGliteClass: PGliteConstructor | null = null;

/**
 * Build a PostgreSQL statement with $1, $2, etc. placeholders
 */
function buildPostgresStatement(query: Sql): string {
  const len = query.strings.length;
  let i = 1;
  let result = query.strings[0] ?? "";
  while (i < len) {
    result += `$${i}${query.strings[i] ?? ""}`;
    i++;
  }
  return result;
}

/**
 * Get PGlite constructor, loading it dynamically if needed
 */
async function getPGliteClass(): Promise<PGliteConstructor> {
  if (PGliteClass) return PGliteClass;

  try {
    const module = await import("@electric-sql/pglite");
    PGliteClass = module.PGlite;
    return PGliteClass;
  } catch {
    throw new Error(
      "PGlite is not installed. Install it with: npm install @electric-sql/pglite"
    );
  }
}

/**
 * PGlite Driver
 *
 * Implements the Driver interface for PGlite.
 *
 * @example Basic usage with auto-created client
 * ```ts
 * import { createClient } from "viborm/drivers/pglite";
 *
 * const client = await createClient({ schema });
 * // Data persisted to .viborm/pglite by default
 * ```
 *
 * @example With custom data directory
 * ```ts
 * import { createClient } from "viborm/drivers/pglite";
 *
 * const client = await createClient({
 *   schema,
 *   dataDir: "./my-data/db"
 * });
 * ```
 *
 * @example With existing PGlite client
 * ```ts
 * import { PGlite } from "@electric-sql/pglite";
 * import { createClient } from "viborm/drivers/pglite";
 *
 * const db = new PGlite();
 * const client = await createClient({ client: db, schema });
 * ```
 *
 * @example With pgvector extension
 * ```ts
 * import { PGlite } from "@electric-sql/pglite";
 * import { vector } from "@electric-sql/pglite/vector";
 * import { createClient } from "viborm/drivers/pglite";
 *
 * const db = new PGlite({ extensions: { vector } });
 * const client = await createClient({ client: db, schema, pgvector: true });
 * ```
 */
export class PGliteDriver implements Driver {
  readonly dialect: Dialect = "postgresql";
  readonly adapter: DatabaseAdapter;

  private readonly client: PGliteClient;

  constructor(options: PGliteDriverOptions & { client: PGliteClient }) {
    this.client = options.client;

    // Create adapter and override unsupported features
    const adapter = new PostgresAdapter();

    if (!options.pgvector) {
      adapter.vector = unsupportedVector;
    }

    if (!options.postgis) {
      adapter.geospatial = unsupportedGeospatial;
    }

    this.adapter = adapter;
  }

  /**
   * Create a PGliteDriver, auto-creating the PGlite client if not provided
   */
  static async create(
    options: PGliteDriverOptions = {}
  ): Promise<PGliteDriver> {
    let client = options.client;

    if (!client) {
      const PGlite = await getPGliteClass();
      const dataDir = options.dataDir ?? ".pglite";
      client = new PGlite(dataDir);
    }

    return new PGliteDriver({ ...options, client });
  }

  async execute<T = Record<string, unknown>>(
    query: Sql
  ): Promise<QueryResult<T>> {
    // Build parameterized statement with $1, $2, etc. placeholders
    const statement = buildPostgresStatement(query);
    const result = await this.client.query<T>(statement, query.values);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }

  async executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await this.client.query<T>(sql, params);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }

  transaction<T>(
    fn: (tx: Driver) => Promise<T>,
    _options?: TransactionOptions
  ): Promise<T> {
    return this.client.transaction((tx) => {
      const txDriver = new PGliteTransactionDriver(tx, this.adapter);
      return fn(txDriver);
    });
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }
}

/**
 * PGlite Transaction Driver
 *
 * Driver implementation for transactions within PGlite.
 */
class PGliteTransactionDriver implements Driver {
  readonly dialect: Dialect = "postgresql";
  readonly adapter: DatabaseAdapter;
  readonly tx: PGliteTransaction;
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
    // Nested transaction - PGlite doesn't support savepoints,
    // so we run in the same transaction context
    return fn(this);
  }
}

/**
 * Create a VibORM client with PGlite driver
 *
 * Convenience function that creates the driver and client in one step.
 * If no PGlite client is provided, one will be created automatically
 * with data persisted to `.viborm/pglite` (or custom dataDir).
 *
 * @example
 * ```ts
 * import { createClient } from "viborm/drivers/pglite";
 *
 * const client = await createClient({ schema: { user, post } });
 *
 * // With custom data directory
 * const client = await createClient({
 *   schema: { user, post },
 *   dataDir: "./data/mydb"
 * });
 * ```
 */
export async function createClient<S extends Schema>(
  config: PGliteClientConfig<S>
): Promise<VibORMClient<S>> {
  const { client, dataDir, pgvector, postgis, ...restConfig } = config;

  const driverOptions: PGliteDriverOptions = {};
  if (client !== undefined) driverOptions.client = client;
  if (dataDir !== undefined) driverOptions.dataDir = dataDir;
  if (pgvector !== undefined) driverOptions.pgvector = pgvector;
  if (postgis !== undefined) driverOptions.postgis = postgis;

  const driver = await PGliteDriver.create(driverOptions);

  return baseCreateClient<S>({
    ...restConfig,
    driver,
  }) as VibORMClient<S>;
}
