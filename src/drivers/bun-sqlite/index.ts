/**
 * Bun SQLite Driver
 *
 * Driver implementation for Bun's built-in SQLite (bun:sqlite).
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
import { FeatureNotSupportedError } from "@errors";
import { Driver, type DriverResultParser } from "../driver";
import {
  convertValuesForSQLite,
  isSQLiteBinaryValue,
  runTransactionLifecycle,
  sqliteBinaryToUint8Array,
  sqliteResultParser,
  type TransactionOptionSupport,
} from "../shared";
import type { QueryResult } from "../types";

// ============================================================
// TYPE DECLARATIONS FOR BUN:SQLITE
// ============================================================

// Bun's Database type - we define inline to avoid requiring bun types at compile time
interface BunSQLiteDatabase {
  query<T = unknown>(sql: string): BunSQLiteStatement<T>;
  prepare<T = unknown>(sql: string): BunSQLiteStatement<T>;
  run(sql: string, ...params: unknown[]): void;
  exec(sql: string): void;
  close(): void;
  transaction<T>(fn: () => T): () => T;
}

interface BunSQLiteStatement<T = unknown> {
  readonly columnNames: string[];
  all(...params: unknown[]): T[];
  get(...params: unknown[]): T | null;
  run(...params: unknown[]): {
    changes: number;
    lastInsertRowid: number | bigint;
  };
  /**
   * Reads INTEGER columns as BigInt instead of lossy JS numbers. Present on
   * `bun:sqlite` statements since Bun 1.1.14; the driver refuses to read
   * rather than return corrupted values when it is missing.
   */
  safeIntegers(safe: boolean): BunSQLiteStatement<T>;
  values(...params: unknown[]): unknown[][];
}

/**
 * `safeIntegers()` is what keeps an INTEGER past 2^53 from being rounded on
 * the way out of SQLite. A `bun:sqlite` old enough to lack it cannot answer
 * the query truthfully, so the read is refused instead of silently returning
 * a corrupted number — the one outcome that must never ship.
 */
function requireSafeIntegers<T>(
  stmt: BunSQLiteStatement<T>
): BunSQLiteStatement<T> {
  if (typeof stmt.safeIntegers !== "function") {
    throw new FeatureNotSupportedError(
      "bun:sqlite",
      "Statement.safeIntegers",
      "This Bun build cannot read INTEGER columns as BigInt, so any value past 2^53 would come back silently rounded. Upgrade to Bun 1.1.14 or newer."
    );
  }
  return stmt;
}

function convertValuesForBunSQLite(values: unknown[]): unknown[] {
  return convertValuesForSQLite(values).map((value) => {
    if (value instanceof Uint8Array || !isSQLiteBinaryValue(value)) {
      return value;
    }
    return sqliteBinaryToUint8Array(value);
  });
}

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface BunSQLiteOptions {
  readonly?: boolean;
  create?: boolean;
  readwrite?: boolean;
  strict?: boolean;
}

export interface BunSQLiteDriverOptions {
  client?: BunSQLiteDatabase;
  dataDir?: string;
  options?: BunSQLiteOptions;
}

export type BunSQLiteClientConfig<C extends DriverConfig> =
  BunSQLiteDriverOptions & C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class BunSQLiteDriver extends Driver<
  BunSQLiteDatabase,
  BunSQLiteDatabase
> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly maxBindParametersPerStatement: number | undefined = 999;
  readonly result: DriverResultParser = sqliteResultParser;
  protected override readonly serializeTransactions = true;

  private readonly driverOptions: BunSQLiteDriverOptions;

  constructor(options: BunSQLiteDriverOptions = {}) {
    super("sqlite", "bun-sqlite");
    this.driverOptions = options;

    if (options.client) {
      this.client = options.client;
    }
  }

  protected async initClient(): Promise<BunSQLiteDatabase> {
    // Dynamic import for bun:sqlite
    const { Database } = await import("bun:sqlite");

    const dataDir = this.driverOptions.dataDir ?? ":memory:";
    const options = this.driverOptions.options;

    // bun:sqlite derives its open flags from this object and rejects one that
    // names no access mode: `new Database(path, {})` throws SQLITE_MISUSE
    // ("flags must include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE").
    // An options bag that says nothing must mean nothing, so the argument is
    // omitted entirely and Bun applies its own default (readwrite + create).
    const db = (options === undefined || Object.keys(options).length === 0
      ? new Database(dataDir)
      : new Database(dataDir, options)) as unknown as BunSQLiteDatabase;

    // bun:sqlite leaves SQLite's foreign_keys default (OFF), which would let a
    // dangling FK write report success while sqlite3 and libsql refuse it.
    // Enforcement is a viborm guarantee, not an inherited library default.
    db.exec("PRAGMA foreign_keys = ON");

    return db;
  }

  protected async closeClient(db: BunSQLiteDatabase): Promise<void> {
    db.close();
  }

  protected async execute<T>(
    client: BunSQLiteDatabase,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const values = convertValuesForBunSQLite(params);
    return this.runStatement<T>(client, sql, values, true);
  }

  protected async executeRaw<T>(
    client: BunSQLiteDatabase,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const values = params ? convertValuesForBunSQLite(params) : undefined;
    // Raw results bypass the result parser — keep bun:sqlite's plain numbers
    // instead of surfacing BigInt to raw callers, matching sqlite3
    return this.runStatement<T>(client, sql, values, false);
  }

  private runStatement<T>(
    db: BunSQLiteDatabase,
    sql: string,
    values: unknown[] | undefined,
    safeIntegers: boolean
  ): QueryResult<T> {
    const stmt = db.prepare(sql);

    if (stmt.columnNames.length > 0) {
      if (safeIntegers) {
        // INTEGER columns come back as BigInt so values >2^53 survive; the
        // result parser converts int columns back to number
        requireSafeIntegers(stmt).safeIntegers(true);
      }
      const rows = (values ? stmt.all(...values) : stmt.all()) as T[];
      return { rows, rowCount: rows.length };
    }

    const result = values ? stmt.run(...values) : stmt.run();
    return { rows: [] as T[], rowCount: result.changes };
  }

  /**
   * SQLite has no isolation-level statement: one writer at a time on one
   * connection makes every transaction serializable already. `Serializable` is
   * therefore honored by construction, with no SQL to emit; the three weaker
   * levels are refused because pretending to relax isolation we cannot relax
   * would misreport what the transaction actually guarantees.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "serializable-only",
      isolationLevelReason:
        "SQLite serializes transactions on a single connection and has no statement to weaken isolation, so only Serializable can be honored truthfully",
      timeout: true,
      maxWait: "queue",
    };
  }

  protected async transaction<T>(
    client: BunSQLiteDatabase,
    fn: (tx: BunSQLiteDatabase) => Promise<T>
  ): Promise<T> {
    let shouldClose = false;
    const executeOrClose = (statement: string) => {
      try {
        client.exec(statement);
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
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: BunSQLiteClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, BunSQLiteDriverOptions, S> &
    NoExtraNestedConfigKeys<C, S>
): VibORMClient<C & { driver: BunSQLiteDriver }> {
  const { client, dataDir, options, ...restConfig } = config;

  const driver = new BunSQLiteDriver({ client, dataDir, options });

  return createClientFromDriverConfig({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: BunSQLiteDriver }>;
}
