/** Transaction and atomic batch orchestration shared by all drivers. */

import { TransactionError } from "@errors";
import { Sql } from "@sql";
import {
  connectionQueueWait,
  isConnectionScope,
  withConnectionScope,
} from "./connection-scope";
import type { Driver } from "./driver";
import { prepareAtomicBatch } from "./driver-batch-preparation";
import { isVerbatimBatchQuery } from "./driver-batch-query-kind";
import { findUniqueExecutionContextIndex } from "./driver-diagnostics";
import {
  DriverInstrumentationBase,
  type OfficialDriverLifecycleExecutionGate,
  type OfficialStatementExecutionGate,
  ungatedLifecycleExecution,
  ungatedStatementExecution,
} from "./driver-instrumentation";
import { normalizeDriverError } from "./error-mapping";
import { appendExecutionTransactionPhases } from "./execution-context";
import {
  assertNormalizedBatchResults,
  assertNormalizedQueryResult,
} from "./normalized-result";
import { registerPreparedStatement } from "./prepared-statement-provenance";
import { snapshotProviderParameters } from "./provider-parameter-snapshot";
import { withSuppressedFailure } from "./shared/suppressed-failure";
import {
  type BatchTransactionOptions,
  parseTransactionOptions,
  resolveTransactionPlan,
  runWithTransactionTimeout,
  type TransactionForm,
  type TransactionOptionContext,
  type TransactionOptions,
  type TransactionPlan,
} from "./shared/transaction-options";
import {
  createTransactionCleanupError,
  ProviderTransactionContractError,
  readTransactionCleanupFailures,
  unsupportedCallbackTransactionError,
} from "./shared/transactions";
import { normalizeTransactionLifecycleError } from "./transaction-lifecycle-error";
import type {
  BatchQuery,
  CommittedBatchNotification,
  QueryExecutionContext,
  QueryResult,
} from "./types";

/** Forward every option except `timeout`, which the caller consumed itself. */
function withoutTimeout(
  options: TransactionOptions | undefined
): TransactionOptions | undefined {
  if (!options) return options;
  const { timeout: _consumed, ...rest } = options;
  return rest;
}

interface TransactionScopeDriver<TClient, TTransaction>
  extends Driver<TClient, TTransaction> {
  closeTransactionScope(error?: unknown): void;
  waitForActiveOperations(): Promise<void>;
  assertTransactionCommittable(): void;
  getTransactionFailure(): Error | undefined;
}

export abstract class DriverTransactionBase<
  TClient,
  TTransaction,
