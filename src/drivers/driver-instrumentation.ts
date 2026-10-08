/** Driver instrumentation, diagnostics, and provider result middleware. */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import {
  ConnectionError,
  type DiagnosticDisclosure,
  TransactionError,
  VibORMErrorCode,
} from "@errors";
import {
  getOfficialInstrumentationChainCapability,
  type LifecycleUnitKind,
  type ObservationCompletionFactsReader,
  observeDriverLifecycle,
  observeStatement,
} from "@extensions/observation";
import type {
  LifecycleBoundary,
  LifecycleDispatch,
  LifecycleFacts,
  StatementDispatch,
  StatementExecution,
  StatementFacts,
} from "@extensions/official-facts";
import { applyStatementTransforms } from "@extensions/statement";
import type { Operation } from "@query-engine/types";
import type { Sql } from "@sql";
import { markErrorLogged } from "../errors/logged-errors";
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
  getExecutionCallsite,
  getExecutionExtensionChain,
  snapshotExecutionContext,
} from "./execution-context";
import { readPreparedStatement } from "./prepared-statement-provenance";
import { snapshotProviderParameters } from "./provider-parameter-snapshot";
import { SavepointQueue } from "./savepoint-queue";
import {
  defineImmutableDriverFact,
  type MigrationNamespaceAttestation,
} from "./shared/driver-options";
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

export interface NestedTransactionObservation {
  failure?: Error;
  isRejectionObserved: boolean;
}

/**
 * @internal One provider statement dispatch. Without official observation it
 * runs the executor in place; the official gate first publishes the dispatch to
 * the trusted observer and starts the executor inside its span.
 */
export interface OfficialStatementExecutionGate {
  execute<Result>(
    execution: StatementExecution,
    executor: () => Promise<Result>
  ): Promise<Result>;
}

/** @internal One driver lifecycle dispatch, gated the same way. */
export interface OfficialDriverLifecycleExecutionGate {
  execute<Result>(executor: () => Promise<Result>): Promise<Result>;
}

/** Statement dispatch when no official observer wants it. */
export const ungatedStatementExecution: OfficialStatementExecutionGate =
  Object.freeze({
    execute: <Result>(
      _execution: StatementExecution,
      executor: () => Promise<Result>
    ) => executor(),
  });

/** Lifecycle dispatch when no official observer wants it. */
export const ungatedLifecycleExecution: OfficialDriverLifecycleExecutionGate =
  Object.freeze({
    execute: <Result>(executor: () => Promise<Result>) => executor(),
  });

/** A gate plus the private facts only the trusted observer reads. */
type TrustedGate<Gate, Facts> = Gate & { readonly readFacts: () => Facts };

interface DeferredDispatch<Dispatch> {
  readonly dispatch: Promise<Dispatch | undefined>;
  execute<Result>(
    publish: (start: () => void) => Dispatch,
    executor: () => Promise<Result>
  ): Promise<Result>;
  settleSkipped(): void;
}

