/**
 * Driver Interface and Base Implementation
 *
 * Single file containing the Driver interface and LazyDriver base class.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import type { InstrumentationContext } from "@instrumentation/context";

import {
  ATTR_DB_COLLECTION,
  ATTR_DB_DRIVER,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_SYSTEM,
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_TRANSACTION,
} from "@instrumentation/spans";
import type { Operation } from "@query-engine/types";
import type { RelationType } from "@schema/relation/types";
import type { Sql } from "@sql";
import type {
  BatchQuery,
  Dialect,
  QueryResult,
  TransactionOptions,
} from "./types";

// ============================================================
// DRIVER INTERFACE
// ============================================================

/**
 * Driver-level result parsing middleware.
 */
export interface DriverResultParser {
  parseResult?: (
    raw: unknown,
    operation: Operation,
    next: (raw: unknown, operation: Operation) => unknown
  ) => unknown;

  parseRelation?: (
    value: unknown,
    type: RelationType,
    next: (value: unknown, type: RelationType) => unknown
  ) => unknown;

  parseField?: (
    value: unknown,
    fieldType: string,
    next: (value: unknown, fieldType: string) => unknown
  ) => unknown;
}

// ============================================================
// QUERY EXECUTION CONTEXT
// ============================================================

/**
 * Context for the current query execution
 */
export interface QueryExecutionContext {
  model?: string;
  operation?: Operation;
}

// ============================================================
// LAZY DRIVER BASE CLASS
// ============================================================

/**
 * Abstract base class for drivers with lazy client initialization.
 *
 * Subclasses must implement:
 * - `initClient()`: Creates the database client
 * - `closeClient()`: Closes the database client
 * - `execute()`: Executes a query (receives client, sql string, params)
 * - `executeRaw()`: Executes raw SQL (receives client, sql string, params)
 * - `runTransaction()`: Runs a transaction with the client
 */
export abstract class Driver<TClient, TTransaction> {
  connect?(): Promise<void>;

  /**
   * Whether this driver supports transactions (BEGIN/COMMIT/ROLLBACK).
   * Default: true for most drivers, false for HTTP-based drivers like D1, Neon-HTTP.
   */
  readonly supportsTransactions: boolean = true;

  /**
   * Whether this driver supports native batch execution.
   * Batch execution allows multiple independent queries to be executed atomically.
   * Default: false. Override in drivers that have native batch support (D1, D1-HTTP, Neon-HTTP).
   */
  readonly supportsBatch: boolean = false;

  readonly dialect: Dialect;
  readonly driverName: string;
  abstract readonly adapter: DatabaseAdapter;
  readonly result?: DriverResultParser;
  protected client: TClient | TTransaction | null = null;
  protected inTransaction = false;
  private initPromise: Promise<TClient> | null = null;
  private isDisconnecting = false;
  protected instrumentation?: InstrumentationContext;
  protected currentContext: QueryExecutionContext = {};

  // ============================================================
  // ABSTRACT METHODS - Concrete drivers implement these
  // ============================================================

