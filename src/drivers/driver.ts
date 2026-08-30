/** Driver connection lifecycle and transaction-bound execution surface. */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import {
  ConnectionError,
  FeatureNotSupportedError,
  TransactionError,
  VibORMErrorCode,
} from "@errors";
import { SPAN_CONNECT, SPAN_DISCONNECT } from "@instrumentation/spans";
import type { Sql } from "@sql";
import { ASYNC_DISPOSE, type AsyncDisposeMember } from "./async-dispose";
import type {
  DriverResultParser,
  NestedTransactionObservation,
  OfficialDriverLifecycleExecutionGate,
} from "./driver-instrumentation";
import { DriverTransactionBase } from "./driver-transaction-base";
import { normalizeDriverConnectionError } from "./error-mapping";
import { observePromiseRejection } from "./rejection-observed-promise";
import { SavepointQueue } from "./savepoint-queue";
import { defineImmutableDriverFact } from "./shared/driver-options";
import {
  leasePinnedCommand,
  type PinnedSessionControl,
  type PinnedSessionReservation,
} from "./shared/pinned-session";
import { withSuppressedFailure } from "./shared/suppressed-failure";
import type {
  BatchTransactionOptions,
  TransactionForm,
  TransactionOptionSupport,
  TransactionOptions,
} from "./shared/transaction-options";
import { runSavepoint, runTransactionLifecycle } from "./shared/transactions";
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

    const executeConnect = (gate?: OfficialDriverLifecycleExecutionGate) => {
      return gate === undefined ? doConnect() : gate.execute(doConnect);
    };
    if (this.serializeTransactions && !this.inTransaction) {
      this.assertBaseOperationAllowedDuringTransaction(executionContext);
      if (!hasLifecycleObservers) {
        return this.connectionQueue.enqueue(executeConnect);
      }
      return this.observeTrustedDriverLifecycle(
        "connection",
        executionContext,
        SPAN_CONNECT,
        (gate) => this.connectionQueue.enqueue(() => executeConnect(gate))
      );
    }
    return hasLifecycleObservers
      ? this.observeTrustedDriverLifecycle(
          "connection",
          executionContext,
          SPAN_CONNECT,
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
    const executeDisconnect = async (
      gate?: OfficialDriverLifecycleExecutionGate
    ) => {
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

      const disconnectPromise =
        gate === undefined ? doDisconnect() : gate.execute(doDisconnect);

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
        SPAN_DISCONNECT,
        (gate) => this.connectionQueue.enqueue(() => executeDisconnect(gate))
      );
    }
    return hasLifecycleObservers
      ? this.observeTrustedDriverLifecycle(
          "connection",
          executionContext,
          SPAN_DISCONNECT,
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
   * Its presence is what makes the lease below command-wide across drivers
   * rather than only across one driver's queue. Absent on every provider that
   * reserves a dedicated connection out of a pool: those sessions are already
   * physically apart, and two migration commands on a pool are arbitrated by
   * the real session lock. Present on the single-connection transport whose ONE
   * client a caller may hand to several drivers.
   */
  protected physicalPinnedSession?(): Promise<object>;

  /**
   * Whether this driver can pin a session, answered without reserving one.
   *
   * Migration admission asks this BEFORE any provider work, so an effectful
   * command on a transport with no interactive session refuses before it
   * connects.
   */
  _canPinSession(): boolean {
    return this.pinnedSession !== undefined;
  }

  /**
   * Runs `body` against ONE reserved producer.
   *
   * The view handed to the body is this exact driver with its client pinned to
   * the reservation, so every statement — the lock, the authoritative reads,
   * the DDL, the tracking writes, and the unlock — runs on the same physical
   * session, and a transaction opened inside the body runs on it too instead of
   * acquiring a second pooled connection.
   *
   * The producer is discarded rather than released when the body throws or
   * condemns it: a session whose lock state is unknown must not go back into a
   * pool.
   *
   * On a driver whose one connection IS the session, the whole call is one job
   * of the queue that already owns that connection — see the lease below.
   */
  async _withPinnedSession<T>(
    body: (
      pinned: Driver<TClient, TTransaction>,
      control: PinnedSessionControl
    ) => Promise<T>
  ): Promise<T> {
    const reserve = this.pinnedSession;
    if (reserve === undefined) {
      // Two reachable shapes, one refusal. The shipped migration paths ask
      // `_canPinSession()` at their admission boundary and refuse
      // `DRIVER_NOT_SUPPORTED` before any provider work, so this arm covers
      // what admission cannot see: a caller reaching the driver primitive
      // directly with a custom driver that implements no hook, and a caller
      // reaching it on a view that IS an already-reserved session
      // (`createPinnedSessionView` withdraws the hook).
      throw new FeatureNotSupportedError(
        this.driverName,
        "pinnedSession",
        "No session can be reserved through this driver: either the transport has no interactive session at all, or this view is itself one reserved session and reserving again would take a SECOND connection. A migration lock is session-scoped, so either way it could be released by a different connection — or never released at all."
      );
    }

    const runSession = async (): Promise<T> => {
      const reservation = await reserve.call(this);
      let discarded = false;
      const control: PinnedSessionControl = {
        discard: () => {
          discarded = true;
        },
      };

      let value: T;
      try {
        value = await body(
          this.createPinnedSessionView(reservation.session),
          control
        );
      } catch (bodyFailure) {
        // The body's failure is what the caller asked for and what the command
        // has to report. Awaiting the release in a `finally` made a release
        // rejection REPLACE it — the caller of a reset that dropped half an
        // estate on a dying socket was told only that the producer would not go
        // back. The release still runs, and still condemns the producer; its
        // own failure is recorded beside the body's (§3.5).
        discarded = true;
        try {
          await reservation.release(true);
        } catch (releaseFailure) {
          throw withSuppressedFailure(bodyFailure, releaseFailure);
        }
        throw bodyFailure;
      }
      // Nothing else failed, so a release failure IS the failure.
      await reservation.release(discarded);
      return value;
    };

    // A provider that reserves a DEDICATED connection — `pg`, postgres.js, Bun
    // SQL, MySQL2 — hands back a producer that is already physically apart from
    // everything else its pool is serving, and there is nothing here to lease:
    // two migration commands on a pool are arbitrated by the real session lock,
    // and serializing them on this driver would be a regression.
    //
    // A single-connection driver reserves the connection every other caller
    // shares (plan §3.5: "PGlite — its single client UNDER THE EXISTING DRIVER
    // QUEUE"), so the whole session — the reservation, the acquisition, the
    // decisions, the DDL, the unlock and the release — is ONE job of that queue.
    // Leasing anything narrower lets a second command in between two of this
    // one's statements, and a PostgreSQL session advisory lock is REENTRANT: on
    // one session the second command re-acquires the lock the first is holding
    // instead of waiting for it.
    if (this.serializeTransactions) {
      // Reaching for the originating driver while its one connection is
      // transaction-bound is the refusal this driver already owns for every
      // other operation; here it is what stands between that caller and a wait
      // on its own holder. It is answered BEFORE the lease, not inside it: a
      // driver that waited for a lease another driver holds — on a client whose
      // provider serializes a transaction against every other statement — would
      // wait for a command that cannot finish until this transaction does.
      this.assertBaseOperationAllowedDuringTransaction(
        this.resolveExecutionContext(undefined, "pinnedSession")
      );
      const identify = this.physicalPinnedSession;
      if (identify === undefined) {
        return this.connectionQueue.enqueue(runSession);
      }
      // The queue lease stays: it is what keeps this driver's own statements
      // out of the session. The physical lease is what keeps ANOTHER driver's
      // command out of it — and what refuses one outright when that session's
      // advisory-lock state was condemned, through this driver or any other.
      const session = await identify.call(this);
      return leasePinnedCommand(this.driverName, session, () =>
        this.connectionQueue.enqueue(runSession)
      );
    }
    return runSession();
  }

  /**
   * This driver, viewed with its client pinned to one reserved session.
   *
   * Defined rather than constructed: the view IS the concrete driver for every
   * other purpose — same adapter, same result parser, same capabilities — and
   * only the producer, the queue answer, the transaction owner and the
   * reservation hook differ. The facts it restates are `readonly`, hence
   * `defineProperties`. The transport assertion is forwarded EXACTLY: a pinned
   * session never derives, upgrades, or drops it, exactly as a
   * transaction-bound view does not.
   */
  private createPinnedSessionView(
    session: TClient | TTransaction
  ): Driver<TClient, TTransaction> {
    const view: Driver<TClient, TTransaction> = Object.create(this);
    const support = this.transactionOptionSupport();
    Object.defineProperties(view, {
      client: { value: session, writable: true },
      // `getClient()` returns a present client without consulting `initPromise`,
      // but a pinned view must never be able to start a second connection.
      initPromise: { value: null, writable: true },
      // The lease holds this driver's connection queue for the WHOLE session,
      // so a statement issued THROUGH this view must not wait on that queue: it
      // would be waiting for its own holder. The view is not opting out of
      // serialization — it IS the serialized job, and exclusivity for the whole
      // session is stronger than exclusivity per statement. On a driver that
      // took a dedicated connection there was no queueing here to begin with.
      serializeTransactions: { value: false },
      // §3.5's "one physical producer" made structural: the view IS the
      // reservation, so it has no reservation to give. Without this it
      // inherited the hook and answered `_canPinSession() === true`, and a
      // nested `withLockedMigrationProducer` would have taken a SECOND
      // connection — one that then waits forever on PostgreSQL for the advisory
      // lock the first one holds, or times out on MySQL — instead of refusing.
      pinnedSession: { value: undefined },
      // The provider's own `transaction()` acquires a connection, which is what
      // pinning exists to prevent. A descriptor is how a `protected abstract`
      // member is replaced per-instance; it is also where the transaction
      // handle widens to the session, which is the honest shape here.
      transaction: { value: this.runPinnedTransaction },
      // A driver whose `maxWait` bounds its connection-queue wait ("queue")
      // has nothing left to bound on this view: the lease already holds the
      // queue for the whole session, so accepting the option here would
      // accept a bound it cannot apply. Dedicated-connection drivers keep
      // their own answer.
      transactionOptionSupport: {
        value: (): TransactionOptionSupport =>
          support.maxWait === "queue"
            ? {
                ...support,
                maxWait: "unsupported",
                maxWaitReason:
                  "the pinned session holds the connection queue's lease for its whole duration, so there is no queue wait to bound",
              }
            : support,
      },
      migrationNamespaceAttestation: {
        value: this.migrationNamespaceAttestation,
      },
    });
    return view;
  }

  /**
   * One transaction on the already-reserved session.
   *
   * Every provider's own `transaction()` acquires a connection — that is the
   * behaviour a pinned session exists to prevent — and most of them refuse
   * outright when handed a connection instead of a pool. `BEGIN`/`COMMIT`/
   * `ROLLBACK` on the reserved producer is the one form that means the same
   * thing on every transport admitted to pinning, and it keeps the lock and the
   * transaction on one session.
   */
  protected runPinnedTransaction<T>(
    session: TClient | TTransaction,
    fn: (tx: TClient | TTransaction) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    const statement = async (sql: string) => {
      await this.executeRaw(session, sql, undefined, context);
    };
    return runTransactionLifecycle({
      begin: () => statement("BEGIN"),
      // The session IS the transaction here: there is no second handle to hand
      // out, and a nested `$transaction` on it runs as a SAVEPOINT.
      callback: () => fn(session),
      commit: () => statement("COMMIT"),
      rollback: () => statement("ROLLBACK"),
    });
  }

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
    const executeTransaction = (gate?: OfficialDriverLifecycleExecutionGate) =>
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
