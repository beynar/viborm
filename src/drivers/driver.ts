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
  SPAN_EXECUTE,
  SPAN_TRANSACTION,
} from "@instrumentation/spans";
import type { Operation } from "@query-engine/types";
import type { RelationType } from "@schema/relation/types";
import type { Sql } from "@sql";
import type { Dialect, QueryResult, TransactionOptions } from "./types";

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
  supportsTransactions?: boolean;
  readonly dialect: Dialect;
  readonly driverName: string;
  abstract readonly adapter: DatabaseAdapter;
  readonly result?: DriverResultParser;
  protected client: TClient | null = null;
  protected transactions: TTransaction[] = [];
  protected inTransaction = false;
  private initPromise: Promise<TClient> | null = null;
  private isDisconnecting = false;
  protected instrumentation?: InstrumentationContext;
  protected currentContext: QueryExecutionContext = {};

  // ============================================================
  // ABSTRACT METHODS - Concrete drivers implement these
  // ============================================================

  protected abstract initClient(): Promise<TClient>;
  protected abstract closeClient(client: TClient): Promise<void>;
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
    const transaction = this.transactions.at(-1);
    if (transaction) {
      return transaction;
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

  async _executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const client = await this.getClient();
    return this.withInstrumentation(sql, params ?? [], () =>
      this.executeRaw<T>(client, sql, params)
    );
  }

  async _transaction<T>(
    fn: () => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const client = await this.getClient();

    const runTransaction = async () => {
      const result = await this.transaction(
        client,
        (tx) => {
          this.inTransaction = true;
          this.transactions.push(tx);
          return fn();
        },
        options
      );
      this.transactions.pop();
      this.inTransaction = !!this.transactions.length;
      return result;
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

  async disconnect(): Promise<void> {
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
    this.transactions = [];
  }
}

/**
 * Type alias for any driver (used when concrete types are not needed)
 */
export type AnyDriver = Driver<unknown, unknown>;
