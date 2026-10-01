/** Driver connection lifecycle and transaction-bound execution surface. */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { ConnectionError, TransactionError, VibORMErrorCode } from "@errors";
import type { Sql } from "@sql";
import { ASYNC_DISPOSE, type AsyncDisposeMember } from "./async-dispose";
import {
  type DriverResultParser,
  type NestedTransactionObservation,
  ungatedLifecycleExecution,
} from "./driver-instrumentation";
import { DriverTransactionBase } from "./driver-transaction-base";
import { normalizeDriverConnectionError } from "./error-mapping";
import { observePromiseRejection } from "./rejection-observed-promise";
import { SavepointQueue } from "./savepoint-queue";
import { defineImmutableDriverFact } from "./shared/driver-options";
import type { PinnedSessionReservation } from "./shared/pinned-session";
import type {
  BatchTransactionOptions,
  TransactionForm,
  TransactionOptionSupport,
  TransactionOptions,
} from "./shared/transaction-options";
import { runSavepoint } from "./shared/transactions";
import { toTransactionOperationError } from "./transaction-lifecycle-error";
import type {
  BatchQuery,
  CommittedBatchNotification,
  QueryExecutionContext,
  QueryResult,
} from "./types";

export type { DriverResultParser } from "./driver-instrumentation";
export type { QueryExecutionContext } from "./types";

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the `Driver` interface below is a deliberate merge — it declares the `await using` member, which is installed on the prototype (guarded on the runtime key) rather than in this body.
export abstract class Driver<
  TClient,
  TTransaction,
