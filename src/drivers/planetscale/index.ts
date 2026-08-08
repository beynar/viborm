/**
 * PlanetScale Driver (Vitess MySQL)
 *
 * Driver implementation for @planetscale/database - PlanetScale's serverless MySQL driver.
 * Transactions pin one Connection and enable Vitess SINGLE mode before BEGIN;
 * Client.transaction() is intentionally not used because it hides that setup.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import {
  createClientFromDriverConfig,
  type DriverConfig,
  type NoExtraDriverConfigKeys,
  type NoExtraNestedConfigKeys,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import type { Client, Config, Connection } from "@planetscale/database";
import { isRecord } from "@validation/value-guards";
import {
  Driver,
  type DriverResultParser,
  type QueryExecutionContext,
} from "../driver";
import {
  normalizeProviderInsertId,
  normalizeProviderRowCount,
} from "../normalized-result";
import {
  type DriverTransactionOptions,
  isolationLevelStatement,
  mysqlResultParser,
  nestedTransactionDispatchError,
  runTransactionLifecycle,
  type TransactionOptionSupport,
} from "../shared";
import type { QueryResult } from "../types";
import { createValidatedPlanetScaleFetch } from "./response-contract";

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
type PlanetScaleTransaction = Pick<Connection, "execute">;

/** PlanetScale reports insertId as a string; "0" means none was generated. */
function toQueryResult<T>(
  result: {
    rows: unknown[];
    rowsAffected: number;
    insertId: string;
  },
  operation: string
): QueryResult<T> {
  const context = { provider: "planetscale", operation };
  const insertId = normalizeProviderInsertId(result.insertId, context);
  return {
    rows: result.rows as T[],
    rowCount: normalizeProviderRowCount(result.rowsAffected, context),
    ...(insertId === undefined ? {} : { insertId }),
  };
}

export class PlanetScaleDriver extends Driver<
  PlanetScaleClient,
  PlanetScaleTransaction
> {
  readonly adapter: DatabaseAdapter = new MySQLAdapter();
  readonly result: DriverResultParser = mysqlResultParser;
  readonly supportsTransactions = true;

  private readonly driverOptions: PlanetScaleDriverOptions;

  constructor(options: PlanetScaleDriverOptions = {}) {
    super("mysql", "planetscale");
    this.driverOptions = options;
  }

  protected async initClient(): Promise<PlanetScaleClient> {
    const { Client } = await import("@planetscale/database");

    const providedClient = this.driverOptions.client;
    if (providedClient) {
      if (!isRecord(providedClient.config)) return providedClient;
      const config: Config = { ...providedClient.config };
      config.fetch = createValidatedPlanetScaleFetch(config.fetch);
      return new Client(config);
    }

    const config: Config = { ...this.driverOptions.options };

    if (this.driverOptions.databaseUrl) {
      config.url = this.driverOptions.databaseUrl;
    }

    config.fetch = createValidatedPlanetScaleFetch(config.fetch);

    return new Client(config);
  }

  protected async closeClient(_client: PlanetScaleClient): Promise<void> {
    // PlanetScale HTTP client doesn't need to be closed
  }

  protected async execute<T>(
    client: PlanetScaleClient | PlanetScaleTransaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "execute";
    const result = await client.execute(sql, params);
    return toQueryResult<T>(result, operation);
  }

  protected async executeRaw<T>(
    client: PlanetScaleClient | PlanetScaleTransaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "executeRaw";
    const result = await client.execute(sql, params);
    return toQueryResult<T>(result, operation);
  }

  /**
   * MySQL semantics: the level must be set before BEGIN, and this driver owns
   * both statements on one `Connection`. Every transaction gets a fresh HTTP
   * `Connection` created synchronously, so there is no slot to wait for.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "pre-begin",
      timeout: true,
      maxWait: "unsupported",
      maxWaitReason:
        "each PlanetScale transaction gets its own HTTP connection created without waiting, so there is no acquisition maxWait could bound",
    };
  }

  protected async transaction<T>(
    client: PlanetScaleClient | PlanetScaleTransaction,
    fn: (tx: PlanetScaleTransaction) => Promise<T>,
    _context?: QueryExecutionContext,
    options?: DriverTransactionOptions
  ): Promise<T> {
    if (!("transaction" in client)) {
      throw nestedTransactionDispatchError(this.driverName);
    }

    const connection: Connection =
      "connection" in client ? client.connection() : client;
    const isolationLevel = options?.isolationLevel;

    return runTransactionLifecycle({
      begin: async () => {
        // Vitess SINGLE mode rejects cross-shard transactions instead of using
        // best-effort multi-shard commit semantics.
        await connection.execute("SET transaction_mode = 'single'");
        // Session-scoped-next-transaction: must precede BEGIN on this same
        // connection to bind to the transaction it opens.
        if (isolationLevel) {
          await connection.execute(isolationLevelStatement(isolationLevel));
        }
        await connection.execute("BEGIN");
      },
      callback: () => fn(connection),
      commit: () => connection.execute("COMMIT"),
      rollback: () => connection.execute("ROLLBACK"),
    });
  }

  protected override transactionCleanupFailed(error: Error): void {
    if (this.client && "connection" in this.client) {
      // Each transaction used a fresh Connection that is now discarded.
      return;
    }
    super.transactionCleanupFailed(error);
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: PlanetScaleClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, PlanetScaleDriverOptions, S> &
    NoExtraNestedConfigKeys<C, S>
) {
  const { client, databaseUrl, options, ...restConfig } = config;

  const driver = new PlanetScaleDriver({
    client,
    databaseUrl,
    options,
  });

  return createClientFromDriverConfig({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: PlanetScaleDriver }>;
}