/** One exact child remains gated until the trusted observer enters its span. */
function createDeferredDispatch<Dispatch>(): DeferredDispatch<Dispatch> {
  let resolveDispatch: ((dispatch: Dispatch | undefined) => void) | undefined;
  const dispatch = new Promise<Dispatch | undefined>((resolve) => {
    resolveDispatch = resolve;
  });
  let dispatchSettled = false;
  const settleDispatch = (value: Dispatch | undefined): void => {
    if (dispatchSettled) return;
    dispatchSettled = true;
    resolveDispatch?.(value);
  };
  const execute = <Result>(
    publish: (start: () => void) => Dispatch,
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
    const start = (): void => {
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
    settleDispatch(publish(start));
    return application;
  };
  return Object.freeze({
    dispatch,
    execute,
    settleSkipped: () => settleDispatch(undefined),
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

  /**
   * The SQL family this driver speaks. It is a CACHE IDENTITY fact and not only
   * a rendering switch: `bindOfficialCacheChain` derives the official cache
   * scope from this value together with `adapter.namespace`, and a PostgreSQL
   * schema `alpha` and a MySQL database `alpha` spell that qualifier the same
   * way — so the dialect is the only thing separating those two scopes. The
   * adapter reference and the namespace on it are already installed
   * non-writable and non-configurable; installing this one the same way closes
   * the last member of that tuple, and with it the window between constructing
   * a driver and binding its scope in which a relabelled driver would address
   * another store's entries. Client construction's PostgreSQL-target admission
   * reads it once at `create()` too, so an immutable value is also what keeps
   * that refusal from being stepped around after it passed.
   */
  declare readonly dialect: Dialect;
  readonly driverName: string;
  abstract readonly adapter: DatabaseAdapter;
  /**
   * This driver's transport assertion, or `undefined` for every driver that
   * makes none. It is never a target and never derived: only a constructor
   * that was handed the exact literal has it, so a URL, a provider class, a
   * server version, or a resolved namespace cannot manufacture one. Migration
   * admission is its one consumer.
   */
  declare readonly migrationNamespaceAttestation:
    | MigrationNamespaceAttestation
    | undefined;
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
  /**
   * A transport whose close rejected.
   *
   * It remains reachable only so a later public disconnect can retry cleanup.
   * A close attempt may make a provider transport unusable before it rejects
   * (MySQL2 closes pool admission first), so this handle must never return to
   * query or connection work.
   */
  protected closeRetryClient: TClient | TTransaction | null = null;
  protected isDisconnecting = false;
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
    boundContext: QueryExecutionContext = {},
    migrationNamespaceAttestation?: MigrationNamespaceAttestation
  ) {
    defineImmutableDriverFact(this, "dialect", dialect);
    this.driverName = driverName;
    this.boundContext = snapshotExecutionContext(boundContext);
    defineImmutableDriverFact(
      this,
      "migrationNamespaceAttestation",
      migrationNamespaceAttestation
    );
  }

  /** Materialize one trusted typed statement and enforce its final bind budget. */
  protected applyTrustedStatementTransforms(
    query: Sql,
    context: QueryExecutionContext | undefined,
    fallbackOperation: string
  ): Sql {
    const extensionChain =
      getExecutionExtensionChain(context) ??
      getExecutionExtensionChain(this.boundContext);
    const transforms = extensionChain?.statement;
    let transformed = query;
    if (transforms !== undefined && transforms.length > 0) {
      const executionContext = this.resolveExecutionContext(
        context,
        fallbackOperation
      );
      // Storage attestations are protected core statements, not user SQL.
      if (executionContext.model !== "$schema") {
        transformed = applyStatementTransforms(
          query,
          executionContext.model,
          executionContext.operation ?? fallbackOperation,
          transforms
        );
      }
    }
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
    boundary: LifecycleBoundary,
    child: (
      gate: OfficialDriverLifecycleExecutionGate | undefined
    ) => Promise<Result>,
    readCompletionFacts?: ObservationCompletionFactsReader
  ): Promise<Result> {
    const observers = getExecutionExtensionChain(context)?.observe;
    if (observers === undefined || observers.length === 0) {
      return child(undefined);
    }
    const official = readOfficialCapability(context);
    const gate =
      official?.observesLifecycle === true && official.wants(boundary)
        ? this.createOfficialDriverLifecycleExecutionGate(context, boundary)
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
      params: snapshotProviderParameters(transformed.values, context),
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
  ): TrustedGate<OfficialStatementExecutionGate, StatementFacts> | undefined {
    const official = readOfficialCapability(context);
    if (official?.observesLifecycle !== true) return undefined;
    if (
      !(
        official.wants("statement") ||
        official.wants("query-log") ||
        official.wants("error-log")
      )
    ) {
      return undefined;
    }

    const deferred = createDeferredDispatch<StatementDispatch>();
    let published: StatementDispatch | undefined;
    const facts: StatementFacts = Object.freeze({
      kind: "statement",
      dispatch: deferred.dispatch,
      complete: (outcome) => {
        if (published === undefined) {
          deferred.settleSkipped();
          return undefined;
        }
        // Core selects the log and marks its failure in the settling tick;
        // the extension only formats what this returns.
        const failure =
          outcome.status === "failure" && outcome.failure instanceof Error
            ? outcome.failure
            : undefined;
        if (outcome.status === "failure" && failure === undefined) {
          return undefined;
        }
        const member =
          failure === undefined || published.forceErrorContext
            ? undefined
            : findUniqueErrorLogDetails(failure, published.members);
        const logContext =
          member?.context ??
          (failure === undefined || published.forceErrorContext
            ? published.context
            : getErrorExecutionContext(failure, published.context));
        const capability = readOfficialCapability(logContext);
        if (capability === undefined) return undefined;
        const log = capability.wants(
          failure === undefined ? "query-log" : "error-log"
        );
        if (!(log || (failure && capability.wants("statement"))))
          return undefined;
        if (failure !== undefined && log) markErrorLogged(failure);
        return Object.freeze({
          kind: "statement",
          endedAt: Date.now(),
          capability,
          ...(log ? {} : { skipLog: true as const }),
          context: logContext,
          sql: member?.sql ?? published.sql,
          params: member?.params ?? published.params,
          ...(failure === undefined ? {} : { failure }),
        });
      },
    });
    return Object.freeze({
      readFacts: () => facts,
      execute: <Result>(
        execution: StatementExecution,
        executor: () => Promise<Result>
      ): Promise<Result> =>
        deferred.execute((start) => {
          published = Object.freeze({
            ...execution,
            driver: this,
            startedAt: Date.now(),
            start,
          });
          return published;
        }, executor),
    });
  }

  /** Build one late dispatch gate without moving the lifecycle across its queue. */
  private createOfficialDriverLifecycleExecutionGate(
    context: QueryExecutionContext,
    boundary: LifecycleBoundary
  ): TrustedGate<OfficialDriverLifecycleExecutionGate, LifecycleFacts> {
    const deferred = createDeferredDispatch<LifecycleDispatch>();
    const facts: LifecycleFacts = Object.freeze({
      kind: "driver-lifecycle",
      dispatch: deferred.dispatch,
      complete: (outcome) => {
        deferred.settleSkipped();
        return outcome.status === "failure" && outcome.failure instanceof Error
          ? Object.freeze({
              kind: "driver-lifecycle",
              failure: outcome.failure,
            })
          : undefined;
      },
    });
    return Object.freeze({
      readFacts: () => facts,
      execute: <Result>(executor: () => Promise<Result>) =>
        deferred.execute(
          (start) => Object.freeze({ driver: this, context, boundary, start }),
          executor
        ),
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
   * The open, usable client, when there is one: no wait for {@link getClient}.
   *
   * Only while acquisition is this class's own: a subclass that overrides
   * {@link getClient} decides which connection each statement uses, so it is
   * asked every time (the transaction-bound driver answers with its `tx`).
   */
  protected connectedClient(): TClient | TTransaction | undefined {
    if (
      this.getClient !== DriverInstrumentationBase.prototype.getClient ||
      this.transactionPoisonError ||
      this.isDisconnecting ||
      this.closeRetryClient !== null
    )
      return undefined;
    return this.client ?? undefined;
  }

  /**
   * Get or initialize the client.
   */
  protected async getClient(
    context: QueryExecutionContext = {}
  ): Promise<TClient | TTransaction> {
    if (
      this.transactionPoisonError ||
      this.isDisconnecting ||
      this.closeRetryClient !== null
    )
      throw this.unavailableClientError(context);
    if (this.client) return this.client;
    return await this.initializeClient(context);
  }

  /** Why the client cannot be used now, out of line from the usable path. */
  private unavailableClientError(context: QueryExecutionContext): Error {
    if (this.transactionPoisonError) {
      return new TransactionError(
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
    return this.connectionClosedError(
      this.isDisconnecting
        ? "Database connection is closing"
        : "Database connection cleanup is incomplete",
      context
    );
  }

  /** The one `CONNECTION_CLOSED` refusal shape, for each closed-transport reason. */
  protected connectionClosedError(
    message: string,
    context: QueryExecutionContext
  ): ConnectionError {
    return new ConnectionError(message, {
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

  /** The first connection, out of line from the connected path. */
  private async initializeClient(
    context: QueryExecutionContext
  ): Promise<TClient | TTransaction> {
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
        callsite: getExecutionCallsite(context),
        diagnostics: this.getErrorDisclosure(context),
      });
    }
  }

  // ============================================================
  // INSTRUMENTATION HELPER
  // ============================================================

  /** Normalize one provider statement failure at its existing trust boundary. */
  protected normalizeStatementFailure(
    error: unknown,
    sql: string,
    params: unknown[],
    context: QueryExecutionContext,
    forceErrorContext: boolean
  ): Error {
    return normalizeDriverError(error, {
      driverName: this.driverName,
      dialect: this.dialect,
      model: context.model,
      operation: context.operation,
      correlationId: context.correlationId,
      callsite: getExecutionCallsite(context),
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

  protected canDiscloseParameters(context?: QueryExecutionContext): boolean {
    const official = readOfficialCapability(context);
    return (
      official !== undefined &&
      (official.diagnostics.includeParams === true ||
        official.wants("parameters"))
    );
  }

  protected getErrorDisclosure(
    context?: QueryExecutionContext
  ): DiagnosticDisclosure {
    return readOfficialCapability(context)?.diagnostics ?? EMPTY_DISCLOSURE;
  }
}

/** The official capability of the exact chain this trusted context carries. */
function readOfficialCapability(context: QueryExecutionContext | undefined) {
  return getOfficialInstrumentationChainCapability(
    getExecutionExtensionChain(context)
  );
}
