/** Driver instrumentation, diagnostics, and provider result middleware. */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import {
  ConnectionError,
  type DiagnosticDisclosure,
  resolveDiagnosticDisclosure,
  sanitizeDiagnosticParameters,
  sanitizeErrorForLogging,
  TransactionError,
  VibORMErrorCode,
} from "@errors";
import type { InstrumentationContext } from "@instrumentation/context";
import { ignoreObserverFailure } from "@instrumentation/ignore-observer-failure";
import { runWithTracer } from "@instrumentation/run-with-tracer";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_DRIVER,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_SYSTEM,
  ATTR_VIBORM_CORRELATION_ID,
  SPAN_EXECUTE,
} from "@instrumentation/spans";
import { getNoopTracer } from "@instrumentation/tracer";
import type { Operation } from "@query-engine/types";
import type { RelationType } from "@schema/relation/types";
import type { Sql } from "@sql";
import {
  BATCH_DIAGNOSTIC_PARAMS,
  findUniqueErrorLogDetails,
  getErrorExecutionContext,
  snapshotDiagnosticParameters,
} from "./driver-diagnostics";
import {
  normalizeDriverConnectionError,
  normalizeDriverError,
} from "./error-mapping";
import {
  getExecutionInstrumentation,
  snapshotExecutionContext,
} from "./execution-context";
import { SavepointQueue } from "./savepoint-queue";
import type {
  BatchQuery,
  Dialect,
  QueryExecutionContext,
  QueryResult,
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

export type { QueryExecutionContext } from "./types";

export interface ErrorLogDetails {
  readonly context: QueryExecutionContext;
  readonly params: unknown[];
  readonly sql: string;
}

export interface NestedTransactionObservation {
  failure?: Error;
  isRejectionObserved: boolean;
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
export abstract class DriverInstrumentationBase<TClient, TTransaction> {
  connect?(): Promise<void>;

  /**
   * Whether this driver supports transactions (BEGIN/COMMIT/ROLLBACK).
   * Default: true for most drivers, false for batch-only clients such as D1
   * bindings and Neon HTTP.
   */
  readonly supportsTransactions: boolean = true;

  /**
   * Whether this driver supports native batch execution.
   * Batch execution allows multiple independent queries to be executed atomically.
   * Default: false. Override in drivers with a documented atomic batch API,
   * such as D1 bindings and Neon HTTP.
   */
  readonly supportsBatch: boolean = false;

  readonly dialect: Dialect;
  readonly driverName: string;
  abstract readonly adapter: DatabaseAdapter;
  readonly result?: DriverResultParser;
  protected client: TClient | TTransaction | null = null;
  /** Immutable per-instance marker; only TransactionBoundDriver is true. */
  protected readonly inTransaction: boolean = false;
  /**
   * Single-connection drivers (better-sqlite3, in-memory libsql, bun:sqlite)
   * cannot interleave two top-level transactions on their one connection:
   * the second BEGIN either throws or silently joins the first transaction.
   * Set true to queue top-level transactions so they run one at a time.
   */
  protected readonly serializeTransactions: boolean = false;
  protected readonly connectionQueue = new SavepointQueue();
  protected initPromise: Promise<TClient> | null = null;
  protected isDisconnecting = false;
  protected isConnectionTransactionActive = false;
  protected transactionPoisonError: Error | undefined;
  private readonly boundContext: Readonly<QueryExecutionContext>;
  protected instrumentation?: InstrumentationContext;

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
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>>;

  /**
   * Execute raw SQL. Receives client, SQL string, and optional params.
   */
  protected abstract executeRaw<T>(
    client: TClient | TTransaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>>;

  /**
   * Run a transaction with the client.
   */
  protected abstract transaction<T>(
    client: TClient | TTransaction,
    fn: (tx: TTransaction) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T>;

  constructor(
    dialect: Dialect,
    driverName: string,
    boundContext: QueryExecutionContext = {}
  ) {
    this.dialect = dialect;
    this.driverName = driverName;
    this.boundContext = snapshotExecutionContext(boundContext);
  }

  /**
   * Set instrumentation context
   */
  setInstrumentation(ctx: InstrumentationContext | undefined): void {
    this.instrumentation = ctx;
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
  getContextAttributes(
    context: QueryExecutionContext = this.boundContext
  ): Record<string, string | undefined> {
    const { model, operation, correlationId } = context;
    const attrs: Record<string, string | undefined> = this.getBaseAttributes();
    if (model) attrs[ATTR_DB_COLLECTION] = model;
    if (operation) attrs[ATTR_DB_OPERATION_NAME] = operation;
    if (correlationId) attrs[ATTR_VIBORM_CORRELATION_ID] = correlationId;
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

  protected normalizeExecutionError(
    error: unknown,
    sql: string,
    params: unknown[],
    context: QueryExecutionContext
  ): Error {
    return normalizeDriverError(error, {
      driverName: this.driverName,
      model: context.model,
      operation: context.operation,
      correlationId: context.correlationId,
      query: sql,
      params: snapshotDiagnosticParameters(params),
      diagnostics: this.getErrorDisclosure(context),
      forceContext: true,
    });
  }

  protected getBatchDiagnosticParameters(query: BatchQuery): unknown[] {
    try {
      const snapshot = Reflect.get(query, BATCH_DIAGNOSTIC_PARAMS);
      return Array.isArray(snapshot)
        ? snapshot
        : snapshotDiagnosticParameters(query.params ?? []);
    } catch {
      return snapshotDiagnosticParameters(query.params ?? []);
    }
  }

  /**
   * Log a query execution (success)
   */
  protected logQuery(
    sql: string,
    params: unknown[],
    duration: number,
    context: QueryExecutionContext,
    error?: unknown
  ): void {
    const logger = this.getLogger(context);
    if (!logger) return;

    const isError = error instanceof Error;

    if (isError) {
      try {
        Object.defineProperty(error, "logged", {
          configurable: true,
          value: true,
        });
      } catch {
        // A frozen error may be logged twice by the outer executor, but
        // instrumentation must not replace the database failure.
      }
    }
    const disclosure = this.getLoggingDisclosure(context);
    const sanitizedParams = disclosure.includeParams
      ? sanitizeDiagnosticParameters(params, disclosure)
      : undefined;
    try {
      ignoreObserverFailure(
        logger[error ? "error" : "query"]({
          timestamp: new Date(),
          duration,
          model: context.model,
          operation: context.operation,
          correlationId: context.correlationId,
          sql: disclosure.includeSql ? sql : undefined,
          params: Array.isArray(sanitizedParams) ? sanitizedParams : undefined,
          error: isError
            ? sanitizeErrorForLogging(error, disclosure)
            : undefined,
        })
      );
    } catch {
      // Instrumentation is observational and cannot alter query behavior.
    }
  }

  /**
   * Get or initialize the client.
   */
  protected async getClient(
    context: QueryExecutionContext = {}
  ): Promise<TClient | TTransaction> {
    if (this.transactionPoisonError) {
      throw new TransactionError(
        `Driver "${this.driverName}" is unavailable after transaction cleanup failed.`,
        {
          cause: this.transactionPoisonError,
          meta: {
            driver: this.driverName,
            model: context.model,
            operation: context.operation,
            correlationId: context.correlationId,
          },
        }
      );
    }
    if (this.isDisconnecting) {
      throw new ConnectionError("Database connection is closing", {
        code: VibORMErrorCode.CONNECTION_CLOSED,
        diagnostics: this.getErrorDisclosure(context),
        meta: {
          driver: this.driverName,
          model: context.model,
          operation: context.operation,
          correlationId: context.correlationId,
        },
      });
    }

    if (this.client) return this.client;

    if (!this.initPromise) {
      this.initPromise = Promise.resolve()
        .then(() => this.initClient())
        .then((client) => {
          this.client = client;
          return client;
        });
    }

    try {
      return await this.initPromise;
    } catch (error) {
      throw normalizeDriverConnectionError(error, {
        driverName: this.driverName,
        model: context.model,
        operation: context.operation,
        correlationId: context.correlationId,
        diagnostics: this.getErrorDisclosure(context),
      });
    }
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
    context: QueryExecutionContext,
    executor: () => Promise<R>,
    forceErrorContext = true,
    errorLogDetails?: readonly ErrorLogDetails[]
  ): Promise<R> {
    // Fast path: nothing configured — skip span, timing, and log plumbing.
    // Error normalization is behavior (typed driver errors), so it stays.
    if (!this.getInstrumentation(context)) {
      try {
        return await executor();
      } catch (error) {
        throw normalizeDriverError(error, {
          driverName: this.driverName,
          model: context.model,
          operation: context.operation,
          correlationId: context.correlationId,
          query: sql,
          params,
          diagnostics: this.getErrorDisclosure(context),
          forceContext: forceErrorContext,
        });
      }
    }

    const startTime = Date.now();
    const runAndLog = async () => {
      try {
        const result = await executor();
        this.logQuery(sql, params, Date.now() - startTime, context);
        return result;
      } catch (error) {
        const normalizedError = normalizeDriverError(error, {
          driverName: this.driverName,
          model: context.model,
          operation: context.operation,
          correlationId: context.correlationId,
          query: sql,
          params,
          diagnostics: this.getErrorDisclosure(context),
          forceContext: forceErrorContext,
        });
        const statementLogDetails = forceErrorContext
          ? undefined
          : findUniqueErrorLogDetails(normalizedError, errorLogDetails);
        const logContext =
          statementLogDetails?.context ??
          (forceErrorContext
            ? context
            : getErrorExecutionContext(normalizedError, context));
        this.logQuery(
          statementLogDetails?.sql ?? sql,
          statementLogDetails?.params ?? params,
          Date.now() - startTime,
          logContext,
          normalizedError
        );
        throw normalizedError;
      }
    };

    // Get tracer (always defined - either real or no-op)
    const tracer = this.getTracer(context);
    const tracingDisclosure = this.getTracingDisclosure(context);
    const sanitizedSpanParams = tracingDisclosure.includeParams
      ? sanitizeDiagnosticParameters(params, tracingDisclosure)
      : undefined;
    const spanSql =
      tracingDisclosure.includeSql || tracingDisclosure.includeParams
        ? {
            ...(tracingDisclosure.includeSql ? { query: sql } : {}),
            ...(Array.isArray(sanitizedSpanParams)
              ? { params: sanitizedSpanParams }
              : {}),
          }
        : undefined;

    return runWithTracer(
      tracer,
      {
        name: SPAN_EXECUTE,
        attributes: this.getContextAttributes(context),
        ...(spanSql ? { sql: spanSql } : {}),
      },
      runAndLog
    );
  }

  protected resolveExecutionContext(
    context: QueryExecutionContext | undefined,
    fallbackOperation: string
  ): QueryExecutionContext {
    return snapshotExecutionContext(
      context,
      this.boundContext,
      fallbackOperation,
      this.instrumentation
    );
  }

  protected getInstrumentation(
    context?: QueryExecutionContext
  ): InstrumentationContext | undefined {
    return getExecutionInstrumentation(context) ?? this.instrumentation;
  }

  protected getErrorDisclosure(
    context?: QueryExecutionContext
  ): DiagnosticDisclosure {
    try {
      return resolveDiagnosticDisclosure(
        this.getInstrumentation(context)?.config.diagnostics
      );
    } catch {
      return resolveDiagnosticDisclosure();
    }
  }

  protected getLoggingDisclosure(
    context?: QueryExecutionContext
  ): DiagnosticDisclosure {
    try {
      const logging = this.getInstrumentation(context)?.config.logging;
      return resolveDiagnosticDisclosure(
        logging && logging !== true ? logging : undefined
      );
    } catch {
      return resolveDiagnosticDisclosure();
    }
  }

  protected getTracingDisclosure(
    context?: QueryExecutionContext
  ): DiagnosticDisclosure {
    try {
      const tracing = this.getInstrumentation(context)?.config.tracing;
      return resolveDiagnosticDisclosure(
        tracing && tracing !== true ? tracing : undefined
      );
    } catch {
      return resolveDiagnosticDisclosure();
    }
  }

  protected getLogger(
    context?: QueryExecutionContext
  ): InstrumentationContext["logger"] {
    try {
      return this.getInstrumentation(context)?.logger;
    } catch {
      return undefined;
    }
  }

  protected getTracer(
    context?: QueryExecutionContext
  ): InstrumentationContext["tracer"] {
    try {
      return this.getInstrumentation(context)?.tracer ?? getNoopTracer();
    } catch {
      return getNoopTracer();
    }
  }
}
