/**
 * LibSQL Driver (Turso)
 *
 * Driver implementation for @libsql/client - Turso's libSQL client.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import type { Client, Config, Transaction } from "@libsql/client";
import { Driver, type DriverResultParser } from "../driver";
import { convertValuesForSQLite, sqliteResultParser } from "../shared";
import type { QueryResult, TransactionOptions } from "../types";

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type LibSQLOptions = Omit<Config, "url">;

export interface LibSQLDriverOptions {
  client?: Client;
  databaseUrl?: string;
  dataDir?: string;
  authToken?: string;
  options?: LibSQLOptions;
}

export type LibSQLClientConfig<C extends DriverConfig> = LibSQLDriverOptions &
  C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class LibSQLDriver extends Driver<Client, Transaction> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly result: DriverResultParser = sqliteResultParser;

  private readonly driverOptions: LibSQLDriverOptions;
  private savepointCounter = 0;

  constructor(options: LibSQLDriverOptions = {}) {
    super("sqlite", "libsql");
    this.driverOptions = options;

    if (options.client) {
      this.client = options.client;
    }
  }

  protected async initClient(): Promise<Client> {
    const { createClient } = await import("@libsql/client");

    // Priority: databaseUrl > dataDir > in-memory
    let url: string;
    if (this.driverOptions.databaseUrl) {
      url = this.driverOptions.databaseUrl;
    } else if (this.driverOptions.dataDir) {
      url = `file:${this.driverOptions.dataDir}`;
    } else {
      url = "file::memory:";
    }

    const authToken = this.driverOptions.authToken;
    const options = this.driverOptions.options ?? {};

    return createClient({
      url,
      authToken,
      ...options,
    });
  }

  protected async closeClient(client: Client): Promise<void> {
    client.close();
  }

  protected async execute<T>(
    client: Client | Transaction,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const values = convertValuesForSQLite(params);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.execute({ sql, args: values as any });
    return {
      rows: result.rows as T[],
      rowCount: result.rowsAffected ?? result.rows.length,
    };
  }

  protected async executeRaw<T>(
    client: Client | Transaction,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const values = params ? convertValuesForSQLite(params) : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.execute({ sql, args: values as any });
    return {
      rows: result.rows as T[],
      rowCount: result.rowsAffected ?? result.rows.length,
    };
  }

  protected async transaction<T>(
    client: Client | Transaction,
    fn: (tx: Transaction) => Promise<T>,
    _options?: TransactionOptions
  ): Promise<T> {
    // Check if we're in a nested transaction
    if ("execute" in client && "commit" in client) {
      // Already in a transaction - use savepoint
      const tx = client as Transaction;
      const savepointName = `sp_${++this.savepointCounter}_${Date.now()}`;
      await tx.execute(`SAVEPOINT ${savepointName}`);

      try {
        const result = await fn(tx);
        await tx.execute(`RELEASE SAVEPOINT ${savepointName}`);
        return result;
      } catch (error) {
        await tx.execute(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        throw error;
      }
    }

    // Start new transaction from client
    const libsqlClient = client as Client;
    const tx = await libsqlClient.transaction("write");

    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<C extends DriverConfig>(
  config: LibSQLClientConfig<C>
) {
  const { client, databaseUrl, dataDir, authToken, options, ...restConfig } =
    config;

  const driver = new LibSQLDriver({
    client,
    databaseUrl,
    dataDir,
    authToken,
    options,
  });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: LibSQLDriver }>;
}
