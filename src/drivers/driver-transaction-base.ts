/** Transaction and atomic batch orchestration shared by all drivers. */

import { TransactionError } from "@errors";
import { SPAN_TRANSACTION } from "@instrumentation/spans";
import { Sql } from "@sql";
import type { Driver } from "./driver";
import { prepareAtomicBatch } from "./driver-batch-preparation";
import { isVerbatimBatchQuery } from "./driver-batch-query-kind";
import { findUniqueExecutionContextIndex } from "./driver-diagnostics";
import {
  DriverInstrumentationBase,
  type OfficialDriverLifecycleExecutionGate,
  type OfficialStatementExecutionGate,
} from "./driver-instrumentation";
import { normalizeDriverError } from "./error-mapping";
import { appendExecutionTransactionPhases } from "./execution-context";
import {
  assertNormalizedBatchResults,
  assertNormalizedQueryResult,
} from "./normalized-result";
import { registerPreparedStatement } from "./prepared-statement-provenance";
import {
  type BatchTransactionOptions,
  parseTransactionOptions,
  resolveTransactionPlan,
  runWithTransactionTimeout,
  type TransactionForm,
  type TransactionOptionContext,
  type TransactionOptions,
  type TransactionPlan,
  transactionMaxWaitError,
} from "./shared/transaction-options";
import {
  createTransactionCleanupError,
  readTransactionCleanupFailures,
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
  closeTransactionScope(): void;
  waitForActiveOperations(): Promise<void>;
  assertTransactionCommittable(): void;
  getTransactionFailure(): Error | undefined;
}

export abstract class DriverTransactionBase<
  TClient,
  TTransaction,
