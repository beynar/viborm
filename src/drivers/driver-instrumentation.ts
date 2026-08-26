/** Driver instrumentation, diagnostics, and provider result middleware. */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import {
  ConnectionError,
  type DiagnosticDisclosure,
  sanitizeErrorForLogging,
  TransactionError,
  VibORMErrorCode,
} from "@errors";
import {
  type LifecycleUnitKind,
  type ObservationCompletionFactsReader,
  observeDriverLifecycle,
  observeStatement,
} from "@extensions/observation";
import { applyStatementTransforms } from "@extensions/statement";
import type { InstrumentationContext } from "@instrumentation/context";
import { getOfficialInstrumentationChainCapability } from "@instrumentation/extension";
import type {
  InstrumentationExecutionPresentation,
  InstrumentationLifecycleFactsReader,
  InstrumentationLifecycleOutcome,
  StatementInstrumentationCompletionFacts,
} from "@instrumentation/lifecycle-facts";
import { markErrorLogged } from "@instrumentation/logged-errors";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_DRIVER,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_SYSTEM,
  ATTR_VIBORM_CORRELATION_ID,
  SPAN_EXECUTE,
  type VibORMSpanName,
} from "@instrumentation/spans";
import {
  shouldTraceSpan,
  type VibORMSpanOptions,
} from "@instrumentation/tracer";
import type { Operation } from "@query-engine/types";
import type { Sql } from "@sql";
import {
  assertStatementBindParameterCapacity,
  normalizedBindParameterLimit,
} from "./bind-parameter-capacity";
import {
  BATCH_DIAGNOSTIC_PARAMS,
  EMPTY_DIAGNOSTIC_PARAMS,
  findUniqueErrorLogDetails,
  getErrorExecutionContext,
  snapshotDiagnosticParameters,
} from "./driver-diagnostics";
import {
  normalizeDriverConnectionError,
  normalizeDriverError,
} from "./error-mapping";
import {
  getExecutionExtensionChain,
  getExecutionInstrumentation,
  snapshotExecutionContext,
} from "./execution-context";
import { readPreparedStatement } from "./prepared-statement-provenance";
import { SavepointQueue } from "./savepoint-queue";
import type {
  DriverTransactionOptions,
  TransactionOptionSupport,
} from "./shared/transaction-options";
import type {
  BatchQuery,
  Dialect,
  QueryExecutionContext,
  QueryResult,
} from "./types";

const EMPTY_DISCLOSURE: DiagnosticDisclosure = Object.freeze({
  includeParams: false,
  includeSql: false,
});

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
    next: (value: unknown) => unknown
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

interface StatementExecutionPresentation {
  readonly context: QueryExecutionContext;
  readonly diagnosticParams: unknown[];
  readonly errorLogDetails?: readonly ErrorLogDetails[];
  readonly forceErrorContext: boolean;
  readonly sql: string;
  readonly startedAt: number;
}

/** @internal Driver-owned handoff to the trusted official observer only. */
export interface OfficialStatementExecutionGate {
  readonly readFacts: InstrumentationLifecycleFactsReader;
  execute<Result>(
    presentation: Omit<StatementExecutionPresentation, "startedAt">,
    executor: () => Promise<Result>
  ): Promise<Result>;
}

/** @internal Driver-owned handoff to the trusted official observer only. */
export interface OfficialDriverLifecycleExecutionGate {
  readonly readFacts: InstrumentationLifecycleFactsReader;
  execute<Result>(executor: () => Promise<Result>): Promise<Result>;
}

interface DeferredInstrumentationExecution {
  readonly presentation: Promise<
    InstrumentationExecutionPresentation | undefined
  >;
  execute<Result>(
    spanOptions: VibORMSpanOptions | undefined,
    executor: () => Promise<Result>
  ): Promise<Result>;
  settleSkipped(): void;
}

