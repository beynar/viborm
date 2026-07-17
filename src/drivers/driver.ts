/** Driver connection lifecycle and transaction-bound execution surface. */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { ConnectionError, TransactionError, VibORMErrorCode } from "@errors";
import { runWithTracer } from "@instrumentation/run-with-tracer";
import { SPAN_CONNECT, SPAN_DISCONNECT } from "@instrumentation/spans";
import type { Sql } from "@sql";
import type {
  DriverResultParser,
  NestedTransactionObservation,
} from "./driver-instrumentation";
import { DriverTransactionBase } from "./driver-transaction-base";
import { normalizeDriverConnectionError } from "./error-mapping";
import { observePromiseRejection } from "./rejection-observed-promise";
import { SavepointQueue } from "./savepoint-queue";
import { runSavepoint } from "./shared/transactions";
import {
  getUnsupportedTransactionOptionsError,
  toTransactionOperationError,
} from "./transaction-lifecycle-error";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "./types";

export type { DriverResultParser } from "./driver-instrumentation";
export type { QueryExecutionContext } from "./types";

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
    const doConnect = async () => {
      await this.getClient(executionContext);
    };

    // Get tracer (always defined - either real or no-op)
    const tracer = this.getTracer(executionContext);

    const executeConnect = () =>
      runWithTracer(
        tracer,
        {
          name: SPAN_CONNECT,
          attributes: this.getContextAttributes(executionContext),
        },
        doConnect
      );
    if (this.serializeTransactions && !this.inTransaction) {
      this.assertBaseOperationAllowedDuringTransaction(executionContext);
      return this.connectionQueue.enqueue(executeConnect);
    }
    return executeConnect();
  }

  /**
   * Disconnect from the database with instrumentation.
   */
  async _disconnect(context?: QueryExecutionContext): Promise<void> {
    const executionContext = this.resolveExecutionContext(
      context,
      "disconnect"
    );
    const executeDisconnect = async () => {
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

        if (!this.client) return;
        try {
          await this.closeClient(this.client);
        } catch (error) {
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

      const tracer = this.getTracer(executionContext);
      const disconnectPromise = runWithTracer(
        tracer,
        {
          name: SPAN_DISCONNECT,
          attributes: this.getContextAttributes(executionContext),
        },
        doDisconnect
      );

      try {
        await disconnectPromise;
      } finally {
        this.client = null;
        this.initPromise = null;
        this.isDisconnecting = false;
      }
    };

    if (this.serializeTransactions && !this.inTransaction) {
      this.assertBaseOperationAllowedDuringTransaction(executionContext);
      return this.connectionQueue.enqueue(executeDisconnect);
    }
    return executeDisconnect();
  }

  async disconnect(): Promise<void> {
    return this._disconnect();
  }
}

export type AnyDriver = Driver<unknown, unknown>;

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
  readonly adapter: DatabaseAdapter;
  override readonly result?: DriverResultParser;
  protected override readonly inTransaction = true;
  override readonly supportsTransactions: boolean;
  override readonly supportsBatch: boolean;

  constructor(
    baseDriver: Driver<TClient, TTransaction>,
    tx: TTransaction,
    context?: QueryExecutionContext
  ) {
    super(baseDriver.dialect, baseDriver.driverName, context);
    this.baseDriver = baseDriver;
    this.parentTransactionDriver =
      baseDriver instanceof TransactionBoundDriver ? baseDriver : undefined;
    this.tx = tx;
    this.adapter = baseDriver.adapter;
    this.result = baseDriver.result;
    this.supportsTransactions = baseDriver.supportsTransactions;
    this.supportsBatch = baseDriver.supportsBatch;
    // Copy instrumentation - each tx driver gets its own context for proper span parenting
    this.instrumentation = baseDriver["instrumentation"];
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

  override _executeBatch<T>(
    queries: BatchQuery[],
    unsupportedOptions?: undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    const optionsError =
      getUnsupportedTransactionOptionsError(unsupportedOptions);
    if (optionsError) return Promise.reject(optionsError);
    if (queries.length === 0) return Promise.resolve([]);
    const activeSavepointError = this.getActiveSavepointUseError(
      "$transaction([...])"
    );
    if (activeSavepointError) return Promise.reject(activeSavepointError);
    return this.trackTransactionOperation(
      () =>
        this.enqueueScopeOperation(() =>
          super._executeBatch<T>(queries, undefined, context)
        ),
      true
    );
  }

  override _transaction<T>(
    fn: (tx: TTransaction) => Promise<T>,
    unsupportedOptions?: undefined,
    context?: QueryExecutionContext
  ): Promise<T> {
    const optionsError =
      getUnsupportedTransactionOptionsError(unsupportedOptions);
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
    const executeTransaction = () =>
      this.scopeQueue.enqueue(async () => {
        this.assertTransactionCommittable();
        this.isSavepointActive = true;
        try {
          return await super._transaction(fn, undefined, context);
        } finally {
          this.isSavepointActive = false;
        }
      });
    if (isAdmittedWithTransactionDispatch) return executeTransaction();
    return this.trackTransactionOperation(executeTransaction, false);
  }

  override withTransaction<T>(
    fn: (txDriver: Driver<TClient, TTransaction>) => Promise<T>,
    unsupportedOptions?: undefined,
    context?: QueryExecutionContext
  ): Promise<T> {
    const optionsError =
      getUnsupportedTransactionOptionsError(unsupportedOptions);
    if (optionsError) return Promise.reject(optionsError);
    const activeSavepointError = this.getActiveSavepointUseError(
      "$transaction(callback)"
    );
    if (activeSavepointError) return Promise.reject(activeSavepointError);
    return this.trackTransactionOperation(() => {
      this.hasAdmittedWithTransactionDispatch = true;
      try {
        return super.withTransaction(fn, undefined, context);
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