> extends DriverTransactionBase<TClient, TTransaction> {
  protected createTransactionBoundDriver(
    tx: TTransaction,
    context: QueryExecutionContext
  ): TransactionBoundDriver<TClient, TTransaction> {
    return new TransactionBoundDriver(this, tx, context);
  }
  /**
   * Connect to the database with instrumentation.
   */
  async _connect(context?: QueryExecutionContext): Promise<void> {
    const executionContext = this.resolveExecutionContext(context, "connect");
    const hasLifecycleObservers = this.hasTrustedObservers(executionContext);
    const doConnect = async () => {
      await this.getClient(executionContext);
    };

    const executeConnect = (gate = ungatedLifecycleExecution) =>
      gate.execute(doConnect);
    if (this.serializeTransactions && !this.inTransaction) {
      this.assertBaseOperationAllowedDuringTransaction(executionContext);
      if (!hasLifecycleObservers) {
        return this.connectionQueue.enqueue(executeConnect);
      }
      return this.observeTrustedDriverLifecycle(
        "connection",
        executionContext,
        "connect",
        (gate) => this.connectionQueue.enqueue(() => executeConnect(gate))
      );
    }
    return hasLifecycleObservers
      ? this.observeTrustedDriverLifecycle(
          "connection",
          executionContext,
          "connect",
          executeConnect
        )
      : executeConnect();
  }

  /**
   * Disconnect from the database with instrumentation.
   */
  async _disconnect(context?: QueryExecutionContext): Promise<void> {
    const executionContext = this.resolveExecutionContext(
      context,
      "disconnect"
    );
    const hasLifecycleObservers = this.hasTrustedObservers(executionContext);
    const executeDisconnect = async (gate = ungatedLifecycleExecution) => {
      if (this.isDisconnecting) {
        throw new ConnectionError("Database connection is closing", {
          code: VibORMErrorCode.CONNECTION_CLOSED,
          diagnostics: this.getErrorDisclosure(executionContext),
          meta: {
            driver: this.driverName,
            model: executionContext.model,
            operation: executionContext.operation,
            correlationId: executionContext.correlationId,
          },
        });
      }
      this.isDisconnecting = true;
      const doDisconnect = async () => {
        if (this.initPromise) {
          try {
            await this.initPromise;
          } catch {
            // Ignore init errors during disconnect
          }
        }

        const closingClient = this.closeRetryClient ?? this.client;
        if (!closingClient) return;
        try {
          await this.closeClient(closingClient);
        } catch (error) {
          // A provider may make the transport unusable before its close promise
          // rejects. Keep the exact handle for cleanup retry, but remove it from
          // every path that can query it or call it connected.
          this.closeRetryClient = closingClient;
          if (this.client === closingClient) this.client = null;
          this.initPromise = null;
          throw normalizeDriverConnectionError(
            error,
            {
              driverName: this.driverName,
              model: executionContext.model,
              operation: executionContext.operation,
              correlationId: executionContext.correlationId,
              diagnostics: this.getErrorDisclosure(executionContext),
            },
            "Database disconnection failed"
          );
        }
      };

      const disconnectPromise = gate.execute(doDisconnect);

      try {
        await disconnectPromise;
        this.client = null;
        this.initPromise = null;
        this.closeRetryClient = null;
      } finally {
        this.isDisconnecting = false;
      }
    };

    if (this.serializeTransactions && !this.inTransaction) {
      this.assertBaseOperationAllowedDuringTransaction(executionContext);
      if (!hasLifecycleObservers) {
        return this.connectionQueue.enqueue(executeDisconnect);
      }
      return this.observeTrustedDriverLifecycle(
        "connection",
        executionContext,
        "disconnect",
        (gate) => this.connectionQueue.enqueue(() => executeDisconnect(gate))
      );
    }
    return hasLifecycleObservers
      ? this.observeTrustedDriverLifecycle(
          "connection",
          executionContext,
          "disconnect",
          executeDisconnect
        )
      : executeDisconnect();
  }

  // ===========================================================================
  // PINNED SESSION (migration locking)
  // ===========================================================================

  /**
   * Reserves ONE physical session from this transport, or is absent.
   *
   * Its PRESENCE is the capability — nothing else declares pinned-session
   * support, so a driver cannot advertise a session it has no way to reserve,
   * and a driver that does not implement it gains no new abstract obligation
   * (plan §3.5). Absent on every stateless transport (Neon HTTP, PlanetScale,
   * D1) and on the SQLite family, which keeps its existing single-connection
   * queue and transaction ownership.
   */
  protected pinnedSession?(): Promise<
    PinnedSessionReservation<TClient | TTransaction>
  >;

  /**
   * The PHYSICAL session a pinned command would run on, when that session can
   * be shared with ANOTHER driver, or absent when it cannot.
   *
   * Its presence is what makes the migration lease (`withPinnedSession` in
   * `src/migrations/pinned-session.ts`) command-wide across drivers
   * rather than only across one driver's queue. Absent on every provider that
   * reserves a dedicated connection out of a pool: those sessions are already
   * physically apart, and two migration commands on a pool are arbitrated by
   * the real session lock. Present on the single-connection transport whose ONE
   * client a caller may hand to several drivers.
   */
  protected physicalPinnedSession?(): Promise<object>;

  async disconnect(): Promise<void> {
    return this._disconnect();
  }
}

/**
 * `await using driver = new SomeDriver(...)` — leaving the block runs the same
 * close path as an explicit `disconnect()`, including when the block is left by
 * a throw.
 *
 * The empty body IS the payload: `extends AsyncDisposeMember` contributes the
 * member where the platform declares `Symbol.asyncDispose`, and contributes
 * nothing where it does not — which is why this is a merged interface and not a
 * method in the class body, where the key would have to be written literally.
 *
 * A `TransactionBoundDriver` inherits it and is disposal-inert for free: its
 * `disconnect()` override is a no-op, because `$transaction` owns that driver's
 * lifetime, not the caller.
 */
// biome-ignore lint/correctness/noUnusedVariables: a merged interface must restate the class's type parameters exactly, used or not.
export interface Driver<TClient, TTransaction> extends AsyncDisposeMember {}

export type AnyDriver = Driver<unknown, unknown>;