  protected abstract initClient(): Promise<TClient>;
  protected abstract closeClient(client: TClient | TTransaction): Promise<void>;
  /**
   * Execute a query. Receives client, SQL string, and params.
   */
  protected abstract execute<T>(
    client: TClient | TTransaction,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>>;

  /**
   * Execute raw SQL. Receives client, SQL string, and optional params.
   */
  protected abstract executeRaw<T>(
    client: TClient | TTransaction,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;

  /**
   * Run a transaction with the client.
   */
  protected abstract transaction<T>(
    client: TClient | TTransaction,
    fn: (tx: TTransaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T>;

  constructor(dialect: Dialect, driverName: string) {
    this.dialect = dialect;
    this.driverName = driverName;
  }

  /**
   * Set instrumentation context
   */
  setInstrumentation(ctx: InstrumentationContext | undefined): void {
    this.instrumentation = ctx;
  }

  /**
   * Set context before execution (called by query engine)
   */
  setContext(ctx: QueryExecutionContext): void {
    this.currentContext = ctx;
  }

  /**
   * Clear context after execution
   */
  clearContext(): void {
    this.currentContext = {};
  }

  /**
   * Get base OTel attributes for this driver.
   * Can be used by other parts of the code to include standard database attributes.
   */
  getBaseAttributes(): Record<string, string> {
    return {
      [ATTR_DB_SYSTEM]: this.dialect,
      [ATTR_DB_DRIVER]: this.driverName,
    };
  }

  /**
   * Get OTel attributes including current context (model, operation).
   */
  getContextAttributes(): Record<string, string | undefined> {
    const { model, operation } = this.currentContext;
    const attrs: Record<string, string | undefined> = this.getBaseAttributes();
    if (model) attrs[ATTR_DB_COLLECTION] = model;
    if (operation) attrs[ATTR_DB_OPERATION_NAME] = operation;
    return attrs;
  }

  /**
   * Build dialect-specific SQL statement.
   * Uses Sql.toStatement() which caches results per placeholder type.
   */
  protected buildStatement(query: Sql): string {
    switch (this.dialect) {
      case "postgresql":
        return query.toStatement("$n");
      case "sqlite":
      case "mysql":
        return query.toStatement("?");
      default:
        return query.toStatement();
    }
  }

  /**
   * Log a query execution (success)
   */
  protected logQuery(
    sql: string,
    params: unknown[],
    duration: number,
    model?: string,
    operation?: Operation,
    error?: unknown
  ): void {
    if (!this.instrumentation?.logger) return;

    const isError = error instanceof Error;

    if (isError) {
      Object.assign(error, {
        logged: true,
      });
    }
    this.instrumentation.logger[error ? "error" : "query"]({
      timestamp: new Date(),
      duration,
      model,
      operation,
      sql,
      params,
      error: isError ? error : undefined,
    });
  }

  /**
   * Get or initialize the client.
   */
  protected async getClient(): Promise<TClient | TTransaction> {
    if (this.isDisconnecting) {
      throw new Error("Driver is disconnecting");
    }

    if (this.client) return this.client;

    if (!this.initPromise) {
      this.initPromise = this.initClient().then((client) => {
        this.client = client;
        return client;
      });
    }

    return this.initPromise;
  }

  // ============================================================
  // INSTRUMENTATION HELPER
  // ============================================================

  /**
   * Wrap query execution with logging and tracing.
   */
  private async withInstrumentation<T>(
    sql: string,
    params: unknown[],
    executor: () => Promise<QueryResult<T>>
  ): Promise<QueryResult<T>> {
    const startTime = Date.now();
    const { model, operation } = this.currentContext;

    const runAndLog = async () => {
      try {
        const result = await executor();
        this.logQuery(sql, params, Date.now() - startTime, model, operation);
        return result;
      } catch (error) {
        this.logQuery(
          sql,
          params,
          Date.now() - startTime,
          model,
          operation,
          error
        );
        throw error;
      }
    };

    if (!this.instrumentation?.tracer) {
      return runAndLog();
    }

    return this.instrumentation.tracer.startActiveSpan(
      {
        name: SPAN_EXECUTE,
        attributes: this.getContextAttributes(),
        sql: { query: sql, params },
      },
      runAndLog
    );
  }

  // ============================================================
  // PUBLIC API for the driver to be called by the query-engine
  // ============================================================

  /**
   * Execute a query with instrumentation (tracing + logging).
   * Converts Sql to string/params ONCE, then calls run().
   */
  async _execute<T = Record<string, unknown>>(
    query: Sql
  ): Promise<QueryResult<T>> {
    const client = await this.getClient();
    const sql = this.buildStatement(query);
    const params = query.values;

    return this.withInstrumentation(sql, params, () =>
      this.execute<T>(client, sql, params)
    );
  }

  /**
   * Execute raw SQL with instrumentation.
   */
  async _executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const client = await this.getClient();
    return this.withInstrumentation(sql, params ?? [], () =>
      this.executeRaw<T>(client, sql, params)
    );
  }

  /**
   * Execute a function within a transaction.
   *
   * The callback receives the raw transaction object. Use `TransactionBoundDriver`
   * to create a driver that executes all operations within this transaction.
   *
   * @param fn - Callback that receives the transaction object
   * @param options - Transaction options (isolation level, etc.)
   */
  async _transaction<T>(
    fn: (tx: TTransaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const client = await this.getClient();
    const wasInTransaction = this.inTransaction;

    const runTransaction = async () => {
      // Don't set inTransaction here - let driver's transaction() see the original value
      // Driver will set it to true after BEGIN, base class resets in finally
      try {
        return await this.transaction(client, fn, options);
      } finally {
        this.inTransaction = wasInTransaction;
      }
    };

    if (!this.instrumentation?.tracer) {
      return runTransaction();
    }

    return this.instrumentation.tracer.startActiveSpan(
      {
        name: SPAN_TRANSACTION,
        attributes: this.getBaseAttributes(),
      },
      runTransaction
    );
  }

  /**
   * Execute a function with a transaction-bound driver.
   *
   * This is a convenience method that wraps `_transaction` and provides
   * a `TransactionBoundDriver` to the callback, so all operations
   * automatically execute within the transaction.
   *
   * If the driver doesn't support transactions, the callback is executed
   * directly with the current driver (no transaction wrapping).
   *
   * @param fn - Callback that receives a transaction-bound driver
   * @param options - Transaction options (isolation level, etc.)
   *
   * @example
   * ```typescript
   * await driver.withTransaction(async (txDriver) => {
   *   await txDriver._execute(query1);
   *   await txDriver._execute(query2);
   *   // Both queries run in the same transaction
   * });
   * ```
   */
  async withTransaction<T>(
    fn: (txDriver: Driver<TClient, TTransaction>) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    if (!this.supportsTransactions) {
      return fn(this);
    }
    return this._transaction((tx) => {
      const txDriver = new TransactionBoundDriver(this, tx);
      return fn(txDriver);
    }, options);
  }

  // ============================================================
  // BATCH EXECUTION
  // ============================================================

  /**
   * Execute multiple queries in a batch.
   * Default implementation: sequential execution.
   * Override in drivers with native batch support (D1, D1-HTTP, Neon-HTTP).
   */
  protected async executeBatch<T>(
    client: TClient | TTransaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const results: QueryResult<T>[] = [];
    for (const query of queries) {
      results.push(await this.executeRaw<T>(client, query.sql, query.params));
    }
    return results;
  }

  /**
   * Public API for batch execution with instrumentation.
   * Uses native batch if supported, otherwise falls back to:
   * 1. Transaction-wrapped sequential execution (if transactions supported)
   * 2. Sequential execution with warning (no atomicity)
   */
  async _executeBatch<T>(queries: BatchQuery[]): Promise<QueryResult<T>[]> {
    if (queries.length === 0) {
      return [];
    }

    const client = await this.getClient();

    // If driver has native batch support, use it directly
    if (this.supportsBatch) {
      return this.executeBatch<T>(client, queries);
    }

    // If driver supports transactions and we're not already in one, wrap in transaction
    if (this.supportsTransactions && !this.inTransaction) {
      return this._transaction(async (tx) => {
        return this.executeBatch<T>(tx, queries);
      });
    }

    // No batch or transaction support - execute sequentially with warning
    const message =
      `Driver "${this.driverName}" supports neither transactions nor batch. ` +
      "Operations will execute sequentially without atomicity. " +
      "If any operation fails, others may still complete.";
    if (this.instrumentation?.logger) {
      this.instrumentation.logger.warn({
        timestamp: new Date(),
        meta: { message },
      });
    } else {
      console.warn(message);
    }
    return this.executeBatch<T>(client, queries);
  }

  /**
   * Connect to the database with instrumentation.
   */
  async _connect(): Promise<void> {
    const doConnect = async () => {
      await this.getClient();
    };

    if (!this.instrumentation?.tracer) {
      return doConnect();
    }

    return this.instrumentation.tracer.startActiveSpan(
      {
        name: SPAN_CONNECT,
        attributes: this.getBaseAttributes(),
      },
      doConnect
    );
  }

  /**
   * Disconnect from the database with instrumentation.
   */
  async _disconnect(): Promise<void> {
    const doDisconnect = async () => {
      this.isDisconnecting = true;

      if (this.initPromise) {
        try {
          await this.initPromise;
        } catch {
          // Ignore init errors during disconnect
        }
      }

      if (this.client) {
        await this.closeClient(this.client);
      }

      this.client = null;
      this.initPromise = null;
      this.isDisconnecting = false;
      this.inTransaction = false;
    };

    if (!this.instrumentation?.tracer) {
      return doDisconnect();
    }

    return this.instrumentation.tracer.startActiveSpan(
      {
        name: SPAN_DISCONNECT,
        attributes: this.getBaseAttributes(),
      },
      doDisconnect
    );
  }

  async disconnect(): Promise<void> {
    return this._disconnect();
  }
}

/**
 * Type alias for any driver (used when concrete types are not needed)
 */
export type AnyDriver = Driver<unknown, unknown>;

// ============================================================
// TRANSACTION-BOUND DRIVER
// ============================================================

/**
 * A driver wrapper that binds all operations to a specific transaction.
 *
 * This provides proper transaction isolation without prototype cloning.
 * Each TransactionBoundDriver has its own instrumentation context for
 * correct span parenting.
 *
 * @example
 * ```typescript
 * await driver._transaction(async (tx) => {
 *   const txDriver = new TransactionBoundDriver(driver, tx);
 *   await txDriver._execute(sql); // Executes within the transaction
 * });
 * ```
 */
export class TransactionBoundDriver<TClient, TTransaction> extends Driver<
  TClient,
  TTransaction
> {
  private readonly baseDriver: Driver<TClient, TTransaction>;
  private readonly tx: TTransaction;
  readonly adapter: DatabaseAdapter;
  override readonly inTransaction = true;
  override readonly supportsTransactions: boolean;
  override readonly supportsBatch: boolean;

  constructor(baseDriver: Driver<TClient, TTransaction>, tx: TTransaction) {
    super(baseDriver.dialect, baseDriver.driverName);
    this.baseDriver = baseDriver;
    this.tx = tx;
    this.adapter = baseDriver.adapter;
    this.supportsTransactions = baseDriver.supportsTransactions;
    this.supportsBatch = baseDriver.supportsBatch;
    // Copy instrumentation - each tx driver gets its own context for proper span parenting
    this.instrumentation = baseDriver["instrumentation"];
  }

  // Always return the bound transaction
  protected override async getClient(): Promise<TClient | TTransaction> {
    return this.tx;
  }

  // Delegate abstract methods to base driver
  protected override initClient(): Promise<TClient> {
    throw new Error("TransactionBoundDriver does not initialize clients");
  }

  protected override closeClient(): Promise<void> {
    return Promise.resolve(); // No-op
  }

  protected override execute<T>(
    client: TClient | TTransaction,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    return this.baseDriver["execute"](client, sql, params);
  }

  protected override executeRaw<T>(
    client: TClient | TTransaction,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.baseDriver["executeRaw"](client, sql, params);
  }

  protected override transaction<T>(
    client: TClient | TTransaction,
    fn: (tx: TTransaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    // Delegate to base driver for nested transaction / savepoint handling
    return this.baseDriver["transaction"](client, fn, options);
  }

  override async disconnect(): Promise<void> {
    // No-op - base driver owns the connection
  }
}
