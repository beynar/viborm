/**
 * LibSQL Driver (Turso)
 *
 * Driver implementation for @libsql/client - Turso's libSQL client.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  createClientFromDriverConfig,
  type DriverConfig,
  type NoExtraDriverConfigKeys,
  type NoExtraNestedConfigKeys,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import type { Client, Config, InValue, Transaction } from "@libsql/client";
import {
  Driver,
  type DriverResultParser,
  type QueryExecutionContext,
} from "../driver";
import { normalizeProviderRowCount } from "../normalized-result";
import {
  acquireWithMaxWait,
  convertValuesForSQLite,
  type DriverTransactionOptions,
  isSQLiteBinaryValue,
  nestedTransactionDispatchError,
  runTransactionLifecycle,
  sqliteBinaryToUint8Array,
  sqliteResultParser,
  type TransactionOptionSupport,
} from "../shared";
import type { QueryResult } from "../types";

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

function convertValuesForLibSQL(values: unknown[]): InValue[] {
  return convertValuesForSQLite(values).map((value) => {
    if (isSQLiteBinaryValue(value)) {
      return value instanceof ArrayBuffer
        ? value
        : sqliteBinaryToUint8Array(value);
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "boolean" ||
      value instanceof Date
    ) {
      return value;
    }
    throw new TypeError(
      'Driver "libsql" received an unsupported SQLite parameter value.'
    );
  });
}

// libsql reports rowsAffected: 0 for mutations with a RETURNING clause even
// when rows come back, so returned rows are the more reliable count.
const libsqlRowCount = (
  result: {
    rows: unknown[];
    rowsAffected: number;
  },
  operation: string
): number => {
  const affected = normalizeProviderRowCount(result.rowsAffected, {
    provider: "libsql",
    operation,
  });
  return result.rows.length > 0 ? result.rows.length : affected;
};

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class LibSQLDriver extends Driver<Client, Client | Transaction> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly maxBindParametersPerStatement: number | undefined = 999;
  readonly result: DriverResultParser = sqliteResultParser;
  protected override readonly serializeTransactions: boolean;

  private readonly driverOptions: LibSQLDriverOptions;

  constructor(options: LibSQLDriverOptions = {}) {
    super("sqlite", "libsql");
    this.driverOptions = options;
    this.serializeTransactions = this.usesInMemoryDatabase();

    if (options.client) {
      this.client = options.client;
    }
  }

  protected async initClient(): Promise<Client> {
    const { createClient } = await import("@libsql/client");
    const url = this.getDatabaseUrl();

    // No `PRAGMA foreign_keys = ON` here: libsql's engine flipped upstream
    // SQLite's default, so enforcement is already on for file:, :memory: and
    // Turso alike — and a per-connection pragma issued once at init could not
    // be relied on across remote HTTP requests anyway. sqlite3 and bun-sqlite
    // set it explicitly; here the engine itself states the same guarantee.

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
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "execute";
    const values = convertValuesForLibSQL(params);
    const result = await client.execute({ sql, args: values });
    return {
      rows: result.rows as T[],
      rowCount: libsqlRowCount(result, operation),
    };
  }

  protected async executeRaw<T>(
    client: Client | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "executeRaw";
    const values = params ? convertValuesForLibSQL(params) : [];
    const result = await client.execute({ sql, args: values });
    return {
      rows: result.rows as T[],
      rowCount: libsqlRowCount(result, operation),
    };
  }

  /**
   * libSQL speaks SQLite, so `Serializable` is honored by construction and the
   * weaker levels are refused. `maxWait` is honored on both shapes, by two
   * different mechanisms: in-memory databases serialize through the connection
   * queue, and every other database awaits `client.transaction("write")`, an
   * acquisition we can bound and close if we stop waiting.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "serializable-only",
      isolationLevelReason:
        "libSQL serializes writers the way SQLite does and has no statement to weaken isolation, so only Serializable can be honored truthfully",
      timeout: true,
      maxWait: this.usesInMemoryDatabase() ? "queue" : "acquisition",
    };
  }

  protected async transaction<T>(
    client: Client | Transaction,
    fn: (tx: Client | Transaction) => Promise<T>,
    _context?: QueryExecutionContext,
    options?: DriverTransactionOptions
  ): Promise<T> {
    if ("commit" in client) {
      throw nestedTransactionDispatchError(this.driverName);
    }

    if (this.usesInMemoryDatabase()) {
      let shouldClose = false;
      const executeOrClose = async (statement: string) => {
        try {
          await client.execute(statement);
        } catch (error) {
          shouldClose = true;
          throw error;
        }
      };
      return runTransactionLifecycle({
        begin: () => executeOrClose("BEGIN"),
        callback: () => fn(client),
        commit: () => executeOrClose("COMMIT"),
        rollback: () => executeOrClose("ROLLBACK"),
        close: () => {
          if (shouldClose) {
            client.close();
            this.client = null;
          }
        },
      });
    }

    const tx = await acquireWithMaxWait(
      () => client.transaction("write"),
      (acquired) => acquired.close(),
      options?.maxWaitMs,
      { driverName: this.driverName, form: "callback" }
    );
    return runTransactionLifecycle({
      begin: () => undefined,
      callback: () => fn(tx),
      commit: () => tx.commit(),
      rollback: () => tx.rollback(),
      close: () => tx.close(),
    });
  }

  protected override transactionCleanupFailed(error: Error): void {
    if (this.usesInMemoryDatabase()) {
      super.transactionCleanupFailed(error);
    }
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

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: LibSQLClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, LibSQLDriverOptions, S> &
    NoExtraNestedConfigKeys<C, S>
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

  return createClientFromDriverConfig({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: LibSQLDriver }>;
}