> extends DriverInstrumentationBase<TClient, TTransaction> {
  protected runTransactionBody<T>(body: () => Promise<T>): Promise<T> {
    return body();
  }

  protected abstract createTransactionBoundDriver(
    tx: TTransaction,
    context: QueryExecutionContext
  ): TransactionScopeDriver<TClient, TTransaction>;
  protected assertBaseOperationAllowedDuringTransaction(
    context: QueryExecutionContext
  ): void {
    if (isConnectionScope(this.connectionQueue))
      throw this.transactionBoundError(context);
  }

  /** The refusal above, out of line: outside a transaction it never runs. */
  private transactionBoundError(context: QueryExecutionContext): Error {
    return new TransactionError(
      `Driver "${this.driverName}" cannot use the originating client while its single connection is transaction-bound. Use the transaction client supplied to the callback.`,
      {
        meta: {
          driver: this.driverName,
          model: context.model,
          operation: context.operation,
          correlationId: context.correlationId,
          method: "$transaction(callback)",
        },
      }
    );
  }

  private async runConnectionTransactionLease<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    return withConnectionScope(this.connectionQueue, operation);
  }

  /**
   * Validate the public options object and resolve it against this driver's
   * declared contract. Throws `V5005` for a malformed object and `V8003` for a
   * well-formed option this driver cannot honor — never returns a plan that
   * quietly drops something the caller asked for.
   *
   * Entry points that delegate to another entry point (`withTransaction` ->
   * `_transaction`, `_executeBatch` -> `_transaction`) resolve twice. The
   * resolution is pure and driven by the same `transactionOptionSupport()`, so
   * the second pass reaches the same verdict; resolving at each public entry is
   * what guarantees a refusal happens before any provider work.
   */
  protected resolveTransactionOptions(
    options: unknown,
    form: TransactionForm
  ): TransactionPlan | undefined {
    const context: TransactionOptionContext = {
      driverName: this.driverName,
      form,
    };
    const parsed = parseTransactionOptions(options, context);
    return resolveTransactionPlan(
      parsed,
      this.transactionOptionSupport(),
      context
    );
  }

  /**
   * Validate options against this driver's contract without running anything.
   *
   * The client layer calls this before dispatching, so that paths which never
   * reach a driver entry point — an empty operation array, most obviously —
   * still refuse an option this driver could not have honored.
   */
  assertTransactionOptionsSupported(
    options: unknown,
    form: TransactionForm
  ): void {
    this.resolveTransactionOptions(options, form);
  }

  /**
   * The `SET TRANSACTION ISOLATION LEVEL` statement to run as the first
   * statement inside a freshly opened transaction, or undefined when this
   * driver places the level elsewhere. PostgreSQL-family placement: the level
   * must be set after BEGIN and before any other statement in the transaction.
   */
  private readPostBeginIsolationStatement(
    plan: TransactionPlan | undefined
  ): string | undefined {
    if (plan?.isolationPlacement !== "post-begin") return undefined;
    return plan.isolationStatement;
  }

  // ============================================================
  // PUBLIC API for the driver to be called by the query-engine
  // ============================================================

  /**
   * Execute a query with instrumentation (tracing + logging).
   * Converts Sql to string/params ONCE, then calls run().
   */
  _execute<T = Record<string, unknown>>(
    query: Sql,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.executeTypedStatement(
      query,
      context,
      this.executeNormalizedProvider<T>
    );
  }

  /** One typed (or, for `_executeRaw`, raw) provider call, normalized. */
  private async executeNormalizedProvider<T>(
    client: TClient | TTransaction,
    sql: string,
    executionParams: unknown[],
    executionContext: QueryExecutionContext,
    raw = false
  ): Promise<QueryResult<T>> {
    const providerResult = raw
      ? await this.executeRaw<T>(client, sql, executionParams, executionContext)
      : await this.execute<T>(client, sql, executionParams, executionContext);
    assertNormalizedQueryResult(providerResult, {
      provider: this.driverName,
      operation: executionContext.operation ?? (raw ? "executeRaw" : "execute"),
    });
    return providerResult;
  }

  /** The one typed statement lifecycle, shared by public and internal transport. */
  protected async executeTypedStatement<Result>(
    query: Sql,
    context: QueryExecutionContext | undefined,
    executeProvider: (
      client: TClient | TTransaction,
      sql: string,
      executionParams: unknown[],
      executionContext: QueryExecutionContext
    ) => Promise<Result>
  ): Promise<Result> {
    const executionContext = this.resolveExecutionContext(context, "execute");
    const hasStatementObservers = this.hasTrustedObservers(executionContext);
    let transformedQuery = hasStatementObservers
      ? undefined
      : this.applyTrustedStatementTransforms(
          query,
          executionContext,
          "execute"
        );
    return this.dispatchStatement(
      executionContext,
      hasStatementObservers,
      // A transform or bind-capacity refusal must be a rejection, never a
      // synchronous throw out of the queue or the observer; caught here rather
      // than with an async wrapper, which costs a promise per statement.
      (gate) => {
        try {
          transformedQuery ??= this.applyTrustedStatementTransforms(
            query,
            executionContext,
            "execute"
          );
          return this.sendStatement(
            this.buildStatement(transformedQuery),
            transformedQuery.values,
            executionContext,
            executeProvider,
            gate
          );
        } catch (error) {
          return Promise.reject(error);
        }
      }
    );
  }

  /**
   * One statement's dispatch: observed when a trusted observer wants it, and
   * queued behind the connection's owner on a single-connection driver.
   */
  private dispatchStatement<Result>(
    executionContext: QueryExecutionContext,
    observed: boolean,
    executeQuery: (gate?: OfficialStatementExecutionGate) => Promise<Result>
  ): Promise<Result> {
    const run = observed
      ? () => this.observeTrustedStatement(executionContext, executeQuery)
      : executeQuery;
    if (this.serializeTransactions && !this.inTransaction) {
      this.assertBaseOperationAllowedDuringTransaction(executionContext);
      return this.connectionQueue.run(
        run,
        connectionQueueWait(undefined, {
          driverName: this.driverName,
          form: "callback",
        })
      );
    }
    return run();
  }

  /** One statement's text and parameters through the gate to the provider. */
  private async sendStatement<Result>(
    sql: string,
    params: readonly unknown[],
    executionContext: QueryExecutionContext,
    executeProvider: (
      client: TClient | TTransaction,
      sql: string,
      executionParams: unknown[],
      executionContext: QueryExecutionContext
    ) => Promise<Result>,
    gate: OfficialStatementExecutionGate = ungatedStatementExecution
  ): Promise<Result> {
    const executionParams = snapshotProviderParameters(
      params,
      executionContext
    );
    const diagnosticParams = this.getDiagnosticParameters(
      executionParams,
      executionContext
    );
    const client =
      this.connectedClient() ?? (await this.getClient(executionContext));
    return gate.execute(
      {
        context: executionContext,
        forceErrorContext: true,
        params: diagnosticParams,
        sql,
      },
      () =>
        this.executeNormalizedStatement(
          sql,
          diagnosticParams,
          executionContext,
          () =>
            executeProvider.call(
              this,
              client,
              sql,
              executionParams,
              executionContext
            ),
          true
        )
    );
  }

  /**
   * Convert a typed Sql fragment into a driver-ready batch query.
   * Query-engine planners use this so dialect placeholders stay driver-owned.
   */
  _prepare(query: Sql, _context?: QueryExecutionContext): BatchQuery {
    // Planning may discard this package. User transforms belong to dispatch.
    const statement = new Sql([...query.strings], [...query.values]);
    const prepared = {
      sql: this.buildStatement(statement),
      params: [...statement.values],
    };
    registerPreparedStatement(prepared, statement);
    return prepared;
  }

  /**
   * Execute raw SQL with instrumentation.
   */
  async _executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const executionContext = this.resolveExecutionContext(
      context,
      "executeRaw"
    );
    return this.dispatchStatement(
      executionContext,
      this.hasTrustedObservers(executionContext),
      (gate) =>
        this.sendStatement(
          sql,
          params ?? [],
          executionContext,
          (client, statement, executionParams) =>
            this.executeNormalizedProvider<T>(
              client,
              statement,
              executionParams,
              executionContext,
              true
            ),
          gate
        )
    );
  }

  /**
   * Execute one provider transaction after public option/context resolution.
   * Queue ownership and protected lifecycle observation remain with callers.
   */
  protected runProviderTransactionCore<T>(
    fn: (tx: TTransaction) => Promise<T>,
    plan: TransactionPlan | undefined,
    executionContext: QueryExecutionContext,
    lifecycleGate = ungatedLifecycleExecution
  ): Promise<T> {
    const noCallbackFailure = Symbol("noCallbackFailure");
    let callbackFailure: unknown = noCallbackFailure;
    // `timeout` on this raw entry point races the callback and lets the
    // lifecycle roll back. `withTransaction` applies its own timeout instead,
    // because only there is there a transaction-bound scope whose in-flight
    // statements can be drained before ROLLBACK — see its comment.
    const bodyCallback =
      plan?.timeoutMs === undefined
        ? fn
        : (tx: TTransaction) =>
            runWithTransactionTimeout(() => fn(tx), plan.timeoutMs as number, {
              driverName: this.driverName,
              form: "callback",
            });
    const trackedCallback = async (tx: TTransaction): Promise<T> => {
      try {
        return await bodyCallback(tx);
      } catch (error) {
        callbackFailure = error;
        throw error;
      }
    };
    const postBeginIsolation = this.readPostBeginIsolationStatement(plan);
    const providerCallback = async (tx: TTransaction): Promise<T> => {
      if (postBeginIsolation) {
        await this.executeRaw(tx, postBeginIsolation, undefined, {
          ...executionContext,
          operation: "transaction",
        });
      }
      return trackedCallback(tx);
    };

    const runTransaction = async () => {
      const client = await this.getClient(executionContext);
      try {
        return await this.transaction(
          client,
          providerCallback,
          executionContext,
          plan?.driverOptions
        );
      } catch (error) {
        const normalizeTransactionFailure = (failure: unknown) =>
          normalizeDriverError(failure, {
            driverName: this.driverName,
            dialect: this.dialect,
            model: executionContext.model,
            operation: executionContext.operation,
            correlationId: executionContext.correlationId,
            diagnostics: this.getErrorDisclosure(executionContext),
          });
        if (callbackFailure !== noCallbackFailure) {
          if (error === callbackFailure) throw error;
          const cleanupFailures = readTransactionCleanupFailures(
            error,
            callbackFailure
          ).map(normalizeTransactionFailure);
          const cleanupError = createTransactionCleanupError(
            callbackFailure,
            cleanupFailures
          );
          this.transactionCleanupFailed(cleanupError);
          throw cleanupError;
        }
        const normalizedError = normalizeTransactionLifecycleError(
          error,
          normalizeTransactionFailure
        );
        if (
          this.inTransaction ||
          error instanceof ProviderTransactionContractError ||
          (error instanceof AggregateError &&
            error.errors[0] === error.cause &&
            error.errors.length > 1)
        )
          this.transactionCleanupFailed(normalizedError);
        throw normalizedError;
      }
    };

    return lifecycleGate.execute(runTransaction);
  }

  /** Form one transaction/savepoint lifecycle outside its owning queue. */
  protected observeTransactionLifecycle<T>(
    kind: "savepoint" | "transaction",
    executionContext: QueryExecutionContext,
    child: (
      context: QueryExecutionContext,
      gate: OfficialDriverLifecycleExecutionGate | undefined
    ) => Promise<T>
  ): Promise<T> {
    const observationState:
      | { phase: "pending" | "ready" | "committed" }
      | undefined = kind === "transaction" ? { phase: "pending" } : undefined;
    const transactionExecutionContext = observationState
      ? appendExecutionTransactionPhases(executionContext, {
          readyToCommit: () => {
            observationState.phase = "ready";
          },
          committed: () => {
            observationState.phase = "committed";
          },
        })
      : executionContext;
    return this.observeTrustedDriverLifecycle(
      kind,
      executionContext,
      kind,
      async (gate) => {
        const result = await child(transactionExecutionContext, gate);
        if (observationState) observationState.phase = "committed";
        return result;
      },
      observationState === undefined
        ? undefined
        : () =>
            observationState.phase === "pending"
              ? undefined
              : {
                  commitCertainty:
                    observationState.phase === "committed"
                      ? "committed"
                      : "may-have-committed",
                }
    );
  }

  /**
   * Execute a function within a transaction.
   *
   * The callback receives the raw transaction object. Use `TransactionBoundDriver`
   * to create a driver that executes all operations within this transaction.
   *
   * @param fn - Callback that receives the transaction object
   * @param options - Prisma-shaped transaction options; each is honored or
   *   refused per this driver's declared contract, never ignored
   */
  async _transaction<T>(
    fn: (tx: TTransaction) => Promise<T>,
    options?: TransactionOptions,
    context?: QueryExecutionContext
  ): Promise<T> {
    const plan = this.resolveTransactionOptions(options, "callback");
    if (!this.supportsTransactions) {
      throw unsupportedCallbackTransactionError(this.driverName);
    }
    const executionContext = this.resolveExecutionContext(
      context,
      "transaction"
    );
    // Queue top-level transactions on single-connection drivers so concurrent
    // callers serialize instead of colliding on the shared connection. Nested
    // transaction-bound drivers use their own savepoint queue.
    const queued = this.serializeTransactions && !this.inTransaction;
    if (queued) {
      this.assertBaseOperationAllowedDuringTransaction(executionContext);
    }
    // This queue wait is exactly what `maxWait` bounds on serialized drivers:
    // a bounded-out transaction never reaches BEGIN, so nothing to roll back.
    const maxWaitMs =
      plan?.maxWaitMode === "queue" ? plan.maxWaitMs : undefined;
    const wait = connectionQueueWait(maxWaitMs, {
      driverName: this.driverName,
      form: "callback",
    });
    const executeTransaction = (
      transactionContext: QueryExecutionContext,
      gate?: OfficialDriverLifecycleExecutionGate
    ) => {
      const run = () =>
        this.runProviderTransactionCore(fn, plan, transactionContext, gate);
      return queued
        ? this.connectionQueue.enqueue(
            () => this.runConnectionTransactionLease(run),
            wait
          )
        : run();
    };
    return this.hasTrustedObservers(executionContext)
      ? this.observeTransactionLifecycle(
          "transaction",
          executionContext,
          executeTransaction
        )
      : executeTransaction(executionContext);
  }

  /**
   * Execute a function with a transaction-bound driver.
   *
   * This is a convenience method that wraps `_transaction` and provides
   * a `TransactionBoundDriver` to the callback, so all operations
   * automatically execute within the transaction.
   *
   * Drivers without callback-transaction support reject before invoking the
   * callback.
   *
   * @param fn - Callback that receives a transaction-bound driver
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
    options?: TransactionOptions,
    context?: QueryExecutionContext
  ): Promise<T> {
    const plan = this.resolveTransactionOptions(options, "callback");
    const executionContext = this.resolveExecutionContext(
      context,
      "transaction"
    );
    const timeoutMs = plan?.timeoutMs;
    // `timeout` is consumed here rather than forwarded, so `_transaction` does
    // not arm a second timer. This is the layer that can expire safely: when
    // the race rejects, the abandoned body's in-flight statements are still
    // tracked by `txDriver`, and the catch below closes the scope and drains
    // them before the lifecycle issues ROLLBACK and releases the connection.
    const forwardedOptions =
      timeoutMs === undefined ? options : withoutTimeout(options);
    let txDriver: TransactionScopeDriver<TClient, TTransaction> | undefined;
    return this._transaction(
      async (tx) => {
        txDriver = this.createTransactionBoundDriver(tx, executionContext);
        const boundDriver = txDriver;
        const scopedBody = () => this.runTransactionBody(() => fn(boundDriver));
        const runBody = () =>
          timeoutMs === undefined
            ? scopedBody()
            : runWithTransactionTimeout(scopedBody, timeoutMs, {
                driverName: this.driverName,
                form: "callback",
              });
        try {
          const result = await runBody();
          txDriver.closeTransactionScope();
          await txDriver.waitForActiveOperations();
          txDriver.assertTransactionCommittable();
          return result;
        } catch (error) {
          txDriver.closeTransactionScope(error);
          await txDriver.waitForActiveOperations();
          const scopeFailure = txDriver.getTransactionFailure();
          throw scopeFailure && scopeFailure !== error
            ? withSuppressedFailure(error, scopeFailure)
            : error;
        }
      },
      forwardedOptions,
      executionContext
    );
  }

  // ============================================================
  // BATCH EXECUTION
  // ============================================================

  /**
   * Execute multiple prepared queries on the provided client.
   * _executeBatch wraps this in a transaction for transactional drivers.
   * Drivers with native atomic batch support must override this method;
   * Native overrides must preserve the same atomic ordered contract.
   */
  protected async executeBatch<T>(
    client: TClient | TTransaction,
    queries: BatchQuery[],
    context?: QueryExecutionContext,
    _committed?: CommittedBatchNotification,
    _options?: BatchTransactionOptions
  ): Promise<QueryResult<T>[]> {
    const batchContext = context ?? { operation: "executeBatch" };
    const statements: {
      execute(): Promise<QueryResult<T>>;
      cancel(failure: unknown): Promise<QueryResult<T>>;
    }[] = [];
    try {
      // Every transform belongs to its statement observation, but must finish
      // before the first effect: a later transform can change storage checked
      // by an earlier protected assertion in this same atomic batch.
      for (const [statementIndex, query] of queries.entries()) {
        if (!query) continue;
        const statementContext = query.context
          ? this.resolveExecutionContext(
              query.context,
              query.context.operation ?? "executeBatch"
            )
          : batchContext;
        let executionQuery = query;
        let diagnosticParams = this.getBatchDiagnosticParameters(query);
        const normalizeFailure = (error: unknown) =>
          normalizeDriverError(error, {
            driverName: this.driverName,
            dialect: this.dialect,
            model: statementContext.model,
            operation: statementContext.operation,
            correlationId: statementContext.correlationId,
            statementIndex,
            query: executionQuery.sql,
            params: diagnosticParams,
            diagnostics: this.getErrorDisclosure(statementContext),
            forceContext: true,
          });
        statements.push(
          await new Promise<(typeof statements)[number]>((ready, failed) => {
            let resolveResult!: (result: QueryResult<T>) => void;
            let rejectResult!: (failure: unknown) => void;
            const result = new Promise<QueryResult<T>>((resolve, reject) => {
              resolveResult = resolve;
              rejectResult = reject;
            });
            const completion = this.observeTrustedStatement(
              statementContext,
              (gate = ungatedStatementExecution) => {
                executionQuery = this.materializeTrustedBatchQuery(
                  query,
                  statementContext
                );
                diagnosticParams =
                  this.getBatchDiagnosticParameters(executionQuery);
                const { sql, params } = executionQuery;
                const verbatim = isVerbatimBatchQuery(executionQuery);
                ready({
                  execute: async () => {
                    try {
                      resolveResult(
                        await gate.execute(
                          {
                            context: statementContext,
                            forceErrorContext: true,
                            params: diagnosticParams,
                            sql,
                          },
                          () =>
                            this.executeNormalizedStatement(
                              sql,
                              diagnosticParams,
                              statementContext,
                              () =>
                                verbatim
                                  ? this.executeRaw<T>(
                                      client,
                                      sql,
                                      params,
                                      statementContext
                                    )
                                  : this.execute<T>(
                                      client,
                                      sql,
                                      params ?? [],
                                      statementContext
                                    ),
                              true
                            )
                        )
                      );
                    } catch (error) {
                      rejectResult(normalizeFailure(error));
                    }
                    return completion;
                  },
                  cancel: (failure) => {
                    rejectResult(failure);
                    return completion;
                  },
                });
                return result;
              }
            );
            // This handles a transform/readiness failure before the entry is
            // ready, and also observes canceled tail entries without dispatch.
            completion.catch(failed);
          }).catch((failure: unknown) => {
            throw normalizeFailure(failure);
          })
        );
      }
      const results: QueryResult<T>[] = [];
      for (const statement of statements)
        results.push(await statement.execute());
      return results;
    } catch (failure) {
      await Promise.allSettled(
        statements.map((entry) => entry.cancel(failure))
      );
      throw failure;
    }
  }

  /**
   * Public API for batch execution with instrumentation.
   * Uses native batch if supported, otherwise falls back to transaction-wrapped
   * sequential execution. Drivers without either capability reject instead of
   * silently executing non-atomically.
   */
  async _executeBatch<T>(
    queries: BatchQuery[],
    options?: BatchTransactionOptions,
    context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    // Resolved with the batch contract: an array of operations has no
    // interactive window, so only `isolationLevel` is on offer here.
    this.resolveTransactionOptions(options, "batch");
    if (queries.length === 0) {
      return [];
    }
    if (!(this.supportsBatch || this.supportsTransactions)) {
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
    const executionContext = this.resolveExecutionContext(
      context,
      "executeBatch"
    );
    const resultContext = {
      provider: this.driverName,
      operation: executionContext.operation ?? "executeBatch",
    };

    // If driver has native batch support, use it directly.
    // Native batches execute as one driver call, so errors normalize/log once
    // for the whole batch rather than per statement.
    if (this.supportsBatch) {
      if (committed && !this.supportsOrderedCommittedSegments) {
        throw new TransactionError(
          `Driver '${this.driverName}' cannot acknowledge ordered committed segments.`
        );
      }
      const executeNativeBatch = async (
        sourceQueries: readonly BatchQuery[] = queries,
        gate = ungatedStatementExecution
      ) => {
        const {
          queries: batchQueries,
          diagnosticParams,
          members,
        } = prepareAtomicBatch(
          sourceQueries,
          executionContext,
          (params, statementContext) =>
            this.getDiagnosticParameters(
              params,
              statementContext,
              executionContext
            ),
          this.canDiscloseParameters(executionContext)
        );
        const sql = batchQueries.map((query) => query.sql).join("; ");
        const client = await this.getClient(executionContext);
        const executeProvider = async () => {
          try {
            const results = await this.executeBatch<T>(
              client,
              batchQueries,
              executionContext,
              committed,
              options
            );
            assertNormalizedBatchResults(
              results,
              batchQueries.length,
              resultContext
            );
            return results;
          } catch (error) {
            // Attributed to the one member the failure names, when it names
            // exactly one; otherwise to the whole batch.
            const index = findUniqueExecutionContextIndex(error, batchQueries);
            const statement =
              index === undefined ? undefined : batchQueries[index];
            const errorContext = statement?.context ?? executionContext;
            throw normalizeDriverError(error, {
              driverName: this.driverName,
              dialect: this.dialect,
              model: errorContext.model,
              operation: errorContext.operation,
              correlationId: errorContext.correlationId,
              statementIndex: statement ? index : undefined,
              query: statement ? statement.sql : sql,
              params: statement
                ? this.getBatchDiagnosticParameters(statement)
                : diagnosticParams,
              diagnostics: this.getErrorDisclosure(errorContext),
              forceContext: true,
            });
          }
        };
        return gate.execute(
          {
            context: executionContext,
            forceErrorContext: false,
            members,
            params: diagnosticParams,
            sql,
          },
          () =>
            this.executeNormalizedStatement(
              sql,
              diagnosticParams,
              executionContext,
              executeProvider,
              false
            )
        );
      };
      const submitNativeBatch = () =>
        this.observeTrustedBatchStatements(
          queries,
          executionContext,
          executeNativeBatch
        );
      if (this.serializeTransactions && !this.inTransaction) {
        this.assertBaseOperationAllowedDuringTransaction(executionContext);
        return this.connectionQueue.enqueue(
          submitNativeBatch,
          connectionQueueWait(undefined, {
            driverName: this.driverName,
            form: "batch",
          })
        );
      }
      return submitNativeBatch();
    }

    const { queries: batchQueries } = prepareAtomicBatch(
      queries,
      executionContext,
      (params, statementContext) =>
        this.getDiagnosticParameters(
          params,
          statementContext,
          executionContext
        ),
      this.canDiscloseParameters(executionContext)
    );

    // No native batch, so this driver supports transactions (refused above
    // otherwise): run the batch inside the open one, or wrap it in a new one.
    // The batch options travel with a new transaction so `isolationLevel`
    // applies to the transaction the batch runs inside.
    const runSequentialBatch = async (client: TClient | TTransaction) => {
      const results = await this.executeBatch<T>(
        client,
        batchQueries,
        executionContext
      );
      assertNormalizedBatchResults(results, batchQueries.length, resultContext);
      return results;
    };
    return this.inTransaction
      ? runSequentialBatch(await this.getClient(executionContext))
      : this._transaction(runSequentialBatch, options, executionContext);
  }

  protected transactionCleanupFailed(error: Error): void {
    this.transactionPoisonError ??= error;
  }
}
