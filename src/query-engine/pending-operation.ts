/**
 * Deferred operation lifecycle owned by the query engine.
 * Validation, SQL construction, and execution remain lazy until a lifecycle
 * method is called. Every operation is served by the single (V2) engine.
 */

import type { AnyDriver, QueryExecutionContext } from "@drivers";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import type {
  CommittedWriteSegmentNotification,
  ExecutableOperation,
  SingleStatementCandidate,
  WriteMayBeVisibleNotification,
} from "../query-engine/write-engine/OperationExecutor";
import { OperationExecutor } from "../query-engine/write-engine/OperationExecutor";
import {
  isRecordSeries,
  type RoutedExecutableOperation,
} from "../query-engine/write-engine/record-series";
import {
  constructRoutedOperation,
  executeRoutedOperation,
  ROUTED_OPERATIONS,
} from "../query-engine/write-engine/routing";
import {
  createPendingOperationContext,
  type OperationExecutionContext,
  observeOperationExecution,
  observeTransactionBatchPhase,
} from "./execution-context";
import { PendingExecution } from "./pending-execution";
import type { QueryEngine } from "./query-engine";
import {
  TRANSACTION_OPERATION_SYMBOL,
  type TransactionOperation,
} from "./transaction-operation";
import {
  isBatchOperation,
  type Operation,
  type PreparedBatchOperation,
  type PreparedQuery,
  type PrepareOptions,
  QueryEngineError,
} from "./types";

export const PENDING_OPERATION_SYMBOL = Symbol.for("viborm.pendingOperation");

type ExecutionWrapper<T> = (
  execute: (
    driver?: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ) => Promise<T>
) => Promise<T>;

type DeferredExecution<T> = (
  driverOverride?: AnyDriver,
  committedWriteSegment?: CommittedWriteSegmentNotification,
  writeMayBeVisible?: WriteMayBeVisibleNotification
) => Promise<T>;

const OR_THROW_SUFFIX = "OrThrow";

/** One user operation, from lazy creation through execution and parsing. */
export class PendingOperation<T> implements TransactionOperation<T> {
  readonly [PENDING_OPERATION_SYMBOL] = true;
  readonly [TRANSACTION_OPERATION_SYMBOL] = true;
  readonly engine: QueryEngine;
  readonly model: Model<any>;
  readonly args: Record<string, unknown>;
  readonly modelName: string;
  readonly operation: Operation;
  readonly options: PrepareOptions;
  readonly context: OperationExecutionContext;

  private readonly execution: PendingExecution<T>;
  private readonly deferredExecution: DeferredExecution<T> | undefined;

  // The V2 operation for this payload, constructed once (lazily, before any I/O).
  private operationInstance: RoutedExecutableOperation | undefined;
  private operationResolved = false;
  private readonly operationExecutor: OperationExecutor;
  // The single-statement plan, memoized: `null` uncomputed, `undefined` when the
  // operation is multi-statement (runs through the atomic-batch seam).
  private singlePlan: SingleStatementCandidate | undefined | null = null;

  private constructor(
    engine: QueryEngine,
    model: Model<any>,
    requestedOperation: Operation | `${Operation}OrThrow`,
    args: Record<string, unknown>,
    options?: PrepareOptions,
    context?: OperationExecutionContext,
    deferredExecution?: DeferredExecution<T>,
    operationExecutor?: OperationExecutor
  ) {
    this.engine = engine;
    this.model = model;
    this.args = args;
    this.deferredExecution = deferredExecution;
    this.operationExecutor = operationExecutor ?? new OperationExecutor(engine);
    const isOrThrow = requestedOperation.endsWith(OR_THROW_SUFFIX);
    this.operation = isOrThrow
      ? (requestedOperation.slice(0, -OR_THROW_SUFFIX.length) as Operation)
      : (requestedOperation as Operation);
    this.modelName = model["~"].names.ts ?? "unknown";
    this.execution = new PendingExecution<T>(this.modelName, this.operation);
    this.options = Object.freeze({
      ...options,
      throwIfNotFound: isOrThrow || options?.throwIfNotFound,
      originalOperation: options?.originalOperation ?? requestedOperation,
    });
    this.context =
      context ??
      createPendingOperationContext(
        this.modelName,
        this.operation,
        engine.instrumentation,
        engine.clientId,
        engine.scopeId
      );
  }

  static create<T>(
    engine: QueryEngine,
    model: Model<any>,
    operation: Operation | `${Operation}OrThrow`,
    args: Record<string, unknown>,
    options?: PrepareOptions,
    operationExecutor?: OperationExecutor
  ): PendingOperation<T> {
    return new PendingOperation<T>(
      engine,
      model,
      operation,
      args,
      options,
      undefined,
      undefined,
      operationExecutor
    );
  }

