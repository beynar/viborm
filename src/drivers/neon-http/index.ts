/**
 * Neon HTTP Driver
 *
 * Driver implementation for @neondatabase/serverless - Neon's HTTP-based PostgreSQL driver.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import { unsupportedGeospatial, unsupportedVector } from "@errors";
import { Driver } from "../driver";
import type { BatchQuery, QueryResult, TransactionOptions } from "../types";

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface NeonHTTPDriverOptions {
  databaseUrl?: string;
  options?: {
    fetchOptions?: RequestInit;
    arrayMode?: boolean;
    fullResults?: boolean;
  };
  pgvector?: boolean;
  postgis?: boolean;
}

export type NeonHTTPClientConfig<C extends DriverConfig> =
  NeonHTTPDriverOptions & C;

// ============================================================
// TYPE DECLARATIONS
// ============================================================

// Neon query function type - we define a minimal interface to avoid API version issues
type NeonQueryFn = {
  (
    sql: string,
    params?: unknown[],
    options?: { arrayMode?: boolean; fullResults?: boolean }
  ): Promise<unknown>;
  transaction: <T>(
    queries: unknown[] | ((sql: NeonTxFn) => unknown[]),
    options?: { isolationLevel?: string }
  ) => Promise<T>;
};

type NeonTxFn = (sql: string, params?: unknown[]) => unknown;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class NeonHTTPDriver extends Driver<NeonQueryFn, NeonTxFn> {
  readonly adapter: DatabaseAdapter;
  readonly supportsTransactions = false;
  readonly supportsBatch = true;

  private readonly driverOptions: NeonHTTPDriverOptions;

  constructor(options: NeonHTTPDriverOptions = {}) {
    super("postgresql", "neon-http");
    this.driverOptions = options;

    const adapter = new PostgresAdapter();
    if (!options.pgvector) adapter.vector = unsupportedVector;
    if (!options.postgis) adapter.geospatial = unsupportedGeospatial;
    this.adapter = adapter;
  }

  protected async initClient(): Promise<NeonQueryFn> {
    const { neon } = await import("@neondatabase/serverless");

    if (!this.driverOptions.databaseUrl) {
      throw new Error("Neon HTTP driver requires a databaseUrl");
    }

    const client = neon(this.driverOptions.databaseUrl, {
      fetchOptions: this.driverOptions.options?.fetchOptions,
      arrayMode: this.driverOptions.options?.arrayMode ?? false,
      fullResults: this.driverOptions.options?.fullResults ?? true,
    });

    return client as unknown as NeonQueryFn;
  }

  protected async closeClient(_client: NeonQueryFn): Promise<void> {
    // HTTP client doesn't need to be closed
  }

  protected async execute<T>(
    client: NeonQueryFn | NeonTxFn,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await (client as NeonQueryFn)(sql, params, {
      arrayMode: false,
      fullResults: true,
    });

    // Handle FullQueryResults object
    const fullResult = result as {
      rows?: T[];
      rowCount?: number;
      fields?: unknown[];
    };

    if (fullResult.rows) {
      return {
        rows: fullResult.rows,
        rowCount: fullResult.rowCount ?? fullResult.rows.length,
      };
    }

    // Fallback for array result
    if (Array.isArray(result)) {
      return {
        rows: result as T[],
        rowCount: result.length,
      };
    }

    return {
      rows: [],
      rowCount: 0,
    };
  }

  protected async executeRaw<T>(
    client: NeonQueryFn | NeonTxFn,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.execute<T>(client, sql, params ?? []);
  }

  protected async transaction<T>(
    client: NeonQueryFn | NeonTxFn,
    fn: (tx: NeonTxFn) => Promise<T>,
    _options?: TransactionOptions
  ): Promise<T> {
    // Neon HTTP does not support true transactions.
    // Each HTTP request is a separate connection, so BEGIN/COMMIT/ROLLBACK
    // cannot maintain transaction state across requests.
    // For transaction support, use the @neondatabase/serverless Pool with WebSockets.
    console.warn(
      "Neon HTTP driver does not support transactions. " +
        "Each query executes in its own connection. " +
        "For transaction support, use @neondatabase/serverless Pool with WebSockets."
    );
    return fn(client as NeonTxFn);
  }

  /**
   * Execute multiple queries atomically using Neon's transaction() function.
   * This provides atomic batch execution even though dynamic transactions aren't supported.
   */
  protected async executeBatch<T>(
    client: NeonQueryFn,
    queries: BatchQuery[]
  ): Promise<Array<QueryResult<T>>> {
    // Use Neon's transaction function with a callback that returns query array
    const results = await client.transaction<unknown[]>((txFn) =>
      queries.map((query) => txFn(query.sql, query.params ?? []))
    );

    // Map results to QueryResult format
    return results.map((result) => {
      const fullResult = result as {
        rows?: T[];
        rowCount?: number;
      };

      if (fullResult.rows) {
        return {
          rows: fullResult.rows,
          rowCount: fullResult.rowCount ?? fullResult.rows.length,
        };
      }

      if (Array.isArray(result)) {
        return {
          rows: result as T[],
          rowCount: result.length,
        };
      }

      return { rows: [], rowCount: 0 };
    });
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<C extends DriverConfig>(
  config: NeonHTTPClientConfig<C>
) {
  const { databaseUrl, options, pgvector, postgis, ...restConfig } = config;

  const driver = new NeonHTTPDriver({
    databaseUrl,
    options,
    pgvector,
    postgis,
  });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: NeonHTTPDriver }>;
}
