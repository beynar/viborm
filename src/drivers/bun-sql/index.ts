/**
 * Bun SQL Driver
 *
 * Driver implementation for Bun's built-in PostgreSQL client (bun:sql).
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
import type { QueryResult, TransactionOptions } from "../types";

// ============================================================
// TYPE DECLARATIONS FOR BUN:SQL
// ============================================================

// Bun's SQL type - we define inline to avoid requiring bun types at compile time
interface BunSQL {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  unsafe<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  begin<T>(fn: (sql: BunSQLTransaction) => Promise<T>): Promise<T>;
  close(): void;
  reserve(): Promise<BunSQLReservedConnection>;
}

interface BunSQLTransaction {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  unsafe<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  savepoint<T>(fn: (sql: BunSQLTransaction) => Promise<T>): Promise<T>;
}

interface BunSQLReservedConnection {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  unsafe<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
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
    if (!options.pgvector) adapter.vector = unsupportedVector;
    if (!options.postgis) adapter.geospatial = unsupportedGeospatial;
    this.adapter = adapter;
  }

  protected async initClient(): Promise<BunSQL> {
    // bun:sql is a Bun-only built-in module - types may not be available at compile time
    // @ts-expect-error - bun:sql is only available in Bun runtime
    const { SQL } = await import("bun:sql");

    if (this.driverOptions.databaseUrl) {
      return new SQL(this.driverOptions.databaseUrl) as unknown as BunSQL;
    }

    return new SQL(this.driverOptions.options ?? {}) as unknown as BunSQL;
  }

  protected async closeClient(sql: BunSQL): Promise<void> {
    sql.close();
  }

  protected async execute<T>(
    client: BunSQL | BunSQLTransaction,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await client.unsafe<T>(sql, params);
    return {
      rows: result,
      rowCount: result.length,
    };
  }

  protected async executeRaw<T>(
    client: BunSQL | BunSQLTransaction,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await client.unsafe<T>(sql, params);
    return {
      rows: result,
      rowCount: result.length,
    };
  }

  protected async transaction<T>(
    client: BunSQL | BunSQLTransaction,
    fn: (tx: BunSQLTransaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    // Check if we're already in a transaction
    if ("savepoint" in client) {
      // Nested transaction - use savepoint
      const tx = client as BunSQLTransaction;
      return tx.savepoint(fn);
    }

    // Start new transaction
    const sql = client as BunSQL;

    // Bun SQL's begin() doesn't support isolation level as argument
    // Set it manually before the transaction if specified
    if (options?.isolationLevel) {
      const isolationMap: Record<string, string> = {
        read_uncommitted: "READ UNCOMMITTED",
        read_committed: "READ COMMITTED",
        repeatable_read: "REPEATABLE READ",
        serializable: "SERIALIZABLE",
      };
      const level = isolationMap[options.isolationLevel];
      if (!level) {
        throw new Error(`Unknown isolation level: ${options.isolationLevel}`);
      }
      return sql.begin(async (tx) => {
        await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL ${level}`);
        return fn(tx);
      });
    }

    return sql.begin(fn);
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
