/**
 * PostgreSQL Driver (postgres.js)
 *
 * Driver implementation for postgres.js - a modern, fast PostgreSQL client.
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
import { unsupportedGeospatial, unsupportedVector } from "@errors";
import postgres, {
  type Options as PostgresOptionsType,
  type Sql as PostgresSql,
} from "postgres";
import { Driver, type QueryExecutionContext } from "../driver";
import {
  nestedTransactionDispatchError,
  normalizePostgresRowCount,
  runProviderManagedTransaction,
  type TransactionOptionSupport,
} from "../shared";
import type { QueryResult } from "../types";

export type PostgresOptions = PostgresOptionsType<
  Record<string, postgres.PostgresType>
>;

type PostgresTransaction = postgres.TransactionSql<Record<string, unknown>>;

export interface PostgresDriverOptions {
  client?: PostgresSql<Record<string, unknown>>;
  options?: PostgresOptions;
  pgvector?: boolean;
  postgis?: boolean;
  databaseUrl?: string;
}

const parseDatabaseUrl = (url: string): PostgresOptions => {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 5432,
    database: parsed.pathname.slice(1), // Remove leading "/"
    user: parsed.username || undefined,
    password: parsed.password || undefined,
  };
};

const vibormTypes: Record<string, postgres.PostgresType> = {
  // TIMESTAMP WITHOUT TIME ZONE (1114): postgres.js builds process-local
  // Dates, shifting the stored UTC wall clock by the process timezone. Keep
  // the raw string — the shared result parser builds a UTC Date from it,
  // matching every other driver. (DATE already arrives as a string.)
  timestamp: {
    to: 1114,
    from: [1114],
    serialize: (value: unknown) => value as string,
    parse: (value: string) => value,
  },
  // json/jsonb params arrive pre-serialized from the adapter; postgres.js
  // would JSON.stringify them a second time once the server declares the
  // param type, double-encoding the stored value
  json: {
    to: 114,
    from: [114, 3802],
    serialize: (value: unknown) =>
      typeof value === "string" ? value : JSON.stringify(value),
    parse: (value: string) => JSON.parse(value),
  },
};

const withVibormTypes = (options: PostgresOptions = {}): PostgresOptions => ({
  ...options,
  types: { ...vibormTypes, ...options.types },
});

export type PostgresClientConfig<C extends DriverConfig> =
  PostgresDriverOptions & C;

type PostgresClient = PostgresSql<Record<string, unknown>>;

const isTransaction = (
  client: PostgresClient | PostgresTransaction
): client is PostgresTransaction => {
  return "savepoint" in client;
};

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PostgresDriver extends Driver<
  PostgresClient,
  PostgresTransaction
> {
  readonly adapter: DatabaseAdapter;

  private readonly driverOptions: PostgresDriverOptions;

  constructor(options: PostgresDriverOptions = {}) {
    super("postgresql", "postgres");
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

  protected async initClient(): Promise<PostgresClient> {
    const { databaseUrl, options } = this.driverOptions;
    if (databaseUrl) {
      return postgres(
        withVibormTypes({ ...parseDatabaseUrl(databaseUrl), ...options })
      );
    }
    return postgres(withVibormTypes(options));
  }

  protected async closeClient(sql: PostgresClient): Promise<void> {
    await sql.end();
  }

  protected async execute<T>(
    client: PostgresClient | PostgresTransaction,
    sqlStr: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "execute";
    // postgres.js unsafe() takes (query, parameters?, queryOptions?)
    // parameters must be cast as postgres expects specific types
    const result = await client.unsafe<T[]>(sqlStr, params);
    return {
      rows: result,
      rowCount: normalizePostgresRowCount(
        result.count,
        result.command,
        result,
        {
          provider: "postgres",
          operation,
        }
      ),
    };
  }

  protected async executeRaw<T>(
    client: PostgresClient | PostgresTransaction,
    sqlStr: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "executeRaw";
    const result = await client.unsafe<T[]>(sqlStr, params);
    return {
      rows: result,
      rowCount: normalizePostgresRowCount(
        result.count,
        result.command,
        result,
        {
          provider: "postgres",
          operation,
        }
      ),
    };
  }

  /**
   * postgres.js owns BEGIN inside `client.begin()`, so the isolation level goes
   * in as the transaction's first statement. It also owns connection
   * acquisition inside that same call: there is no acquisition step VibORM can
   * bound or abandon, so `maxWait` is refused rather than faked.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "post-begin",
      timeout: true,
      maxWait: "unsupported",
      maxWaitReason:
        "postgres.js acquires the connection inside client.begin(), which VibORM cannot observe or bound — the wait would be unbounded no matter what maxWait said",
    };
  }

  protected async transaction<T>(
    client: PostgresClient | PostgresTransaction,
    fn: (tx: PostgresTransaction) => Promise<T>
  ): Promise<T> {
    if (isTransaction(client)) {
      throw nestedTransactionDispatchError(this.driverName);
    }

    return runProviderManagedTransaction({
      run: (callback) => client.begin(callback),
      callback: fn,
      close: async () => {
        await client.end();
        this.client = null;
      },
    });
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: PostgresClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, PostgresDriverOptions, S> &
    NoExtraNestedConfigKeys<C, S>
) {
  const {
    client,
    options = {},
    pgvector,
    postgis,
    databaseUrl,
    ...restConfig
  } = config;

  if (databaseUrl) {
    Object.assign(options, parseDatabaseUrl(databaseUrl));
  }

  const driver = new PostgresDriver({
    client,
    options,
    pgvector,
    postgis,
  });

  return createClientFromDriverConfig({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: PostgresDriver }>;
}
