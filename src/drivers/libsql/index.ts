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
import {
  assertSQLiteIsolationLevel,
  convertValuesForSQLite,
  runSavepoint,
  sqliteResultParser,
} from "../shared";
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

// libsql reports rowsAffected: 0 for mutations with a RETURNING clause even
// when rows come back, so returned rows are the more reliable count.
const libsqlRowCount = (result: {
  rows: unknown[];
  rowsAffected?: number;
}): number =>
  result.rows.length > 0 ? result.rows.length : (result.rowsAffected ?? 0);

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class LibSQLDriver extends Driver<Client, Client | Transaction> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly result: DriverResultParser = sqliteResultParser;
  protected override readonly serializeTransactions = true;

  private readonly driverOptions: LibSQLDriverOptions;

  constructor(options: LibSQLDriverOptions = {}) {
    super("sqlite", "libsql");
    this.driverOptions = options;

    if (options.client) {
      this.client = options.client;
    }
  }

  protected async initClient(): Promise<Client> {
    const { createClient } = await import("@libsql/client");
    const url = this.getDatabaseUrl();

    const authToken = this.driverOptions.authToken;
    const options = this.driverOptions.options ?? {};

    return createClient({
      url,
      authToken,
      // INTEGER columns come back as BigInt so values >2^53 survive (the
      // default 'number' mode throws on them); the result parser converts
      // int columns back to number
      intMode: "bigint",
      ...options,
    });
  }

  protected async closeClient(client: Client | Transaction): Promise<void> {
    if ("close" in client) {
      client.close();
    }
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
      rowCount: libsqlRowCount(result),
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
      rowCount: libsqlRowCount(result),
    };
  }

  protected async transaction<T>(
    client: Client | Transaction,
    fn: (tx: Client | Transaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    assertSQLiteIsolationLevel(this.driverName, options);

    if (this.inTransaction || "commit" in client) {
      // Nested transaction - use savepoint
      const tx = client;
      return runSavepoint(
        (statement) => tx.execute(statement),
        () => fn(tx)
      );
    }

    if (this.usesInMemoryDatabase()) {
      await client.execute("BEGIN");
      this.inTransaction = true;
      try {
        const result = await fn(client);
        await client.execute("COMMIT");
        return result;
      } catch (error) {
        await client.execute("ROLLBACK");
        throw error;
      }
    }

    // Start new transaction from client
    const tx = await client.transaction("write");
    this.inTransaction = true;

    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    // Note: this.inTransaction reset is handled by base Driver._transaction()
  }

  private getDatabaseUrl(): string {
    if (this.driverOptions.databaseUrl) {
      return this.driverOptions.databaseUrl;
    }
    if (this.driverOptions.dataDir) {
      return `file:${this.driverOptions.dataDir}`;
    }
    return "file::memory:";
  }

  private usesInMemoryDatabase(): boolean {
    return this.getDatabaseUrl().includes(":memory:");
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
