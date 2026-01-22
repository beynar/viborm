/**
 * PlanetScale Driver (Vitess MySQL)
 *
 * Driver implementation for @planetscale/database - PlanetScale's serverless MySQL driver.
 * Supports transactions via the Client.transaction() method.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import type {
  Client,
  Config,
  Connection,
  Transaction,
} from "@planetscale/database";
import { Driver, type DriverResultParser } from "../driver";
import { mysqlResultParser } from "../shared";
import type { QueryResult, TransactionOptions } from "../types";

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type PlanetScaleOptions = Omit<Config, "url">;

export interface PlanetScaleDriverOptions {
  client?: Client;
  databaseUrl?: string;
  options?: PlanetScaleOptions;
}

export type PlanetScaleClientConfig<C extends DriverConfig> =
  PlanetScaleDriverOptions & C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

type PlanetScaleClient = Client | Connection;

export class PlanetScaleDriver extends Driver<PlanetScaleClient, Transaction> {
  readonly adapter: DatabaseAdapter = new MySQLAdapter();
  readonly result: DriverResultParser = mysqlResultParser;
  readonly supportsTransactions = true;

  private readonly driverOptions: PlanetScaleDriverOptions;

  constructor(options: PlanetScaleDriverOptions = {}) {
    super("mysql", "planetscale");
    this.driverOptions = options;

    if (options.client) {
      this.client = options.client;
    }
  }

  protected async initClient(): Promise<PlanetScaleClient> {
    const { Client } = await import("@planetscale/database");

    const config: Config = { ...this.driverOptions.options };

    if (this.driverOptions.databaseUrl) {
      config.url = this.driverOptions.databaseUrl;
    }

    return new Client(config);
  }

  protected async closeClient(_client: PlanetScaleClient): Promise<void> {
    // PlanetScale HTTP client doesn't need to be closed
  }

  protected async execute<T>(
    client: PlanetScaleClient | Transaction,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await client.execute(sql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rowsAffected ?? result.rows.length,
    };
  }

  protected async executeRaw<T>(
    client: PlanetScaleClient | Transaction,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await client.execute(sql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rowsAffected ?? result.rows.length,
    };
  }

  protected async transaction<T>(
    client: PlanetScaleClient | Transaction,
    fn: (tx: Transaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    // If we're already in a transaction, use the existing transaction context
    if ("execute" in client && !("transaction" in client)) {
      return fn(client as Transaction);
    }

    const psClient = client as Client;

    // Set isolation level BEFORE starting transaction (MySQL requirement)
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
      // SET TRANSACTION must be executed before START TRANSACTION in MySQL
      await psClient.execute(`SET TRANSACTION ISOLATION LEVEL ${level}`);
    }

    // Use PlanetScale's transaction() method
    return psClient.transaction(fn);
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<C extends DriverConfig>(
  config: PlanetScaleClientConfig<C>
) {
  const { client, databaseUrl, options, ...restConfig } = config;

  const driver = new PlanetScaleDriver({
    client,
    databaseUrl,
    options,
  });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: PlanetScaleDriver }>;
}
