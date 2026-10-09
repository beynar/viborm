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
  type LinkedClientConfig,
  type NoExtraDriverConfigKeys,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import { ConnectionError, VibORMErrorCode } from "@errors";
import type {
  Client,
  Config,
  InStatement,
  InValue,
  ResultSet,
  Transaction,
} from "@libsql/client";
import { physicalConnectionQueue } from "../connection-scope";
import {
  Driver,
  type DriverResultParser,
  type QueryExecutionContext,
} from "../driver";
import { getExecutionTransactionPhases } from "../execution-context";
import { normalizeProviderRowCount } from "../normalized-result";
import {
  acquireWithMaxWait,
  convertValueForSQLite,
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

// A native BUSY can leave libSQL's private pooled connection unusable.
// The Client API cannot recover that exact handle without affecting borrowers.
const unsafeLocalClients = new WeakSet<Client>();

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
  return values.map((parameter) => {
    const value = convertValueForSQLite(parameter);
    if (typeof value === "string" && value.includes("\0")) {
      throw new TypeError(
        "libSQL cannot preserve strings containing NUL bytes"
      );
    }
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
  readonly maxBindParametersPerStatement: number | undefined = 32_766;
  readonly result: DriverResultParser = sqliteResultParser;
  protected override readonly serializeTransactions: boolean;

  private readonly driverOptions: LibSQLDriverOptions;
  private readonly suppliedClient: Client | undefined;

  constructor(options: LibSQLDriverOptions = {}) {
    super("sqlite", "libsql");
    this.driverOptions = options;
    this.suppliedClient = options.client;
    this.serializeTransactions = this.suppliedClient
      ? this.suppliedClient.protocol === "file"
      : this.getDatabaseUrl().startsWith("file:");

    if (this.suppliedClient) {
      this.client = this.suppliedClient;
      if (this.serializeTransactions)
        Object.defineProperty(this, "connectionQueue", {
          value: physicalConnectionQueue(this.suppliedClient),
        });
    }
  }

  protected async initClient(): Promise<Client> {
    if (this.suppliedClient) return this.suppliedClient;
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
      timeout: 5000,
      ...options,
      intMode: "bigint",
    });
  }

  protected async closeClient(client: Client | Transaction): Promise<void> {
    if (client !== this.suppliedClient && "close" in client) {
      client.close();
      if (!("commit" in client)) unsafeLocalClients.delete(client);
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
    const result = await this.executeStatement(client, { sql, args: values });
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
    const result = await this.executeStatement(client, { sql, args: values });
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
      maxWait: this.serializeTransactions ? "queue" : "acquisition",
    };
  }

  protected async transaction<T>(
    client: Client | Transaction,
    fn: (tx: Client | Transaction) => Promise<T>,
    context?: QueryExecutionContext,
    options?: DriverTransactionOptions
  ): Promise<T> {
    if ("commit" in client) {
      throw nestedTransactionDispatchError(this.driverName);
    }

    const tx = await acquireWithMaxWait(
      () => this.quarantineOnBusy(client, () => client.transaction("write")),
      (acquired) => acquired.close(),
      options?.maxWaitMs,
      { driverName: this.driverName, form: "callback" }
    );
    return runTransactionLifecycle({
      begin: () => undefined,
      callback: () => fn(tx),
      commit: () => tx.commit(),
      rollback: () => tx.rollback(),
      phases: getExecutionTransactionPhases(context),
      close: () => tx.close(),
    });
  }

  protected override transactionCleanupFailed(_error: Error): void {
    // Transactions own dedicated provider connections, including :memory:.
  }

  private executeStatement(
    client: Client | Transaction,
    statement: InStatement
  ): Promise<ResultSet> {
    return this.quarantineOnBusy(client, () => client.execute(statement));
  }

  /**
   * A local BUSY can leave the failed statement unfinished on libSQL's pooled
   * connection; SQLite then never commits that connection's later autocommit
   * writes. Statements and transaction acquisition (its BEGIN) both borrow
   * that connection, so both quarantine this exact client.
   */
  private async quarantineOnBusy<R>(
    client: Client | Transaction,
    work: () => Promise<R>
  ): Promise<R> {
    try {
      return await work();
    } catch (error) {
      if (
        this.serializeTransactions &&
        !("commit" in client) &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        (error.code === "SQLITE_BUSY" || error.code.startsWith("SQLITE_BUSY_"))
      ) {
        unsafeLocalClients.add(client);
        // The normal disconnect owner retains this exact handle for cleanup.
        this.closeRetryClient = client;
        this.client = null;
        this.initPromise = null;
      }
      throw error;
    }
  }

  protected override async getClient(
    context?: QueryExecutionContext
  ): Promise<Client | Transaction> {
    const client = await super.getClient(context);
    this.assertLocalClientUsable(client);
    return client;
  }

  private assertLocalClientUsable(client: Client | Transaction): void {
    if (!("commit" in client) && unsafeLocalClients.has(client)) {
      throw new ConnectionError(
        "Local libSQL execution encountered SQLITE_BUSY; disconnect an owned driver, or close and replace the supplied native client, before reuse.",
        { code: VibORMErrorCode.CONNECTION_CLOSED, meta: { driver: "libsql" } }
      );
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
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: LibSQLClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, LibSQLDriverOptions, S>
): VibORMClient<{
  [P in keyof LinkedClientConfig<
    C & { driver: LibSQLDriver }
  >]: LinkedClientConfig<C & { driver: LibSQLDriver }>[P];
}> {
  const { client, databaseUrl, dataDir, authToken, options } = config;

  const driver = new LibSQLDriver({
    client,
    databaseUrl,
    dataDir,
    authToken,
    options,
  });

  return createClientFromDriverConfig<S, C, LibSQLDriver>(config, driver);
}