function disposeDriver(this: AnyDriver): Promise<void> {
  return this.disconnect();
}

// Guarded rather than written as a computed key in the class body: where the
// runtime predates explicit resource management the well-known symbol is
// `undefined`, and `[Symbol.asyncDispose]() {}` would then install a method
// under the string key `"undefined"` instead of installing nothing.
if (ASYNC_DISPOSE !== undefined) {
  Object.defineProperty(Driver.prototype, ASYNC_DISPOSE, {
    configurable: true,
    writable: true,
    enumerable: false,
    value: disposeDriver,
  });
}

export class TransactionBoundDriver<TClient, TTransaction> extends Driver<
  TClient,
  TTransaction
> {
  private readonly baseDriver: Driver<TClient, TTransaction>;
  private readonly parentTransactionDriver:
    | TransactionBoundDriver<TClient, TTransaction>
    | undefined;
  private readonly tx: TTransaction;
  private readonly scopeQueue = new SavepointQueue();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly nestedTransactionObservations =
    new Set<NestedTransactionObservation>();
  private transactionClosed = false;
  private isSavepointActive = false;
  private hasAdmittedWithTransactionDispatch = false;
  private rollbackOnlyError: Error | undefined;
  declare readonly adapter: DatabaseAdapter;
  override readonly result?: DriverResultParser;
  protected override readonly inTransaction = true;
  override readonly supportsTransactions: boolean;
  override readonly supportsBatch: boolean;
  override readonly supportsOrderedCommittedSegments: boolean;
  override readonly maxBindParametersPerStatement: number | undefined;

  constructor(
    baseDriver: Driver<TClient, TTransaction>,
    tx: TTransaction,
    context?: QueryExecutionContext
  ) {
    // The exact base value, for this view and every view nested under it: a
    // transaction never derives, upgrades, or drops the transport assertion.
    super(
      baseDriver.dialect,
      baseDriver.driverName,
      context,
      baseDriver.migrationNamespaceAttestation
    );
    this.baseDriver = baseDriver;
    this.parentTransactionDriver =
      baseDriver instanceof TransactionBoundDriver ? baseDriver : undefined;
    this.tx = tx;
    // The same adapter object the root driver renders with, pinned here too:
    // this view is what the engine re-reads for every statement inside the
    // transaction.
    defineImmutableDriverFact(this, "adapter", baseDriver.adapter);
    this.result = baseDriver.result;
    this.supportsTransactions = baseDriver.supportsTransactions;
    this.supportsBatch = baseDriver.supportsBatch;
    this.supportsOrderedCommittedSegments =
      baseDriver.supportsOrderedCommittedSegments;
    this.maxBindParametersPerStatement =
      baseDriver.maxBindParametersPerStatement;
  }

  // Always return the bound transaction
  protected override async getClient(
    _context?: QueryExecutionContext
  ): Promise<TClient | TTransaction> {
    return this.tx;
  }

  closeTransactionScope(): void {
    this.transactionClosed = true;
    for (const observation of this.nestedTransactionObservations) {
      if (observation.failure && !observation.isRejectionObserved) {
        this.markCurrentScopeRollbackOnly(observation.failure);
      }
    }
  }

  async waitForActiveOperations(): Promise<void> {
    while (this.activeOperations.size > 0) {
      await Promise.allSettled([...this.activeOperations]);
    }
  }

  getTransactionFailure(): Error | undefined {
    return (
      this.parentTransactionDriver?.getTransactionFailure() ??
      this.rollbackOnlyError
    );
  }

  assertTransactionCommittable(): void {
    this.parentTransactionDriver?.assertTransactionCommittable();
    if (this.rollbackOnlyError) throw this.rollbackOnlyError;
  }

  private markCurrentScopeRollbackOnly(error: Error): void {
    this.rollbackOnlyError ??= error;
  }

  private markRootTransactionRollbackOnly(error: Error): void {
    if (this.parentTransactionDriver) {
      this.parentTransactionDriver.markRootTransactionRollbackOnly(error);
      return;
    }
    this.rollbackOnlyError ??= error;
  }

  private assertTransactionOpen(): void {
    this.parentTransactionDriver?.assertTransactionOpen();

    if (this.rollbackOnlyError) throw this.rollbackOnlyError;

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

  private getActiveSavepointUseError(
    method: string
  ): TransactionError | undefined {
    if (!this.isSavepointActive) return undefined;
    return new TransactionError(
      `Transaction scope for driver "${this.driverName}" cannot be used while its nested transaction is active. At every nesting level, use the transaction client supplied to that callback.`,
      {
        meta: {
          driver: this.driverName,
          method,
        },
      }
    );
  }

  private enqueueScopeOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.scopeQueue.enqueue(async () => {
      this.assertTransactionCommittable();
      try {
        return await operation();
      } catch (error) {
        this.markCurrentScopeRollbackOnly(toTransactionOperationError(error));
        throw error;
      }
    });
  }

  private trackTransactionOperation<T>(
    operation: () => Promise<T>,
    poisonOnFailure: boolean
  ): Promise<T> {
    const observation: NestedTransactionObservation | undefined =
      poisonOnFailure ? undefined : { isRejectionObserved: false };
    if (observation) this.nestedTransactionObservations.add(observation);
    const operationPromise = Promise.resolve().then(() => {
      this.assertTransactionOpen();
      return operation();
    });

    this.activeOperations.add(operationPromise);
    operationPromise
      .then(
        () => {
          this.activeOperations.delete(operationPromise);
        },
        (error: unknown) => {
          this.activeOperations.delete(operationPromise);
          const operationError = toTransactionOperationError(error);
          if (observation) {
            observation.failure = operationError;
            if (this.transactionClosed && !observation.isRejectionObserved) {
              this.markCurrentScopeRollbackOnly(operationError);
            }
            return;
          }
          this.markCurrentScopeRollbackOnly(operationError);
        }
      )
      .catch(() => undefined);
    if (!observation) return operationPromise;
    return observePromiseRejection(operationPromise, () => {
      observation.isRejectionObserved = true;
    });
  }

  override _execute<T = Record<string, unknown>>(
    query: Sql,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const activeSavepointError = this.getActiveSavepointUseError("execute");
    if (activeSavepointError) return Promise.reject(activeSavepointError);
    return this.trackTransactionOperation(
      () => this.enqueueScopeOperation(() => super._execute<T>(query, context)),
      true
    );
  }

  override _executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const activeSavepointError = this.getActiveSavepointUseError("executeRaw");
    if (activeSavepointError) return Promise.reject(activeSavepointError);
    return this.trackTransactionOperation(
      () =>
        this.enqueueScopeOperation(() =>
          super._executeRaw<T>(sql, params, context)
        ),
      true
    );
  }

  /**
   * A nested `$transaction` is a SAVEPOINT inside an already-open transaction,
   * which changes what each option can honestly mean here.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "unsupported",
      isolationLevelReason:
        "a nested transaction runs as a SAVEPOINT inside the outer transaction, whose isolation level is already fixed and cannot be changed mid-transaction — set it on the outermost $transaction",
      // The savepoint body is a real interactive callback: racing it out rolls
      // back to the savepoint, exactly as any other nested failure would.
      timeout: true,
      maxWait: "unsupported",
      maxWaitReason:
        "a nested transaction reuses the outer transaction's connection, so there is no transaction slot to wait for",
    };
  }

  /**
   * Refuse a malformed or unhonorable option before touching savepoint state,
   * preserving the rule that a refusal happens before any provider work.
   */
  private readNestedOptionsError(
    options: unknown,
    form: TransactionForm
  ): Error | undefined {
    try {
      this.resolveTransactionOptions(options, form);
      return undefined;
    } catch (error) {
      return toTransactionOperationError(error);
    }
  }

  override _executeBatch<T>(
    queries: BatchQuery[],
    options?: BatchTransactionOptions,
    context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    const optionsError = this.readNestedOptionsError(options, "batch");
    if (optionsError) return Promise.reject(optionsError);
    if (queries.length === 0) return Promise.resolve([]);
    const activeSavepointError = this.getActiveSavepointUseError(
      "$transaction([...])"
    );
    if (activeSavepointError) return Promise.reject(activeSavepointError);
    return this.trackTransactionOperation(
      () =>
        this.enqueueScopeOperation(() =>
          super._executeBatch<T>(queries, options, context, committed)
        ),
      true
    );
  }

  override _transaction<T>(
    fn: (tx: TTransaction) => Promise<T>,
    options?: TransactionOptions,
    context?: QueryExecutionContext
  ): Promise<T> {
    const optionsError = this.readNestedOptionsError(options, "callback");
    if (optionsError) return Promise.reject(optionsError);
    const isAdmittedWithTransactionDispatch =
      this.hasAdmittedWithTransactionDispatch;
    if (!isAdmittedWithTransactionDispatch) {
      const activeSavepointError = this.getActiveSavepointUseError(
        "$transaction(callback)"
      );
      if (activeSavepointError) return Promise.reject(activeSavepointError);
      try {
        this.assertTransactionOpen();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const plan = this.resolveTransactionOptions(options, "callback");
    const executionContext = this.resolveExecutionContext(
      context,
      "transaction"
    );
    const hasLifecycleObservers = this.hasTrustedObservers(executionContext);
    const executeTransaction = (gate = ungatedLifecycleExecution) =>
      this.scopeQueue.enqueue(async () => {
        this.assertTransactionCommittable();
        this.isSavepointActive = true;
        try {
          return await this.runProviderTransactionCore(
            fn,
            plan,
            executionContext,
            gate
          );
        } finally {
          this.isSavepointActive = false;
        }
      });
    const executeObservedTransaction = hasLifecycleObservers
      ? () =>
          this.observeTransactionLifecycle(
            "savepoint",
            executionContext,
            (_transactionContext, gate) => executeTransaction(gate)
          )
      : undefined;
    if (isAdmittedWithTransactionDispatch) {
      return executeObservedTransaction
        ? executeObservedTransaction()
        : executeTransaction();
    }
    return this.trackTransactionOperation(
      executeObservedTransaction ?? executeTransaction,
      false
    );
  }

  override withTransaction<T>(
    fn: (txDriver: Driver<TClient, TTransaction>) => Promise<T>,
    options?: TransactionOptions,
    context?: QueryExecutionContext
  ): Promise<T> {
    const optionsError = this.readNestedOptionsError(options, "callback");
    if (optionsError) return Promise.reject(optionsError);
    const activeSavepointError = this.getActiveSavepointUseError(
      "$transaction(callback)"
    );
    if (activeSavepointError) return Promise.reject(activeSavepointError);
    return this.trackTransactionOperation(() => {
      this.hasAdmittedWithTransactionDispatch = true;
      try {
        return super.withTransaction(fn, options, context);
      } finally {
        this.hasAdmittedWithTransactionDispatch = false;
      }
    }, false);
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
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.baseDriver["execute"](client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: TClient | TTransaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.baseDriver["executeRaw"](client, sql, params, context);
  }

  protected override async transaction<T>(
    _client: TClient | TTransaction,
    fn: (tx: TTransaction) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    this.assertTransactionCommittable();
    return runSavepoint(
      (statement) =>
        this.baseDriver["executeRaw"](
          this.tx,
          statement,
          undefined,
          context ?? {}
        ),
      () => fn(this.tx)
    );
  }

  protected override transactionCleanupFailed(error: Error): void {
    this.markRootTransactionRollbackOnly(error);
  }

  override async disconnect(): Promise<void> {
    // No-op - base driver owns the connection
  }
}
