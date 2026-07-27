/**
 * Bun SQL Driver
 *
 * Driver implementation for Bun's built-in PostgreSQL client.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
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
// TYPE DECLARATIONS FOR BUN SQL
// ============================================================

// Bun's SQL type - we define inline to avoid requiring bun types at compile time
// Every result is an array carrying its required provider row count.
type BunSQLResult<T> = T[] & { count: number };

interface BunSQL {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  unsafe<T = unknown>(
    sql: string,
    params?: unknown[]
  ): Promise<BunSQLResult<T>>;
  begin<T>(fn: (sql: BunSQLTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  reserve(): Promise<BunSQLReservedConnection>;
}

interface BunSQLTransaction {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  unsafe<T = unknown>(
    sql: string,
    params?: unknown[]
  ): Promise<BunSQLResult<T>>;
  savepoint<T>(fn: (sql: BunSQLTransaction) => Promise<T>): Promise<T>;
}

interface BunSQLReservedConnection {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  unsafe<T = unknown>(
    sql: string,
    params?: unknown[]
  ): Promise<BunSQLResult<T>>;
  release(): void;
}

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface BunSQLOptions {
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  tls?: boolean | object;
  max?: number;
  idleTimeout?: number;
  maxLifetime?: number;
}

export interface BunSQLDriverOptions {
  client?: BunSQL;
  databaseUrl?: string;
  options?: BunSQLOptions;
  pgvector?: boolean;
  postgis?: boolean;
}

export type BunSQLClientConfig<C extends DriverConfig> = BunSQLDriverOptions &
  C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class BunSQLDriver extends Driver<BunSQL, BunSQLTransaction> {
  readonly adapter: DatabaseAdapter;

  private readonly driverOptions: BunSQLDriverOptions;

  constructor(options: BunSQLDriverOptions = {}) {
    super("postgresql", "bun-sql");
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

  protected async initClient(): Promise<BunSQL> {
    const { SQL } = await import("bun");

    if (this.driverOptions.databaseUrl) {
      return new SQL(this.driverOptions.databaseUrl) as unknown as BunSQL;
    }

    return new SQL(this.driverOptions.options ?? {}) as unknown as BunSQL;
  }

  protected async closeClient(sql: BunSQL): Promise<void> {
    await sql.close();
  }

  protected async execute<T>(
    client: BunSQL | BunSQLTransaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "execute";
    const result = await client.unsafe<T>(sql, params);
    return {
      rows: result,
      rowCount: normalizeProviderRowCount(result.count, {
        provider: "bun-sql",
        operation,
      }),
    };
  }

  protected async executeRaw<T>(
    client: BunSQL | BunSQLTransaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "executeRaw";
    const result = await client.unsafe<T>(sql, params);
    return {
      rows: result,
      rowCount: normalizeProviderRowCount(result.count, {
        provider: "bun-sql",
        operation,
      }),
    };
  }

  /**
   * Bun's `sql.begin()` owns BEGIN and connection acquisition, so the isolation
   * level goes in as the transaction's first statement and there is no
   * acquisition step VibORM can bound.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "post-begin",
      timeout: true,
      maxWait: "unsupported",
      maxWaitReason:
        "Bun SQL acquires the connection inside sql.begin(), which VibORM cannot observe or bound — the wait would be unbounded no matter what maxWait said",
    };
  }

  protected async transaction<T>(
    client: BunSQL | BunSQLTransaction,
    fn: (tx: BunSQLTransaction) => Promise<T>
  ): Promise<T> {
    if ("savepoint" in client) {
      throw nestedTransactionDispatchError(this.driverName);
    }

    return runProviderManagedTransaction({
      run: (callback) => client.begin(callback),
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

export function createClient<C extends DriverConfig>(
  config: BunSQLClientConfig<C>
) {
  const { client, databaseUrl, options, pgvector, postgis, ...restConfig } =
    config;

  const driver = new BunSQLDriver({
    client,
    databaseUrl,
    options,
    pgvector,
    postgis,
  });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: BunSQLDriver }>;
}