  /**
   * Construct (once) the V2 operation for this payload. Routing is decided here —
   * lazily, before any I/O — so a validation error surfaces at execution time
   * exactly as intended, never synchronously at client-dispatch time. Every client
   * operation family constructs; a name outside the routed set (unreachable through
   * the typed client, reachable through an untyped call or a removed method name)
   * is a loud "unknown operation" error rather than a silent no-op.
   */
  private resolveOperation(): RoutedExecutableOperation {
    if (this.operationResolved && this.operationInstance) {
      return this.operationInstance;
    }
    const operation = constructRoutedOperation(
      this.engine,
      this.model,
      this.options.originalOperation ?? this.operation,
      this.args
    );
    if (!operation) {
      // The model proxy answers every property with a callable child, so a
      // misspelled or REMOVED operation name (`createManyAndReturn`,
      // `updateManyAndReturn` — see the implicit-returning surface) reaches here
      // instead of failing as "undefined is not a function". Name it as what it
      // is: an unknown operation, listing the surface it is missing from.
      throw new QueryEngineError(
        `Unknown operation '${this.operation}' on model '${this.modelName}'. Known operations: ${[...ROUTED_OPERATIONS].sort().join(", ")}.`
      );
    }
    this.operationInstance = operation;
    this.operationResolved = true;
    return operation;
  }

  /**
   * This payload's operation as ONE fragment atom, or `undefined` when it runs as
   * a record series — a form with no single planning phase, no
   * single statement, and no single driver result. The seams that ask the executor
   * (`prepare`, `buildStatement`, `prepareBatch`) hand it the routed operation and
   * let the executor decline; the two seams below read the operation themselves
   * and need the narrower view.
   */
  private statementOperation(): ExecutableOperation | undefined {
    const operation = this.resolveOperation();
    return isRecordSeries(operation) ? undefined : operation;
  }

  private executor(): OperationExecutor {
    return this.operationExecutor;
  }

  /**
   * The single-statement plan for this operation, memoized. `undefined` means the
   * operation is multi-statement (it uses the atomic-batch seam instead).
   */
  private resolveSinglePlan(): SingleStatementCandidate | undefined {
    if (this.singlePlan !== null) return this.singlePlan;
    this.singlePlan = this.executor().singleStatementPlan(
      this.resolveOperation()
    );
    return this.singlePlan;
  }

  private getPromise(): Promise<T> {
    return this.execution.executeDefault(() => this.runExecution());
  }

  private runExecution(
    driverOverride?: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    if (this.deferredExecution) {
      return this.deferredExecution(
        driverOverride,
        committedWriteSegment,
        writeMayBeVisible
      );
    }
    return this.run(driverOverride, committedWriteSegment, writeMayBeVisible);
  }

  /**
   * Execute through the single engine under exactly ONE
   * {@link observeOperationExecution} wrapper, so the instrumentation shape
   * (SPAN_OPERATION, error logging) is uniform. A construction rejection (a
   * `ValidationError`, the own-write preflight, a documented substrate refusal, an
   * `UnsupportedOperationError` for a shape the engine does not express) is
   * surfaced through the same observation wrapper.
   */
  private run(
    driverOverride?: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    let operation: RoutedExecutableOperation;
    try {
      operation = this.resolveOperation();
    } catch (error) {
      return observeOperationExecution(this, () => Promise.reject(error));
    }
    return observeOperationExecution(this, () =>
      executeRoutedOperation<T>(
        this.executor(),
        operation,
        this.context.attribution,
        driverOverride,
        committedWriteSegment,
        writeMayBeVisible
      )
    );
  }

  canBatch(): boolean {
    return true;
  }

  isBatchOperation(): boolean {
    return isBatchOperation(this.operation);
  }

  getArgs(): Record<string, unknown> {
    return this.args;
  }

  /**
   * The payload a cache entry is keyed on: the VALIDATED one, never the
   * caller's.
   *
   * A raw payload may carry an operand callback, and a function has no stable
   * serialization — keying on it would either throw or, worse, key two
   * equivalent calls differently. Validation is what turns the callback into the
   * field reference or fragment it returned, so keying waits for it. That makes
   * a cached read resolve its operation (validate, build SQL) before it can look
   * in the cache, where it previously did so only on a miss; the price buys a
   * key that describes the query that will actually run.
   *
   * Fails loudly rather than falling back to the raw payload: only the read
   * families are cacheable, and only they carry a validated payload. A
   * record series carries none either — it is a write form — and
   * lands on the same refusal by the same absence.
   */
  cacheKeyArgs(): Record<string, unknown> {
    const validated = this.statementOperation()?.validatedArgs;
    if (!validated) {
      throw new QueryEngineError(
        `Operation '${this.operation}' on model '${this.modelName}' exposes no validated payload to key a cache entry on.`
      );
    }
    return validated;
  }

