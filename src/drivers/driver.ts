/**
 * Driver Interface and Base Implementation
 *
 * Single file containing the Driver interface and LazyDriver base class.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { TransactionError, VibORMErrorCode } from "@errors";
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
import { getNoopTracer } from "@instrumentation/tracer";
import type { Operation } from "@query-engine/types";
import type { RelationType } from "@schema/relation/types";
import type { Sql } from "@sql";
import { normalizeDriverError } from "./error-mapping";
import { SavepointQueue } from "./savepoint-queue";
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
    scalarType: string,
    next: (value: unknown, scalarType: string) => unknown
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
  /**
   * Single-connection drivers (better-sqlite3, in-memory libsql, bun:sqlite)
   * cannot interleave two top-level transactions on their one connection:
   * the second BEGIN either throws or silently joins the first transaction.
   * Set true to queue top-level transactions so they run one at a time.
   */
  protected readonly serializeTransactions: boolean = false;
  private readonly transactionQueue = new SavepointQueue();
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
  protected async withInstrumentation<R>(
    sql: string,
    params: unknown[],
    executor: () => Promise<R>
  ): Promise<R> {
    // Fast path: nothing configured — skip span, timing, and log plumbing.
    // Error normalization is behavior (typed driver errors), so it stays.
    if (!this.instrumentation) {
      try {
        return await executor();
      } catch (error) {
        throw normalizeDriverError(error, {
          driverName: this.driverName,
          model: this.currentContext.model,
          operation: this.currentContext.operation,
          query: sql,
          params,
        });
      }
    }

    const startTime = Date.now();
    const { model, operation } = this.currentContext;

    const runAndLog = async () => {
      try {
        const result = await executor();
        this.logQuery(sql, params, Date.now() - startTime, model, operation);
        return result;
      } catch (error) {
        const normalizedError = normalizeDriverError(error, {
          driverName: this.driverName,
          model,
          operation,
          query: sql,
          params,
        });
        this.logQuery(
          sql,
          params,
          Date.now() - startTime,
          model,
          operation,
          normalizedError
        );
        throw normalizedError;
      }
    };

    // Get tracer (always defined - either real or no-op)
    const tracer = this.instrumentation?.tracer ?? getNoopTracer();

    return tracer.startActiveSpan(
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
   * Convert a typed Sql fragment into a driver-ready batch query.
   * Query-engine planners use this so dialect placeholders stay driver-owned.
   */
  _prepare(query: Sql): BatchQuery {
    return {
      sql: this.buildStatement(query),
      params: query.values,
    };
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
    options?: TransactionOptions,
    onTimeout?: (error: TransactionError) => void
  ): Promise<T> {
    const client = await this.getClient();
    const wasInTransaction = this.inTransaction;
    const timeoutWrappedFn = this.wrapTransactionCallbackFor(
      fn,
      options,
      onTimeout
    );

    const runTransaction = async () => {
      // Don't set inTransaction here - let driver's transaction() see the original value
      // Driver will set it to true after BEGIN, base class resets in finally
      try {
        return await this.transaction(client, timeoutWrappedFn, options);
      } finally {
        this.inTransaction = wasInTransaction;
      }
    };

    // Get tracer (always defined - either real or no-op)
    const tracer = this.instrumentation?.tracer ?? getNoopTracer();

    const execute = () =>
      tracer.startActiveSpan(
        {
          name: SPAN_TRANSACTION,
          attributes: this.getBaseAttributes(),
        },
        runTransaction
      );

    // Queue top-level transactions on single-connection drivers so concurrent
    // callers serialize instead of colliding on the shared connection. Nested
    // calls (wasInTransaction) bypass the queue — queueing them would deadlock
    // against the outer transaction holding the slot.
    if (this.serializeTransactions && !wasInTransaction) {
      return this.transactionQueue.enqueue(execute);
    }
    return execute();
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
      throw new TransactionError(
        `Driver "${this.driverName}" does not support callback transactions.`,
        {
          meta: {
            driver: this.driverName,
            method: "$transaction(callback)",
          },
        }
      );
    }
    let txDriver: TransactionBoundDriver<TClient, TTransaction> | undefined;
    return this._transaction(
      async (tx) => {
        txDriver = new TransactionBoundDriver(this, tx);
        try {
          return await fn(txDriver);
        } finally {
          txDriver.closeTransactionScope();
        }
      },
      options,
      (error) => txDriver?.markTransactionTimedOut(error)
    );
  }

  // ============================================================
  // BATCH EXECUTION
  // ============================================================

  /**
   * Execute multiple prepared queries on the provided client.
   * _executeBatch wraps this in a transaction for transactional drivers.
   * Drivers with native atomic batch support must override this method;
   * overrides that cannot honor `options` must throw instead of ignoring them.
   */
  protected async executeBatch<T>(
    client: TClient | TTransaction,
    queries: BatchQuery[],
    _options?: TransactionOptions
  ): Promise<QueryResult<T>[]> {
    const results: QueryResult<T>[] = [];
    for (const query of queries) {
      results.push(
        await this.withInstrumentation(query.sql, query.params ?? [], () =>
          this.executeRaw<T>(client, query.sql, query.params)
        )
      );
    }
    return results;
  }

  /**
   * Public API for batch execution with instrumentation.
   * Uses native batch if supported, otherwise falls back to transaction-wrapped
   * sequential execution. Drivers without either capability reject instead of
   * silently executing non-atomically.
   */
  async _executeBatch<T>(
    queries: BatchQuery[],
    options?: TransactionOptions
  ): Promise<QueryResult<T>[]> {
    if (queries.length === 0) {
      return [];
    }

    const client = await this.getClient();

    // If driver has native batch support, use it directly.
    // Native batches execute as one driver call, so errors normalize/log once
    // for the whole batch rather than per statement.
    if (this.supportsBatch) {
      const sql = queries.map((query) => query.sql).join("; ");
      const params = queries.map((query) => query.params ?? []);
      return this.withInstrumentation(sql, params, () =>
        this.executeBatch<T>(client, queries, options)
      );
    }

    // If driver supports transactions, wrap in transaction (or use existing one)
    if (this.supportsTransactions) {
      // If already in a transaction, execute directly within it
      if (this.inTransaction) {
        return this.executeBatch<T>(client, queries, options);
      }
      // Otherwise, wrap in a new transaction
      return this._transaction(async (tx) => {
        return this.executeBatch<T>(tx, queries, options);
      }, options);
    }

    throw new TransactionError(
      `Driver "${this.driverName}" supports neither transactions nor atomic batch execution.`,
      {
        meta: {
          driver: this.driverName,
          method: "$transaction([...])",
        },
      }
    );
  }

  protected wrapTransactionCallbackFor<T, TTx>(
    fn: (tx: TTx) => Promise<T>,
    options?: TransactionOptions,
    onTimeout?: (error: TransactionError) => void
  ): (tx: TTx) => Promise<T> {
    const timeout = options?.timeout;
    if (timeout === undefined) {
      return fn;
    }

    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new TransactionError(
        "Transaction timeout must be a positive finite number of milliseconds",
        {
          code: VibORMErrorCode.INVALID_TRANSACTION_INPUT,
          meta: { driver: this.driverName, timeout },
        }
      );
    }

    return (tx) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new TransactionError(
            `Transaction timed out after ${timeout}ms`,
            {
              code: VibORMErrorCode.TRANSACTION_TIMEOUT,
              meta: { driver: this.driverName, timeout },
            }
          );
          onTimeout?.(error);
          reject(error);
        }, timeout);
      });

      return Promise.race([fn(tx), timeoutPromise]).finally(() => {
        if (timer) {
          clearTimeout(timer);
        }
      });
    };
  }

  /**
   * Connect to the database with instrumentation.
   */
  async _connect(): Promise<void> {
    const doConnect = async () => {
      await this.getClient();
    };

    // Get tracer (always defined - either real or no-op)
    const tracer = this.instrumentation?.tracer ?? getNoopTracer();

    return tracer.startActiveSpan(
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

      try {
        if (this.client) {
          await this.closeClient(this.client);
        }
      } finally {
        this.client = null;
        this.initPromise = null;
        this.isDisconnecting = false;
        this.inTransaction = false;
      }
    };

    // Get tracer (always defined - either real or no-op)
    const tracer = this.instrumentation?.tracer ?? getNoopTracer();

    return tracer.startActiveSpan(
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
  private readonly parentTransactionDriver:
    | TransactionBoundDriver<TClient, TTransaction>
    | undefined;
  private readonly tx: TTransaction;
  private readonly savepointQueue = new SavepointQueue();
  private transactionClosed = false;
  private transactionTimeoutError: TransactionError | undefined;
  readonly adapter: DatabaseAdapter;
  override readonly result?: DriverResultParser;
  override inTransaction: boolean;
  override readonly supportsTransactions: boolean;
  override readonly supportsBatch: boolean;

  constructor(baseDriver: Driver<TClient, TTransaction>, tx: TTransaction) {
    super(baseDriver.dialect, baseDriver.driverName);
    this.baseDriver = baseDriver;
    this.parentTransactionDriver =
      baseDriver instanceof TransactionBoundDriver ? baseDriver : undefined;
    this.tx = tx;
    this.adapter = baseDriver.adapter;
    this.result = baseDriver.result;
    this.inTransaction = true;
    this.supportsTransactions = baseDriver.supportsTransactions;
    this.supportsBatch = baseDriver.supportsBatch;
    // Copy instrumentation - each tx driver gets its own context for proper span parenting
    this.instrumentation = baseDriver["instrumentation"];
  }

  // Always return the bound transaction
  protected override async getClient(): Promise<TClient | TTransaction> {
    return this.tx;
  }

  markTransactionTimedOut(error: TransactionError): void {
    this.transactionTimeoutError = error;
    this.transactionClosed = true;
  }

  closeTransactionScope(): void {
    this.transactionClosed = true;
  }

  private assertTransactionOpen(): void {
    this.parentTransactionDriver?.assertTransactionOpen();

    if (this.transactionTimeoutError) {
      throw this.transactionTimeoutError;
    }

    if (this.transactionClosed) {
      throw new TransactionError(
        `Transaction for driver "${this.driverName}" is no longer active.`,
        {
          meta: {
            driver: this.driverName,
            method: "$transaction",
          },
        }
      );
    }
  }

  override async _execute<T = Record<string, unknown>>(
    query: Sql
  ): Promise<QueryResult<T>> {
    this.assertTransactionOpen();
    return super._execute<T>(query);
  }

  override async _executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    this.assertTransactionOpen();
    return super._executeRaw<T>(sql, params);
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

  protected override async transaction<T>(
    _client: TClient | TTransaction,
    fn: (tx: TTransaction) => Promise<T>,
    _options?: TransactionOptions
  ): Promise<T> {
    this.assertTransactionOpen();
    // Queue savepoint operations to serialize concurrent nested transactions.
    // This prevents savepoint stack conflicts when multiple nested transactions
    // are started concurrently (e.g., via Promise.all).
    return this.savepointQueue.enqueue(async () => {
      this.assertTransactionOpen();
      const savepointName = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      // Use the bound transaction for savepoint operations
      await this.baseDriver["executeRaw"](
        this.tx,
        `SAVEPOINT ${savepointName}`
      );

      try {
        const result = await fn(this.tx);
        await this.baseDriver["executeRaw"](
          this.tx,
          `RELEASE SAVEPOINT ${savepointName}`
        );
        return result;
      } catch (error) {
        try {
          await this.baseDriver["executeRaw"](
            this.tx,
            `ROLLBACK TO SAVEPOINT ${savepointName}`
          );
          // Release savepoint after rollback to free resources and prevent accumulation
          await this.baseDriver["executeRaw"](
            this.tx,
            `RELEASE SAVEPOINT ${savepointName}`
          );
        } catch {
          // A deadlock/serialization failure rolls back the whole surrounding
          // transaction (destroying its savepoints, e.g. on MySQL), so this
          // cleanup can fail — never let it mask the original error.
        }
        throw error;
      }
    });
  }

  override async disconnect(): Promise<void> {
    // No-op - base driver owns the connection
  }
}
