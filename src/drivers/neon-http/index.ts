/**
 * Neon HTTP Driver
 *
 * Driver implementation for @neondatabase/serverless - Neon's HTTP-based PostgreSQL driver.
 *
 * Note: Neon's HTTP API uses non-interactive transactions. This means:
 * - Batch transactions ($transaction([...])) work via executeBatch
 * - Callback transactions ($transaction(async (tx) => {...})) are NOT supported
 *   because Neon HTTP requires all queries to be submitted at once
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import {
  TransactionError,
  unsupportedGeospatial,
  unsupportedVector,
  VibORMErrorCode,
} from "@errors";
import type {
  FullQueryResults,
  NeonQueryFunction,
  NeonQueryFunctionInTransaction,
} from "@neondatabase/serverless";
import { Driver } from "../driver";
import type {
  BatchQuery,
  IsolationLevel,
  QueryResult,
  TransactionOptions,
} from "../types";

const NEON_ISOLATION_LEVELS: Record<
  IsolationLevel,
  "ReadUncommitted" | "ReadCommitted" | "RepeatableRead" | "Serializable"
> = {
  read_uncommitted: "ReadUncommitted",
  read_committed: "ReadCommitted",
  repeatable_read: "RepeatableRead",
  serializable: "Serializable",
};

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface NeonHTTPDriverOptions {
  databaseUrl?: string;
  options?: {
    fetchOptions?: RequestInit;
  };
  pgvector?: boolean;
  postgis?: boolean;
}

export type NeonHTTPClientConfig<C extends DriverConfig> =
  NeonHTTPDriverOptions & C;

// ============================================================
// TYPE DECLARATIONS
// ============================================================

/**
 * NeonQuery is the main query function returned by neon().
 * Configured with arrayMode=false (object rows) and fullResults=true (includes rowCount).
 */
type NeonQuery = NeonQueryFunction<false, true>;

/**
 * NeonTx is the transaction-bound query function passed to transaction callbacks.
 * Configured with arrayMode=false and fullResults=true to match the main client.
 */
type NeonTx = NeonQueryFunctionInTransaction<false, true>;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

/**
 * Type guard to check if client is NeonQuery (has transaction method)
 * vs NeonTx (transaction callback that only accepts sql + params)
 */
function isNeonQueryFunction(client: NeonQuery | NeonTx): client is NeonQuery {
  return typeof (client as NeonQuery).transaction === "function";
}

export class NeonHTTPDriver extends Driver<NeonQuery, NeonTx> {
  readonly adapter: DatabaseAdapter;

  // Neon HTTP only supports non-interactive (batch) transactions
  // Callback-style transactions are not supported
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

  protected async initClient(): Promise<NeonQuery> {
    const { neon, types } = await import("@neondatabase/serverless");

    if (!this.driverOptions.databaseUrl) {
      throw new Error("Neon HTTP driver requires a databaseUrl");
    }

    // DATE (1082) / TIMESTAMP WITHOUT TIME ZONE (1114): the default parsers
    // build process-local Dates, shifting the stored value by the process
    // timezone. Return raw strings — the shared result parser builds UTC
    // Dates from them, matching every other driver.
    const identityParser = (value: string) => value;
    // pg-types declares getTypeParser with per-format overloads that a single
    // wrapper function can't express — the cast is unavoidable here
    const getTypeParser = ((oid: number, format?: string) => {
      if ((oid === 1082 || oid === 1114) && format !== "binary") {
        return identityParser;
      }
      return types.getTypeParser(oid as never, format as never);
    }) as typeof types.getTypeParser;
    const utcSafeTypes: typeof types = { ...types, getTypeParser };

    // Always use arrayMode=false (object rows) and fullResults=true (includes rowCount)
    const client = neon(this.driverOptions.databaseUrl, {
      fetchOptions: this.driverOptions.options?.fetchOptions,
      fullResults: true,
      arrayMode: false,
      types: utcSafeTypes,
    });

    return client;
  }

  protected async closeClient(_client: NeonQuery): Promise<void> {
    // HTTP client doesn't need to be closed
  }

  protected async execute<T>(
    client: NeonQuery | NeonTx,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    // NeonQuery supports options, NeonTx only accepts (sql, params)
    const result = isNeonQueryFunction(client)
      ? await client(sql, params, { arrayMode: false, fullResults: true })
      : await client(sql, params);

    return this.parseResult<T>(result);
  }

  protected async executeRaw<T>(
    client: NeonQuery | NeonTx,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.execute<T>(client, sql, params ?? []);
  }

  protected async transaction<T>(
    client: NeonQuery | NeonTx,
    fn: (tx: NeonTx) => Promise<T>
  ): Promise<T> {
    // Neon HTTP does not support interactive transactions - just execute directly
    // Warning is handled by base Driver.withTransaction()
    return fn(client as NeonTx);
  }

  /**
   * Execute multiple queries atomically using Neon's transaction() function.
   * This provides atomic batch execution with full PostgreSQL transaction semantics.
   */
  protected async executeBatch<T>(
    client: NeonQuery,
    queries: BatchQuery[],
    options?: TransactionOptions
  ): Promise<QueryResult<T>[]> {
    if (options?.timeout !== undefined) {
      // The HTTP transaction is a single request; a client-side timeout can't
      // stop it server-side, so reject instead of pretending to honor it.
      throw new TransactionError(
        `Driver "${this.driverName}" cannot honor a transaction timeout in batch execution.`,
        {
          code: VibORMErrorCode.INVALID_TRANSACTION_INPUT,
          meta: { driver: this.driverName, method: "$transaction([...])" },
        }
      );
    }

    // Use Neon's transaction function with a callback that returns query array
    const results = await client.transaction(
      (txFn) => queries.map((query) => txFn(query.sql, query.params ?? [])),
      options?.isolationLevel
        ? { isolationLevel: NEON_ISOLATION_LEVELS[options.isolationLevel] }
        : undefined
    );

    // Map results to QueryResult format
    return results.map((result) => this.parseResult<T>(result));
  }

  /**
   * Parse Neon result into QueryResult format.
   */
  private parseResult<T>(result: unknown): QueryResult<T> {
    // Handle FullQueryResults object (when fullResults=true)
    const fullResult = result as FullQueryResults<false>;
    if (fullResult.rows !== undefined) {
      return {
        rows: fullResult.rows as T[],
        rowCount: fullResult.rowCount ?? fullResult.rows.length,
      };
    }

    // Fallback for array result (when fullResults=false)
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
