import { physicalConnectionQueue } from "../connection-scope";
/**
 * SQLite3 Driver
 *
 * Driver implementation for better-sqlite3 (synchronous SQLite).
 */

import { Buffer } from "node:buffer";
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
import { ClientInitializationError } from "@errors";
import type { Sql } from "@sql";
import Database from "better-sqlite3";
import {
  type AnyDriver,
  Driver,
  type DriverResultParser,
  type QueryExecutionContext,
} from "../driver";
import { getExecutionTransactionPhases } from "../execution-context";
import { assertNormalizedQueryResult } from "../normalized-result";
import {
  assertPositionalRows,
  borrowPositionalResult,
  type ProjectionExecutionResult,
  registerPositionalResultDriver,
} from "../positional-result";
import {
  convertValueForSQLite,
  isSQLiteBinaryValue,
  runTransactionLifecycle,
  sqliteBinaryToUint8Array,
  sqliteResultParser,
  type TransactionOptionSupport,
} from "../shared";
import {
  createStatementCache,
  normalizeSQLiteRawRows,
  parseSQLiteField,
} from "../shared/sqlite-utils";
import type { QueryResult } from "../types";

type SQLite3Database = Database.Database;
type SQLite3Statement = Database.Statement;

/**
 * Positional reads (raw rows, safe integers) and keyed reads and writes set
 * different statement modes, so each keeps its own statement cache.
 */
const stockPrepare = Database.prototype.prepare;
const positionalStatement = createStatementCache<
  SQLite3Statement,
  SQLite3Database
>(() => stockPrepare);
const keyedStatement = createStatementCache<SQLite3Statement, SQLite3Database>(
  () => stockPrepare
);

function convertValuesForSQLite3(values: unknown[]): unknown[] {
  return values.map((parameter) => {
    const value = convertValueForSQLite(parameter);
    if (Buffer.isBuffer(value) || !isSQLiteBinaryValue(value)) {
      return value;
    }
    const bytes = sqliteBinaryToUint8Array(value);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  });
}

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type SQLite3Options = Database.Options;

export interface SQLite3DriverOptions {
  client?: SQLite3Database;
  dataDir?: string;
  options?: SQLite3Options;
}

