/**
 * PGlite Driver
 *
 * Driver implementation for PGlite (PostgreSQL in WebAssembly).
 * Supports optional pgvector and PostGIS extensions.
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
  PGlite,
  type PGliteOptions,
  type Transaction,
} from "@electric-sql/pglite";
import { unsupportedGeospatial, unsupportedVector } from "@errors";
import { Driver, type QueryExecutionContext } from "../driver";
import { normalizeProviderRowCount } from "../normalized-result";
import {
  nestedTransactionDispatchError,
  runProviderManagedTransaction,
  type TransactionOptionSupport,
} from "../shared";
import type { QueryResult } from "../types";

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
  readonly maxBindParametersPerStatement: number | undefined = 65_535;
  protected override readonly serializeTransactions = true;

  private readonly driverOptions: PGliteDriverOptions;

  constructor(options: PGliteDriverOptions = {}) {
    super("postgresql", "pglite");
    this.driverOptions = options;

    if (options.client) {
      this.client = options.client;
    }

    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = options.pgvector === true;
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
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "execute";
    const result = await client.query<T>(sql, params);
    const affectedRows = normalizeProviderRowCount(result.affectedRows, {
      provider: "pglite",
      operation,
    });
    return {
      rows: result.rows,
      rowCount: result.rows.length > 0 ? result.rows.length : affectedRows,
    };
  }

  protected async executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "executeRaw";
    const result = await client.query<T>(sql, params);
    const affectedRows = normalizeProviderRowCount(result.affectedRows, {
      provider: "pglite",
      operation,
    });
    return {
      rows: result.rows,
      rowCount: result.rows.length > 0 ? result.rows.length : affectedRows,
    };
  }

  /**
   * PGlite is a full PostgreSQL, so the isolation level is a real post-BEGIN
   * statement. It is also single-connection, so top-level transactions queue —
   * and that queue wait is exactly what `maxWait` bounds.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "post-begin",
      timeout: true,
      maxWait: "queue",
    };
  }

  protected transaction<T>(
    client: PGlite | Transaction,
    fn: (tx: Transaction) => Promise<T>
  ): Promise<T> {
    if (!(client instanceof PGlite)) {
      throw nestedTransactionDispatchError(this.driverName);
    }
    return runProviderManagedTransaction({
      run: (callback) => client.transaction(callback),
      callback: fn,
      close: async () => {
        await client.close();
        this.client = null;
      },
    });
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: PGliteConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, PGliteDriverOptions, S> &
    NoExtraNestedConfigKeys<C, S>
): VibORMClient<C & { driver: PGliteDriver }> {
  const { client, dataDir, options, pgvector, postgis, ...restConfig } = config;

  const driver = new PGliteDriver({
    client,
    dataDir,
    options,
    pgvector,
    postgis,
  });

  return createClientFromDriverConfig({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: PGliteDriver }>;
}
