/** Driver instrumentation, diagnostics, and provider result middleware. */

import type { EngineFacts } from "@adapters/database-adapter";
import {
  ConnectionError,
  type DiagnosticDisclosure,
  EMPTY_DISCLOSURE,
  TransactionError,
  VibORMErrorCode,
} from "@errors";
import type { UnitKind } from "@extensions/unit-source";
import type { QueryBackend } from "@query-engine/raptor3/shared/query-backend";
import type { Operation } from "@query-engine/types";
import type { Sql } from "@sql";
import { NumberedSql } from "../sql/numbered";
import {
  assertStatementBindParameterCapacity,
  normalizedBindParameterLimit,
} from "./bind-parameter-capacity";
import {
  BATCH_DIAGNOSTIC_PARAMS,
  EMPTY_DIAGNOSTIC_PARAMS,
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
  abstract readonly adapter: EngineFacts;
  /**
   * What writes this driver's statements, where its database does not read SQL.
   * Absent, the engine's SQL backend does. Each class's abstract members are what
   * a language has to answer, so one left out does not compile.
   */
  declare readonly backend?: QueryBackend;
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

  /**
   * Whether the transport binds `?NNN` by position (PostgreSQL's `$n`
   * always is), so a statement over the bind budget may bind each equal
   * value once. A transport that reads `?NNN` as a name says no. A fact of
   * the class, so a driver instance carries no slot for it.
   */
  protected get numbersPlaceholders(): boolean {
    return true;
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
    if (transforms !== undefined) {
      const executionContext = this.resolveExecutionContext(
        context,
        fallbackOperation
      );
      transformed = transforms.apply(
        query,
        executionContext.model,
        executionContext.operation ?? fallbackOperation
      );
    }
    const limit = normalizedBindParameterLimit(
      this.maxBindParametersPerStatement
    );
    // Over the budget, equal values bind once where the transport numbers
    // its placeholders: a governed read repeats its constants and values.
    if (
      limit !== undefined &&
      transformed.values.length > limit &&
      this.dialect !== "mysql" &&
      this.numbersPlaceholders
    )
      transformed = new NumberedSql(
        transformed,
        this.dialect === "postgresql" ? "$" : "?"
      );
    assertStatementBindParameterCapacity(
      transformed,
      this.driverName,
      limit,
      "operation"
    );
    return transformed;
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

  /**
   * `child` as one unit of real work of the context's chain, where the chain
   * observes units; else `child` alone, with nothing built for a reader.
   */
  protected inUnit<Result>(
    kind: UnitKind,
    context: QueryExecutionContext,
    child: () => Promise<Result>,
    sql?: string,
    params?: readonly unknown[],
    batch?: readonly BatchQuery[]
  ): Promise<Result> {
    const observation = getExecutionExtensionChain(context)?.observation;
    return observation === undefined
      ? child()
      : observation.run(
          {
            kind,
            operation: context.operation,
            model: context.model,
            context,
            driver: this,
            sql,
            params,
            batch,
          },
          child
        );
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
    return this.getErrorDisclosure(context).includeParams === true;
  }

  /** What a failure discloses: the chain's `disclosure` part, else nothing. */
  protected getErrorDisclosure(
    context?: QueryExecutionContext
  ): DiagnosticDisclosure {
    return getExecutionExtensionChain(context)?.disclosure ?? EMPTY_DISCLOSURE;
  }
}