> extends DriverInstrumentationBase<TClient, TTransaction> {
  protected abstract createTransactionBoundDriver(
    tx: TTransaction,
    context: QueryExecutionContext
  ): TransactionScopeDriver<TClient, TTransaction>;
  protected assertBaseOperationAllowedDuringTransaction(
    context: QueryExecutionContext
  ): void {
    if (!this.isConnectionTransactionActive) return;
    throw new TransactionError(
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
    this.isConnectionTransactionActive = true;
    try {
      return await operation();
    } finally {
      this.isConnectionTransactionActive = false;
    }
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
  async _execute<T = Record<string, unknown>>(
    query: Sql,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const executionContext = this.resolveExecutionContext(context, "execute");
    const hasStatementObservers = this.hasTrustedObservers(executionContext);
    let transformedQuery = hasStatementObservers
      ? undefined
      : this.applyTrustedStatementTransforms(
          query,
          executionContext,
          "execute"
        );
    const executeQuery = async (
      gate?: OfficialStatementExecutionGate
    ): Promise<QueryResult<T>> => {
      transformedQuery ??= this.applyTrustedStatementTransforms(
        query,
        executionContext,
        "execute"
      );
      const sql = this.buildStatement(transformedQuery);
      const executionParams = [...transformedQuery.values];
      const diagnosticParams = this.getDiagnosticParameters(
        executionParams,
        executionContext
      );
      const resultContext = {
        provider: this.driverName,
        operation: executionContext.operation ?? "execute",
      };
      const client = await this.getClient(executionContext);
      const executeProvider = async () => {
        const providerResult = await this.execute<T>(
          client,
          sql,
          executionParams,
          executionContext
        );
        assertNormalizedQueryResult(providerResult, resultContext);
        return providerResult;
      };
      return gate === undefined
        ? this.executeNormalizedStatement(
            sql,
            diagnosticParams,
            executionContext,
            executeProvider,
            true
          )
        : gate.execute(
            {
              context: executionContext,
              diagnosticParams,
              forceErrorContext: true,
              sql,
            },
            executeProvider
          );
    };
    if (!hasStatementObservers) {
      if (this.serializeTransactions && !this.inTransaction) {
        this.assertBaseOperationAllowedDuringTransaction(executionContext);
        return this.connectionQueue.enqueue(executeQuery);
      }
      return executeQuery();
    }
    const executeObserved = () =>
      this.observeTrustedStatement(executionContext, executeQuery);
    if (this.serializeTransactions && !this.inTransaction) {
      this.assertBaseOperationAllowedDuringTransaction(executionContext);
      return this.connectionQueue.enqueue(executeObserved);
    }
    return executeObserved();
  }

  /**
   * Convert a typed Sql fragment into a driver-ready batch query.
   * Query-engine planners use this so dialect placeholders stay driver-owned.
   */
  _prepare(query: Sql, context?: QueryExecutionContext): BatchQuery {
    if (this.hasTrustedObservers(context)) {
      const statement = new Sql([...query.strings], [...query.values]);
      const prepared = {
        sql: this.buildStatement(statement),
        params: [...statement.values],
      };
      registerPreparedStatement(prepared, statement);
      return prepared;
    }
    const transformedQuery = this.applyTrustedStatementTransforms(
      query,
      context,
      "prepare"
    );
    return {
      sql: this.buildStatement(transformedQuery),
      params: transformedQuery.values,
    };
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
    const executeQuery = async (
      gate?: OfficialStatementExecutionGate
    ): Promise<QueryResult<T>> => {
      const executionParams = params ? [...params] : [];
      const diagnosticParams = this.getDiagnosticParameters(
        executionParams,
        executionContext
      );
      const resultContext = {
        provider: this.driverName,
        operation: executionContext.operation ?? "executeRaw",
      };
      const client = await this.getClient(executionContext);
      const executeProvider = async () => {
        const providerResult = await this.executeRaw<T>(
          client,
          sql,
          executionParams,
          executionContext
        );
        assertNormalizedQueryResult(providerResult, resultContext);
        return providerResult;
      };
      return gate === undefined
        ? this.executeNormalizedStatement(
            sql,
            diagnosticParams,
            executionContext,
            executeProvider,
            true
          )
        : gate.execute(
            {
              context: executionContext,
              diagnosticParams,
              forceErrorContext: true,
              sql,
            },
            executeProvider
          );
    };
    if (!this.hasTrustedObservers(executionContext)) {
      if (this.serializeTransactions && !this.inTransaction) {
        this.assertBaseOperationAllowedDuringTransaction(executionContext);
        return this.connectionQueue.enqueue(executeQuery);
      }
      return executeQuery();
    }
    const executeObserved = () =>
      this.observeTrustedStatement(executionContext, executeQuery);
    if (this.serializeTransactions && !this.inTransaction) {
      this.assertBaseOperationAllowedDuringTransaction(executionContext);
      return this.connectionQueue.enqueue(executeObserved);
    }
    return executeObserved();
  }

  /**
   * Execute one provider transaction after public option/context resolution.
   * Queue ownership and protected lifecycle observation remain with callers.
   */
  protected runProviderTransactionCore<T>(
    fn: (tx: TTransaction) => Promise<T>,
    plan: TransactionPlan | undefined,
    executionContext: QueryExecutionContext,
    lifecycleGate?: OfficialDriverLifecycleExecutionGate
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
        this.transactionCleanupFailed(normalizedError);
        throw normalizedError;
      }
    };

    return lifecycleGate === undefined
      ? runTransaction()
      : lifecycleGate.execute(runTransaction);
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
      SPAN_TRANSACTION,
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
    const executionContext = this.resolveExecutionContext(
      context,
      "transaction"
    );
    const hasLifecycleObservers = this.hasTrustedObservers(executionContext);
    const executeTransaction = () =>
      this.runProviderTransactionCore(fn, plan, executionContext);

    // Queue top-level transactions on single-connection drivers so concurrent
    // callers serialize instead of colliding on the shared connection. Nested
    // transaction-bound drivers use their own savepoint queue.
    if (this.serializeTransactions && !this.inTransaction) {
      this.assertBaseOperationAllowedDuringTransaction(executionContext);
      // This queue wait is exactly what `maxWait` bounds on serialized drivers:
      // a bounded-out transaction never reaches BEGIN, so nothing to roll back.
      if (!hasLifecycleObservers) {
        return this.connectionQueue.enqueue(
          () => this.runConnectionTransactionLease(executeTransaction),
          plan?.maxWaitMode === "queue" && plan.maxWaitMs !== undefined
            ? {
                maxWaitMs: plan.maxWaitMs,
                onMaxWaitExceeded: () =>
                  transactionMaxWaitError(plan.maxWaitMs as number, {
                    driverName: this.driverName,
                    form: "callback",
                  }),
              }
            : undefined
        );
      }
      return this.observeTransactionLifecycle(
        "transaction",
        executionContext,
        (transactionContext, gate) =>
          this.connectionQueue.enqueue(
            () =>
              this.runConnectionTransactionLease(() =>
                this.runProviderTransactionCore(
                  fn,
                  plan,
                  transactionContext,
                  gate
                )
              ),
            plan?.maxWaitMode === "queue" && plan.maxWaitMs !== undefined
              ? {
                  maxWaitMs: plan.maxWaitMs,
                  onMaxWaitExceeded: () =>
                    transactionMaxWaitError(plan.maxWaitMs as number, {
                      driverName: this.driverName,
                      form: "callback",
                    }),
                }
              : undefined
          )
      );
    }
    return hasLifecycleObservers
      ? this.observeTransactionLifecycle(
          "transaction",
          executionContext,
          (transactionContext, gate) =>
            this.runProviderTransactionCore(fn, plan, transactionContext, gate)
        )
      : executeTransaction();
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
        const runBody = () =>
          timeoutMs === undefined
            ? fn(boundDriver)
            : runWithTransactionTimeout(() => fn(boundDriver), timeoutMs, {
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
          txDriver.closeTransactionScope();
          await txDriver.waitForActiveOperations();
          const scopeFailure = txDriver.getTransactionFailure();
          if (scopeFailure && scopeFailure !== error) {
            throw createTransactionCleanupError(error, [scopeFailure]);
          }
          throw error;
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
    _committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    const batchContext = context ?? { operation: "executeBatch" };
    const results: QueryResult<T>[] = [];
    for (
      let statementIndex = 0;
      statementIndex < queries.length;
      statementIndex += 1
    ) {
      const query = queries[statementIndex];
      if (!query) continue;
      const statementContext = query.context
        ? this.resolveExecutionContext(
            query.context,
            query.context.operation ?? "executeBatch"
          )
        : batchContext;
      let executionQuery = query;
      let diagnosticParams = this.getBatchDiagnosticParameters(query);
      try {
        if (!this.hasTrustedObservers(statementContext)) {
          const executeStatement = isVerbatimBatchQuery(query)
            ? () =>
                this.executeRaw<T>(
                  client,
                  query.sql,
                  query.params,
                  statementContext
                )
            : () =>
                this.execute<T>(
                  client,
                  query.sql,
                  query.params ?? [],
                  statementContext
                );
          results.push(
            await this.executeNormalizedStatement(
              query.sql,
              diagnosticParams,
              statementContext,
              executeStatement,
              true
            )
          );
          continue;
        }
        results.push(
          await this.observeTrustedStatement(statementContext, (gate) => {
            executionQuery = this.materializeTrustedBatchQuery(
              query,
              statementContext
            );
            diagnosticParams =
              this.getBatchDiagnosticParameters(executionQuery);
            const executeStatement = isVerbatimBatchQuery(executionQuery)
              ? () =>
                  this.executeRaw<T>(
                    client,
                    executionQuery.sql,
                    executionQuery.params,
                    statementContext
                  )
              : () =>
                  this.execute<T>(
                    client,
                    executionQuery.sql,
                    executionQuery.params ?? [],
                    statementContext
                  );
            return gate === undefined
              ? this.executeNormalizedStatement(
                  executionQuery.sql,
                  diagnosticParams,
                  statementContext,
                  executeStatement,
                  true
                )
              : gate.execute(
                  {
                    context: statementContext,
                    diagnosticParams,
                    forceErrorContext: true,
                    sql: executionQuery.sql,
                  },
                  executeStatement
                );
          })
        );
      } catch (error) {
        throw normalizeDriverError(error, {
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
      }
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
      const hasStatementObservers = this.hasTrustedObservers(executionContext);
      const executeNativeBatch = async (
        sourceQueries: readonly BatchQuery[] = queries,
        gate?: OfficialStatementExecutionGate
      ) => {
        const {
          queries: batchQueries,
          diagnosticParams,
          errorLogDetails,
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
              committed
            );
            assertNormalizedBatchResults(
              results,
              batchQueries.length,
              resultContext
            );
            return results;
          } catch (error) {
            const statementIndex = findUniqueExecutionContextIndex(
              error,
              batchQueries
            );
            if (statementIndex !== undefined) {
              const statement = batchQueries[statementIndex];
              if (statement) {
                const statementContext = statement.context ?? executionContext;
                throw normalizeDriverError(error, {
                  driverName: this.driverName,
                  dialect: this.dialect,
                  model: statementContext.model,
                  operation: statementContext.operation,
                  correlationId: statementContext.correlationId,
                  query: statement.sql,
                  params: this.getBatchDiagnosticParameters(statement),
                  diagnostics: this.getErrorDisclosure(statementContext),
                  forceContext: true,
                });
              }
            }
            throw normalizeDriverError(error, {
              driverName: this.driverName,
              dialect: this.dialect,
              model: executionContext.model,
              operation: executionContext.operation,
              correlationId: executionContext.correlationId,
              query: sql,
              params: diagnosticParams,
              diagnostics: this.getErrorDisclosure(executionContext),
              forceContext: true,
            });
          }
        };
        return gate === undefined
          ? this.executeNormalizedStatement(
              sql,
              diagnosticParams,
              executionContext,
              executeProvider,
              false
            )
          : gate.execute(
              {
                context: executionContext,
                diagnosticParams,
                errorLogDetails,
                forceErrorContext: false,
                sql,
              },
              executeProvider
            );
      };
      if (!hasStatementObservers) {
        if (this.serializeTransactions && !this.inTransaction) {
          this.assertBaseOperationAllowedDuringTransaction(executionContext);
          return this.connectionQueue.enqueue(executeNativeBatch);
        }
        return executeNativeBatch();
      }
      const submitNativeBatch = () =>
        this.observeTrustedBatchStatements(
          queries,
          executionContext,
          executeNativeBatch
        );
      if (this.serializeTransactions && !this.inTransaction) {
        this.assertBaseOperationAllowedDuringTransaction(executionContext);
        return this.connectionQueue.enqueue(submitNativeBatch);
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

    // If driver supports transactions, wrap in transaction (or use existing one)
    if (this.supportsTransactions) {
      // If already in a transaction, execute directly within it
      if (this.inTransaction) {
        const client = await this.getClient(executionContext);
        const results = await this.executeBatch<T>(
          client,
          batchQueries,
          executionContext
        );
        assertNormalizedBatchResults(
          results,
          batchQueries.length,
          resultContext
        );
        return results;
      }
      // Otherwise, wrap in a new transaction. The batch options travel with it
      // so `isolationLevel` applies to the transaction the batch runs inside.
      return this._transaction(
        async (tx) => {
          const results = await this.executeBatch<T>(
            tx,
            batchQueries,
            executionContext
          );
          assertNormalizedBatchResults(
            results,
            batchQueries.length,
            resultContext
          );
          return results;
        },
        options,
        executionContext
      );
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

  protected transactionCleanupFailed(error: Error): void {
    this.transactionPoisonError ??= error;
  }
}