export type SQLite3ClientConfig<C extends DriverConfig> = SQLite3DriverOptions &
  C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class SQLite3Driver extends Driver<SQLite3Database, SQLite3Database> {
  private static readonly canonicalExecuteEntry =
    SQLite3Driver.prototype._execute;
  private static readonly canonicalExecute = SQLite3Driver.prototype.execute;
  private static readonly canonicalRunStatement =
    SQLite3Driver.prototype.runStatement;
  private static readonly canonicalTypedStatement =
    SQLite3Driver.prototype.executeTypedStatement;
  private static readonly canonicalPositionalExecute =
    SQLite3Driver.prototype.executePositional;
  private static readonly canonicalNativePrepare = Database.prototype.prepare;
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly maxBindParametersPerStatement: number | undefined = 32_766;
  readonly result: DriverResultParser = sqliteResultParser;
  protected override readonly serializeTransactions = true;

  private readonly driverOptions: SQLite3DriverOptions;
  /**
   * The exact transport the caller handed over, captured from ONE read of
   * `options.client` at construction. That identity owns installation,
   * reconnect, and the close decision: a getter answering differently on a
   * second read used to leave this driver holding the caller's database while
   * believing it had made its own.
   */
  private readonly suppliedClient: SQLite3Database | undefined;
  private readonly canonicalAdapterParseResult =
    this.adapter.result.parseResult;
  private readonly canonicalAdapter = this.adapter;
  private readonly canonicalAdapterResult = this.adapter.result;
  private readonly canonicalAdapterParseField = this.adapter.result.parseField;
  private readonly canonicalAdapterParseRelation =
    this.adapter.result.parseRelation;

  constructor(options: SQLite3DriverOptions = {}) {
    super("sqlite", "sqlite3");
    this.driverOptions = options;
    this.suppliedClient = options.client;

    if (this.suppliedClient) {
      if (this.suppliedClient.pragma("foreign_keys", { simple: true }) !== 1) {
        throw new ClientInitializationError(
          "A supplied SQLite database must enable PRAGMA foreign_keys = ON before wrapping.",
          { meta: { driver: "sqlite3" } }
        );
      }
      this.client = this.suppliedClient;
      Object.defineProperty(this, "connectionQueue", {
        value: physicalConnectionQueue(this.suppliedClient),
      });
    }
    if (SQLite3Driver.isPositionalCandidate(this)) {
      registerPositionalResultDriver(
        this,
        (query, context) => this.executePositional(query, context),
        SQLite3Driver.isPositionalCandidate
      );
    }
  }

  protected async initClient(): Promise<SQLite3Database> {
    // A supplied database is reinstalled by the exact identity construction
    // captured: two namespace-scoped wrappers can share one transport, and a
    // reconnect that built a fresh `:memory:` database silently swapped the
    // caller's data for an empty file.
    if (this.suppliedClient !== undefined) {
      return this.suppliedClient;
    }
    const dataDir = this.driverOptions.dataDir ?? ":memory:";
    const options = this.driverOptions.options ?? {};

    const db = new Database(dataDir, options);
    // better-sqlite3 happens to enable this already; stated explicitly so FK
    // enforcement is a viborm guarantee, not an inherited library default.
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    return db;
  }

  protected async closeClient(db: SQLite3Database): Promise<void> {
    // A supplied database belongs to the caller, who may be sharing it with a
    // sibling wrapper; the identity test is against the transport actually
    // being closed, not whatever the caller's record says now.
    if (db === this.suppliedClient) {
      return;
    }
    db.close();
  }

  protected async execute<T>(
    client: SQLite3Database,
    sql: string,
    params: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const values = convertValuesForSQLite3(params);
    return this.runStatement<T>(
      client,
      sql,
      values,
      _context?.model !== "$raw"
    );
  }

  protected async executeRaw<T>(
    client: SQLite3Database,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const values = params ? convertValuesForSQLite3(params) : undefined;
    return this.runStatement<T>(client, sql, values, false);
  }

  private async executePositional(
    query: Sql,
    context: QueryExecutionContext
  ): Promise<ProjectionExecutionResult> {
    let producer: SQLite3Database | undefined;
    const response = await this.executeTypedStatement(
      query,
      context,
      async (
        client,
        statement,
        params,
        executionContext
      ): Promise<ProjectionExecutionResult> => {
        const resultContext = {
          provider: this.driverName,
          operation: executionContext.operation ?? "execute",
        };
        // Client initialization and observers can await or run caller work.
        if (!SQLite3Driver.isPositionalProducer(this, client)) {
          const result = await this.execute<unknown>(
            client,
            statement,
            params,
            executionContext
          );
          assertNormalizedQueryResult(result, resultContext);
          return { kind: "borrowed", result };
        }
        const values = convertValuesForSQLite3(params);
        const prepared = positionalStatement(client, statement);
        if (!prepared.reader) {
          const result = prepared.run(...values);
          const borrowed = { rows: [], rowCount: result.changes };
          assertNormalizedQueryResult(borrowed, resultContext);
          return { kind: "borrowed", result: borrowed };
        }
        producer = client;
        // A statement runs once, so integers are read exactly on that one run.
        // A re-read could not be proven harmless: a transform can make this an
        // `UPDATE … RETURNING`, and even a statement SQLite reports read-only
        // may call an application function with an observable effect.
        prepared.safeIntegers(true);
        const rows = prepared.raw().all(...values) as unknown[][];
        // Read after the run: SQLite reprepares a cached statement whose
        // schema changed (`SELECT *` after ADD COLUMN), so metadata read
        // before it would describe the previous columns.
        const columns = prepared.columns().map((column) => column.name);
        assertPositionalRows(rows, columns, resultContext);
        return { kind: "positional", rows, columns };
      }
    );
    if (
      response.kind === "positional" &&
      !(producer && SQLite3Driver.isPositionalProducer(this, producer))
    ) {
      return { kind: "borrowed", result: borrowPositionalResult(response) };
    }
    return response;
  }

  private static isPositionalProducer(
    driver: SQLite3Driver,
    client: SQLite3Database
  ): boolean {
    return (
      SQLite3Driver.isPositionalCandidate(driver) && driver.client === client
    );
  }

  private static isPositionalCandidate(driver: AnyDriver): boolean {
    if (!(driver instanceof SQLite3Driver)) return false;
    return (
      driver.driverOptions.options?.nativeBinding === undefined &&
      SQLite3Driver.hasCanonicalProducerSurface(driver) &&
      driver.executeTypedStatement === SQLite3Driver.canonicalTypedStatement &&
      driver.executePositional === SQLite3Driver.canonicalPositionalExecute &&
      driver.result.parseField === parseSQLiteField &&
      driver.result.parseRelation === undefined &&
      driver.result.parseResult === undefined &&
      driver.adapter === driver.canonicalAdapter &&
      driver.adapter.result === driver.canonicalAdapterResult &&
      driver.adapter.result.parseField === driver.canonicalAdapterParseField &&
      driver.adapter.result.parseRelation ===
        driver.canonicalAdapterParseRelation &&
      (driver.client === undefined ||
        driver.client === null ||
        SQLite3Driver.isPositionalClient(driver.client))
    );
  }

  private static isPositionalClient(client: SQLite3Database): boolean {
    return (
      Object.getPrototypeOf(client) === Database.prototype &&
      !Object.hasOwn(client, "prepare") &&
      Object.getOwnPropertyDescriptor(Database.prototype, "prepare")?.value ===
        SQLite3Driver.canonicalNativePrepare
    );
  }

  private runStatement<T>(
    db: SQLite3Database,
    sql: string,
    values: unknown[] | undefined,
    typed: boolean
  ): QueryResult<T> {
    const stmt = typed ? keyedStatement(db, sql) : db.prepare(sql);

    if (stmt.reader) {
      // Read once without precision loss. Typed model parsing owns its domain;
      // raw results expose safe integers as numbers and wider integers as bigint.
      stmt.safeIntegers(true);
      const rows = (values ? stmt.all(...values) : stmt.all()) as T[];
      return {
        rows: typed ? rows : normalizeSQLiteRawRows(rows),
        rowCount: rows.length,
      };
    }

    const result = values ? stmt.run(...values) : stmt.run();
    return { rows: [] as T[], rowCount: result.changes };
  }

  /**
   * Whether the surface a caller can reach on this instance is still the
   * SHIPPED one.
   *
   * The result leg asks for the parser OBJECT, not for one of its hooks: a
   * positional result hands out the provider's own row arrays, so a driver is
   * stock only while `result` IS `sqliteResultParser` — the object
   * `shared/sqlite-utils.ts` owns — and anything a caller put there instead,
   * whatever hook it spells, is a middleware that will see those rows and
   * keeps the transport borrowed (root `AGENTS.md` rule 5: a stock driver with
   * "unchanged typed execution/parser surfaces", where "a parser middleware …
   * stays borrowed"). Asking only about `parseResult` asked a narrower
   * question, and since D-35 left the shipped parser with no result hook of its
   * own it admitted every object that merely lacks one (Arnaud's D-39).
   *
   * The adapter leg is unchanged, and is a different question: the adapter is
   * this driver's own object, captured once at construction, so what is asked
   * there is whether anything re-entered it afterwards.
   */
  private static hasCanonicalProducerSurface(driver: SQLite3Driver): boolean {
    return (
      Object.getPrototypeOf(driver) === SQLite3Driver.prototype &&
      driver._execute === SQLite3Driver.canonicalExecuteEntry &&
      driver.execute === SQLite3Driver.canonicalExecute &&
      driver.runStatement === SQLite3Driver.canonicalRunStatement &&
      driver.result === sqliteResultParser &&
      driver.adapter.result.parseResult === driver.canonicalAdapterParseResult
    );
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
    client: SQLite3Database,
    fn: (tx: SQLite3Database) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    return runTransactionLifecycle({
      begin: () => client.exec("BEGIN IMMEDIATE"),
      callback: () => fn(client),
      commit: () => client.exec("COMMIT"),
      // A failed BEGIN never grants rollback ownership. After a failed COMMIT,
      // successful rollback restores this same database, including :memory:.
      rollback: () => {
        if (client.inTransaction) client.exec("ROLLBACK");
      },
      phases: getExecutionTransactionPhases(context),
    });
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: SQLite3ClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, SQLite3DriverOptions, S>
): VibORMClient<{
  [P in keyof LinkedClientConfig<
    C & { driver: SQLite3Driver }
  >]: LinkedClientConfig<C & { driver: SQLite3Driver }>[P];
}> {
  const { client, dataDir, options } = config;

  const driver = new SQLite3Driver({ client, dataDir, options });

  return createClientFromDriverConfig<S, C, SQLite3Driver>(config, driver);
}