  getModel(): string {
    return this.modelName;
  }

  getOperation(): string {
    return this.operation;
  }

  getExecutionContext(): QueryExecutionContext {
    return this.context.attribution;
  }

  getClientId(): symbol {
    return this.context.clientId;
  }

  getScopeId(): symbol {
    return this.context.scopeId;
  }

  execute(): Promise<T> {
    return this.getPromise();
  }

  executeWith(driver: AnyDriver): Promise<T> {
    return this.execution.executeWith(driver, () => this.runExecution(driver));
  }

  reserveWith(driver: AnyDriver): void {
    this.execution.reserveWith(driver);
  }

  prepare(driver?: AnyDriver): PreparedQuery | undefined {
    // A single-statement operation (every read, plus scalar bulk writes) exposes
    // its one statement through this seam — the cache flow and the array-batch
    // "single" fast path depend on it. A multi-statement (composed) operation
    // returns undefined and uses the atomic-batch seam.
    const single = this.resolveSinglePlan();
    if (!single) return undefined;
    return this.executor().prepareSingleStatement(
      single,
      driver ?? this.engine.driver,
      this.context.attribution
    );
  }

  /**
   * The one SQL statement this operation compiles to, or `undefined` when it is
   * multi-statement (backs {@link QueryEngine.build}). Unlike the cache/array-batch
   * `prepare()` seam this permits a postcondition — a returning-driver
   * create/update/delete is one `… RETURNING` statement whose exactly-one-row
   * assertion is enforced after execution, and `build()` still wants its SQL.
   */
  buildStatement(): Sql | undefined {
    return this.executor().buildStatement(this.resolveOperation());
  }

  async prepareBatch(
    driver?: AnyDriver
  ): Promise<PreparedBatchOperation<T> | undefined> {
    const targetDriver = driver ?? this.engine.driver;
    return this.executor().prepareSharedBatch<T>(
      this.resolveOperation(),
      targetDriver,
      this.context.attribution,
      this.operation
    );
  }

  parseResult(raw: { rows: unknown[]; rowCount: number }): T {
    const operation = this.statementOperation();
    if (!operation) {
      // A record series produced no single driver result to be handed back: its
      // members ran through their own series scope and it parsed them there. The
      // array-batch protocol never gets here (its `prepare` and `prepareBatch`
      // both declined this form, so the merge already refused); a caller reaching
      // it by another route is naming the wrong seam, and says so.
      throw new QueryEngineError(
        `Operation '${this.operation}' on model '${this.modelName}' runs as a transactional record series and parses no single driver result.`
      );
    }
    // parseResult pairs with the single-statement `prepare()` seam (the
    // array-batch "single" path calls prepare then parseResult), so resolve the
    // same plan and map the raw result through the fragment's outputs.
    const single = this.resolveSinglePlan();
    if (single) {
      return this.executor().parseSingleStatement<T>(operation, single, raw);
    }
    return operation.parse<T>({ result: raw.rows });
  }

  /** Attribute native-batch preparation/parsing to this logical operation. */
  async observeBatchPhase<R>(
    driver: AnyDriver,
    execute: () => R | Promise<R>
  ): Promise<R> {
    return observeTransactionBatchPhase(this, driver, execute);
  }

  wrapExecutor(wrapper: ExecutionWrapper<T>): PendingOperation<T> {
    const deferredExecution: DeferredExecution<T> = (
      driverOverride,
      outerCommittedWriteSegment,
      outerWriteMayBeVisible
    ) =>
      wrapper((driver, committedWriteSegment, writeMayBeVisible) =>
        this.runExecution(
          driver ?? driverOverride,
          committedWriteSegment ?? outerCommittedWriteSegment,
          writeMayBeVisible ?? outerWriteMayBeVisible
        )
      );
    return new PendingOperation(
      this.engine,
      this.model,
      this.operation,
      this.args,
      this.options,
      this.context,
      deferredExecution,
      this.operationExecutor
    );
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.getPromise().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T | TResult> {
    return this.getPromise().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.getPromise().finally(onfinally);
  }
}

export function isPendingOperation<T = unknown>(
  value: unknown
): value is PendingOperation<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    PENDING_OPERATION_SYMBOL in value &&
    (value as Record<symbol, unknown>)[PENDING_OPERATION_SYMBOL] === true
  );
}

export type UnwrapPendingOperation<T> =
  T extends PendingOperation<infer U> ? U : T;

export type UnwrapPendingOperations<
  T extends readonly PendingOperation<unknown>[],
> = {
  [K in keyof T]: UnwrapPendingOperation<T[K]>;
};