/** One exact child remains gated until the trusted observer enters its span. */
function createDeferredInstrumentationExecution(): DeferredInstrumentationExecution {
  let resolvePresentation:
    | ((presentation: InstrumentationExecutionPresentation | undefined) => void)
    | undefined;
  const presentation = new Promise<
    InstrumentationExecutionPresentation | undefined
  >((resolve) => {
    resolvePresentation = resolve;
  });
  let presentationSettled = false;
  const settlePresentation = (
    value: InstrumentationExecutionPresentation | undefined
  ): void => {
    if (presentationSettled) return;
    presentationSettled = true;
    resolvePresentation?.(value);
  };
  const execute = <Result>(
    spanOptions: VibORMSpanOptions | undefined,
    executor: () => Promise<Result>
  ): Promise<Result> => {
    let resolveApplication:
      | ((value: Result | PromiseLike<Result>) => void)
      | undefined;
    let rejectApplication: ((reason?: unknown) => void) | undefined;
    const application = new Promise<Result>((resolve, reject) => {
      resolveApplication = resolve;
      rejectApplication = reject;
    });
    let started = false;
    const startExecution = (): void => {
      if (started) return;
      started = true;
      let execution: Promise<Result>;
      try {
        execution = executor();
      } catch (failure) {
        rejectApplication?.(failure);
        return;
      }
      execution.then(resolveApplication, rejectApplication);
    };
    settlePresentation(
      Object.freeze({
        ...(spanOptions === undefined ? {} : { spanOptions }),
        startExecution,
      })
    );
    return application;
  };
  return Object.freeze({
    presentation,
    execute,
    settleSkipped: () => settlePresentation(undefined),
  });
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

  /**
   * Whether a native batch can acknowledge its commit before result decoding,
   * so the executor can attribute an exact committed prefix after a later
   * failure. Awaited calls are already sequential and a normalized successful
   * return must be visible to the next awaited call; this stronger capability
   * adds a commit-notification boundary for precise progressive failure
   * attribution before result decoding.
   */
  readonly supportsOrderedCommittedSegments: boolean = false;

  /**
   * Conservative maximum number of values this provider accepts in one bound
   * statement. Query compilation may use this to split an optimization, but it
   * must keep the existing one-row path when the capacity is unknown.
   *
   * When it is unknown, compilation skips the static capacity check and lets the
   * provider own any typed capacity failure for the submitted statement.
   */
  readonly maxBindParametersPerStatement: number | undefined = undefined;

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
   *
   * `options` carries only what this driver itself must act on, and only when
   * its {@link transactionOptionSupport} declaration says it can:
   * `isolationLevel` for `"pre-begin"` drivers (MySQL family, where the level
   * must be set on the connection before BEGIN) and `maxWaitMs` for
   * `"acquisition"` drivers (pooled acquire that can be abandoned safely).
   * Post-BEGIN isolation levels, `timeout`, and queue-bounded `maxWait` are
   * applied by the base class and never reach a driver.
   */
  protected abstract transaction<T>(
    client: TClient | TTransaction,
    fn: (tx: TTransaction) => Promise<T>,
    context?: QueryExecutionContext,
    options?: DriverTransactionOptions
  ): Promise<T>;

  /**
   * This driver's honest answer for every public transaction option. The
   * default refuses all three: a driver that has not declared its contract
   * must not silently appear to honor one.
   *
   * `tests/drivers/transaction-portability.test.ts` pins every advertised
   * driver's declaration, one cell per driver per option.
   */
  protected transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "unsupported",
      isolationLevelReason:
        "this driver has not declared an isolation-level contract",
      timeout: false,
      timeoutReason: "this driver has not declared a timeout contract",
      maxWait: "unsupported",
      maxWaitReason: "this driver has not declared a maxWait contract",
    };
  }

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

  /** Apply only the statement handlers attached through trusted provenance. */
  protected applyTrustedStatementTransforms(
    query: Sql,
    context: QueryExecutionContext | undefined,
    fallbackOperation: string
  ): Sql {
    const extensionChain =
      getExecutionExtensionChain(context) ??
      getExecutionExtensionChain(this.boundContext);
    const transforms = extensionChain?.statement;
    if (transforms === undefined || transforms.length === 0) return query;

    const executionContext = this.resolveExecutionContext(
      context,
      fallbackOperation
    );
    const transformed = applyStatementTransforms(
      query,
      executionContext.model,
      executionContext.operation ?? fallbackOperation,
      transforms
    );
    assertStatementBindParameterCapacity(
      transformed,
      this.driverName,
      normalizedBindParameterLimit(this.maxBindParametersPerStatement),
      "operation"
    );
    return transformed;
  }

  /** Whether trusted provenance carries at least one protected observer. */
  protected hasTrustedObservers(
    context: QueryExecutionContext | undefined
  ): boolean {
    const extensionChain =
      getExecutionExtensionChain(context) ??
      getExecutionExtensionChain(this.boundContext);
    return (extensionChain?.observe.length ?? 0) > 0;
  }

  /** Observe one physical statement without exposing SQL or provider state. */
  protected observeTrustedStatement<Result>(
    context: QueryExecutionContext,
    child: (
      gate: OfficialStatementExecutionGate | undefined
    ) => Promise<Result>,
    readCompletionFacts?: ObservationCompletionFactsReader
  ): Promise<Result> {
    const observers = getExecutionExtensionChain(context)?.observe;
    if (observers === undefined || observers.length === 0)
      return child(undefined);
    const gate = this.createOfficialStatementExecutionGate(context);
    return observeStatement(
      observers,
      context.operation,
      context.model,
      () => child(gate),
      readCompletionFacts,
      gate?.readFacts
    );
  }

  /** Observe one driver-owned lifecycle boundary without exposing its state. */
  protected observeTrustedDriverLifecycle<Result>(
    kind: Extract<
      LifecycleUnitKind,
      "connection" | "savepoint" | "transaction"
    >,
    context: QueryExecutionContext,
    spanName: VibORMSpanName,
    child: (
      gate: OfficialDriverLifecycleExecutionGate | undefined
    ) => Promise<Result>,
    readCompletionFacts?: ObservationCompletionFactsReader
  ): Promise<Result> {
    const observers = getExecutionExtensionChain(context)?.observe;
    if (observers === undefined || observers.length === 0) {
      return child(undefined);
    }
    const official = getOfficialInstrumentationChainCapability(
      getExecutionExtensionChain(context)
    );
    const gate =
      official?.observesLifecycle === true &&
      this.isTracingEnabled(context, spanName)
        ? this.createOfficialDriverLifecycleExecutionGate(context, spanName)
        : undefined;
    return observeDriverLifecycle(
      kind,
      observers,
      context.operation,
      () => child(gate),
      readCompletionFacts,
      gate?.readFacts
    );
  }

  /** Apply a deferred transform to an internally prepared typed statement. */
  protected materializeTrustedBatchQuery(
    query: BatchQuery,
    context: QueryExecutionContext
  ): BatchQuery {
    const statement = readPreparedStatement(query);
    if (statement === undefined) return query;
    const transformed = this.applyTrustedStatementTransforms(
      statement,
      context,
      "executeBatch"
    );
    return {
      sql: this.buildStatement(transformed),
      params: transformed.values,
      ...(query.context === undefined ? {} : { context: query.context }),
    };
  }

  /** Form one protected statement onion around one native typed batch call. */
  protected observeTrustedBatchStatements<Result>(
    queries: readonly BatchQuery[],
    context: QueryExecutionContext,
    child: (
      queries: readonly BatchQuery[],
      gate: OfficialStatementExecutionGate | undefined
    ) => Promise<Result>,
    readCompletionFacts?: ObservationCompletionFactsReader
  ): Promise<Result> {
    const observers = getExecutionExtensionChain(context)?.observe;
    if (observers === undefined || observers.length === 0) {
      return child(queries, undefined);
    }
    const gate = this.createOfficialStatementExecutionGate(context);
    let factsAssigned = false;
    const materializedQueries: BatchQuery[] = [];
    const startAt = (index: number): Promise<Result> => {
      for (let current = index; current < queries.length; current += 1) {
        const query = queries[current];
        if (query === undefined) continue;
        const statementContext = query.context ?? context;
        const readFacts = factsAssigned ? undefined : gate?.readFacts;
        factsAssigned = true;
        return observeStatement(
          observers,
          statementContext.operation,
          statementContext.model,
          () => {
            materializedQueries.push(
              this.materializeTrustedBatchQuery(query, statementContext)
            );
            return startAt(current + 1);
          },
          readCompletionFacts,
          readFacts
        );
      }
      return child(materializedQueries, gate);
    };
    return startAt(0);
  }

  /** Build one private provider-dispatch gate for the official statement rail. */
  private createOfficialStatementExecutionGate(
    context: QueryExecutionContext
  ): OfficialStatementExecutionGate | undefined {
    const official = getOfficialInstrumentationChainCapability(
      getExecutionExtensionChain(context)
    );
    if (official?.observesLifecycle !== true) return undefined;
    const logger = official.context.logger;
    if (
      !this.isTracingEnabled(context) &&
      logger?.isLevelEnabled("query") !== true &&
      logger?.isLevelEnabled("error") !== true
    ) {
      return undefined;
    }

    const deferred = createDeferredInstrumentationExecution();
    let published: StatementExecutionPresentation | undefined;
    const facts = Object.freeze({
      kind: "statement" as const,
      presentation: deferred.presentation,
      complete: (
        outcome: InstrumentationLifecycleOutcome
      ): StatementInstrumentationCompletionFacts | undefined => {
        if (published === undefined) {
          deferred.settleSkipped();
          return undefined;
        }
        const logEvent = this.createStatementLogEvent(published, outcome);
        return logEvent === undefined ? undefined : Object.freeze({ logEvent });
      },
    });
    const execute = <Result>(
      values: Omit<StatementExecutionPresentation, "startedAt">,
      executor: () => Promise<Result>
    ): Promise<Result> => {
      published = Object.freeze({ ...values, startedAt: Date.now() });
      const spanOptions = this.createStatementSpanOptions(
        values.sql,
        values.diagnosticParams,
        values.context
      );
      return deferred.execute(spanOptions, () =>
        this.executeNormalizedStatement(
          values.sql,
          values.diagnosticParams,
          values.context,
          executor,
          values.forceErrorContext
        )
      );
    };
    return Object.freeze({ readFacts: () => facts, execute });
  }

  /** Build one late span gate without moving the owning lifecycle across its queue. */
  private createOfficialDriverLifecycleExecutionGate(
    context: QueryExecutionContext,
    spanName: VibORMSpanName
  ): OfficialDriverLifecycleExecutionGate {
    const deferred = createDeferredInstrumentationExecution();
    const facts = Object.freeze({
      kind: "driver-lifecycle" as const,
      presentation: deferred.presentation,
      complete: () => {
        deferred.settleSkipped();
        return undefined;
      },
    });
    return Object.freeze({
      readFacts: () => facts,
      execute: <Result>(executor: () => Promise<Result>) =>
        deferred.execute(
          {
            name: spanName,
            attributes: this.getContextAttributes(context),
          },
          executor
        ),
    });
  }

  private createStatementSpanOptions(
    sql: string,
    params: unknown[],
    context: QueryExecutionContext
  ): VibORMSpanOptions | undefined {
    if (!this.isTracingEnabled(context)) return undefined;
    const disclosure = this.getTracingDisclosure(context);
    const spanSql =
      disclosure.includeSql || disclosure.includeParams
        ? {
            ...(disclosure.includeSql ? { query: sql } : {}),
            ...(disclosure.includeParams ? { params } : {}),
          }
        : undefined;
    return {
      name: SPAN_EXECUTE,
      attributes: this.getContextAttributes(context),
      ...(spanSql === undefined ? {} : { sql: spanSql }),
    };
  }

  private createStatementLogEvent(
    presentation: StatementExecutionPresentation,
    outcome: InstrumentationLifecycleOutcome
  ): StatementInstrumentationCompletionFacts["logEvent"] | undefined {
    const failure =
      outcome.status === "failure" && outcome.failure instanceof Error
        ? outcome.failure
        : undefined;
    if (outcome.status === "failure" && failure === undefined) return undefined;
    const statementLogDetails =
      failure === undefined || presentation.forceErrorContext
        ? undefined
        : findUniqueErrorLogDetails(failure, presentation.errorLogDetails);
    const context =
      statementLogDetails?.context ??
      (failure === undefined || presentation.forceErrorContext
        ? presentation.context
        : getErrorExecutionContext(failure, presentation.context));
    const level = failure === undefined ? "query" : "error";
    if (this.getLogger(context)?.isLevelEnabled(level) !== true) {
      return undefined;
    }
    if (failure !== undefined) markErrorLogged(failure);
    const disclosure = this.getLoggingDisclosure(context);
    const sql = statementLogDetails?.sql ?? presentation.sql;
    const params = statementLogDetails?.params ?? presentation.diagnosticParams;
    return Object.freeze({
      level,
      event: Object.freeze({
        timestamp: new Date(),
        duration: Date.now() - presentation.startedAt,
        model: context.model,
        operation: context.operation,
        correlationId: context.correlationId,
        sql: disclosure.includeSql ? sql : undefined,
        params: disclosure.includeParams ? params : undefined,
        error:
          failure === undefined
            ? undefined
            : sanitizeErrorForLogging(failure, disclosure),
      }),
    });
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
      params,
      diagnostics: this.getErrorDisclosure(context),
      forceContext: true,
    });
  }

  protected getBatchDiagnosticParameters(query: BatchQuery): unknown[] {
    try {
      const snapshot = Reflect.get(query, BATCH_DIAGNOSTIC_PARAMS);
      return Array.isArray(snapshot)
        ? snapshot
        : this.getDiagnosticParameters(query.params ?? [], query.context);
    } catch {
      return this.getDiagnosticParameters(query.params ?? [], query.context);
    }
  }

  protected getDiagnosticParameters(
    params: readonly unknown[],
    context?: QueryExecutionContext,
    relatedContext?: QueryExecutionContext
  ): unknown[] {
    if (
      this.canDiscloseParameters(context) ||
      (relatedContext !== undefined &&
        relatedContext !== context &&
        this.canDiscloseParameters(relatedContext))
    ) {
      return snapshotDiagnosticParameters(params);
    }
    return EMPTY_DIAGNOSTIC_PARAMS;
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

  /** Normalize one provider statement failure at its existing trust boundary. */
  private normalizeStatementFailure(
    error: unknown,
    sql: string,
    params: unknown[],
    context: QueryExecutionContext,
    forceErrorContext: boolean
  ): Error {
    return normalizeDriverError(error, {
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

  protected async executeNormalizedStatement<R>(
    sql: string,
    params: unknown[],
    context: QueryExecutionContext,
    executor: () => Promise<R>,
    forceErrorContext: boolean
  ): Promise<R> {
    try {
      return await executor();
    } catch (error) {
      throw this.normalizeStatementFailure(
        error,
        sql,
        params,
        context,
        forceErrorContext
      );
    }
  }

  protected resolveExecutionContext(
    context: QueryExecutionContext | undefined,
    fallbackOperation: string
  ): QueryExecutionContext {
    return snapshotExecutionContext(
      context,
      this.boundContext,
      fallbackOperation
    );
  }

  protected getInstrumentation(
    context?: QueryExecutionContext
  ): InstrumentationContext | undefined {
    return getExecutionInstrumentation(context);
  }

  protected canDiscloseParameters(context?: QueryExecutionContext): boolean {
    const instrumentation = this.getInstrumentation(context);
    if (!instrumentation) return false;
    if (instrumentation.config.diagnostics.includeParams) return true;

    const logging = instrumentation.config.logging;
    if (
      logging &&
      logging !== true &&
      logging.includeParams === true &&
      (instrumentation.logger?.isLevelEnabled("query") === true ||
        instrumentation.logger?.isLevelEnabled("error") === true)
    ) {
      return true;
    }

    const tracing = instrumentation.config.tracing;
    return (
      tracing !== undefined &&
      tracing !== true &&
      tracing.includeParams === true &&
      shouldTraceSpan(instrumentation.tracer, SPAN_EXECUTE)
    );
  }

  protected isTracingEnabled(
    context?: QueryExecutionContext,
    spanName: VibORMSpanName = SPAN_EXECUTE
  ): boolean {
    const instrumentation = this.getInstrumentation(context);
    const isConfigured =
      instrumentation?.config.tracing !== undefined ||
      instrumentation?.tracer.isEnabled() === true;
    return (
      isConfigured &&
      instrumentation !== undefined &&
      shouldTraceSpan(instrumentation.tracer, spanName)
    );
  }

  protected getErrorDisclosure(
    context?: QueryExecutionContext
  ): DiagnosticDisclosure {
    return (
      this.getInstrumentation(context)?.config.diagnostics ?? EMPTY_DISCLOSURE
    );
  }

  protected getLoggingDisclosure(
    context?: QueryExecutionContext
  ): DiagnosticDisclosure {
    const logging = this.getInstrumentation(context)?.config.logging;
    return logging && logging !== true ? logging : EMPTY_DISCLOSURE;
  }

  protected getTracingDisclosure(
    context?: QueryExecutionContext
  ): DiagnosticDisclosure {
    const tracing = this.getInstrumentation(context)?.config.tracing;
    return tracing && tracing !== true ? tracing : EMPTY_DISCLOSURE;
  }

  protected getLogger(
    context?: QueryExecutionContext
  ): InstrumentationContext["logger"] {
    return this.getInstrumentation(context)?.logger;
  }
}
