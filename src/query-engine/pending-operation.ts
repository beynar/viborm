/**
 * Deferred operation lifecycle owned by the query engine.
 * Validation, SQL construction, and execution remain lazy until a lifecycle
 * method is called. Every operation is served by the single (V2) engine.
 */

import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { InvalidTransactionInputError } from "@errors";
import { lookupResolvedExtensionHandlers } from "@extensions/chain";
import { observeOperation } from "@extensions/observation";
import {
  executePreparedQuery,
  retainWriteOutcomeFailure,
  type WriteOutcomeRegistration,
} from "@extensions/query";
import type { AnyModel } from "@schema/model";
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
  createRoutedCacheResultCodec,
  executeRoutedOperation,
  isReadOperation,
  ROUTED_OPERATIONS,
} from "../query-engine/write-engine/routing";
import { isCacheManagedExecution } from "./cache-flow";
import {
  createPendingOperationContext,
  createPendingOperationInstrumentationFacts,
  type OperationExecutionContext,
  observeTransactionBatchPhase,
} from "./execution-context";
import { PendingExecution } from "./pending-execution";
import type { QueryEngine } from "./query-engine";
import { snapshotQueryInput } from "./query-inspection";
import type { CacheResultCodec } from "./result/cache-result-codec";
import {
  registerTransactionOperationOwner,
  type TransactionOperation,
  type TransactionOperationOwner,
} from "./transaction-operation";
import { type Operation, type PrepareOptions, QueryEngineError } from "./types";

export const PENDING_OPERATION_SYMBOL = Symbol.for("viborm.pendingOperation");

type PendingCacheExecution<T> = (
  execute: (
    driver?: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ) => Promise<T>,
  driverOverride: AnyDriver | undefined
) => Promise<T>;

type AttachPendingCacheExecution = <T>(
  operation: PendingOperation<T>,
  wrapper: PendingCacheExecution<T>
) => PendingOperation<T>;

interface PendingCacheResultAccess {
  readonly args: Record<string, unknown>;
  readonly codec: CacheResultCodec;
  readonly executionContext: QueryExecutionContext;
}

type ReadPendingCacheResult = (
  operation: PendingOperation<unknown>
) => PendingCacheResultAccess;

let attachPendingCacheExecutionFriend: AttachPendingCacheExecution;
let readPendingCacheResultFriend: ReadPendingCacheResult;

type DeferredExecution<T> = (
  driverOverride?: AnyDriver,
  committedWriteSegment?: CommittedWriteSegmentNotification,
  writeMayBeVisible?: WriteMayBeVisibleNotification
) => Promise<T>;

function combineWriteNotifications(
  first: (() => Promise<void>) | undefined,
  second: (() => Promise<void>) | undefined
): (() => Promise<void>) | undefined {
  if (first === undefined) return second;
  if (second === undefined || second === first) return first;
  return async () => {
    let firstFailed = false;
    let firstFailure: unknown;
    try {
      await first();
    } catch (error) {
      firstFailed = true;
      firstFailure = error;
    }
    try {
      await second();
    } catch (error) {
      if (firstFailed) {
        throw retainWriteOutcomeFailure(
          firstFailure,
          error,
          "Write publication callbacks both failed."
        );
      }
      throw error;
    }
    if (firstFailed) throw firstFailure;
  };
}

/** Client-owned work that must finish before operation construction starts. */
export type PrepareOperationInput = () => Record<string, unknown>;

/** Package-owned write listener prepared only after the operation input is trusted. */
export type PrepareWriteOutcomeRegistration = (
  context: QueryExecutionContext
) => WriteOutcomeRegistration | undefined;

interface OperationInputPreparation {
  readonly prepare: PrepareOperationInput;
  status: "pending" | "success" | "failure";
  args?: Record<string, unknown>;
  error?: unknown;
}

interface OperationResolution {
  operation?: RoutedExecutableOperation;
}

type ResolvedPrepareOptions = Readonly<
  PrepareOptions & { readonly originalOperation: string }
>;

const OR_THROW_SUFFIX = "OrThrow";
const pendingOperationConstruction = Object.freeze({});

type CreatePendingOperation = <T>(
  engine: QueryEngine,
  model: AnyModel,
  operation: Operation | `${Operation}OrThrow`,
  args: Record<string, unknown>,
  options?: PrepareOptions,
  operationExecutor?: OperationExecutor,
  prepareInput?: PrepareOperationInput,
  prepareWriteOutcomeRegistration?: PrepareWriteOutcomeRegistration
) => PendingOperation<T>;

let createPendingOperationFriend: CreatePendingOperation;

let pendingOperationTransactionOwner: TransactionOperationOwner<
  PendingOperation<unknown>
>;

/** One user operation, from lazy creation through execution and parsing. */
export class PendingOperation<T> implements TransactionOperation<T> {
  readonly [PENDING_OPERATION_SYMBOL] = true;
  readonly #context: OperationExecutionContext;
  readonly #engine: QueryEngine;
  readonly #model: AnyModel;
  readonly #args: Record<string, unknown>;
  readonly #modelName: string;
  readonly #operation: Operation;
  readonly #options: ResolvedPrepareOptions;

  readonly #execution: PendingExecution<T>;
  readonly #deferredExecution: DeferredExecution<T> | undefined;
  readonly #inputPreparation: OperationInputPreparation | undefined;
  readonly #prepareWriteOutcomeRegistration:
    | PrepareWriteOutcomeRegistration
    | undefined;
  #writeOutcomeRegistration: WriteOutcomeRegistration | undefined;
  #writeOutcomeRegistrationResolved = false;
  #operationResolution: OperationResolution | undefined;
  #observationCommitCertainty: "committed" | "may-have-committed" | undefined;

  // The V2 operation for this payload, constructed once (lazily, before any I/O).
  #operationInstance: RoutedExecutableOperation | undefined;
  #operationResolved = false;
  readonly #operationExecutor: OperationExecutor;
  // The single-statement plan, memoized: `null` uncomputed, `undefined` when the
  // operation is multi-statement (runs through the atomic-batch seam).
  #singlePlan: SingleStatementCandidate | undefined | null = null;

  static {
    createPendingOperationFriend = <T>(
      engine: QueryEngine,
      model: AnyModel,
      operation: Operation | `${Operation}OrThrow`,
      args: Record<string, unknown>,
      options?: PrepareOptions,
      operationExecutor?: OperationExecutor,
      prepareInput?: PrepareOperationInput,
      prepareWriteOutcomeRegistration?: PrepareWriteOutcomeRegistration
    ) =>
      new PendingOperation<T>(
        pendingOperationConstruction,
        engine,
        model,
        operation,
        args,
        options,
        undefined,
        undefined,
        operationExecutor,
        prepareInput === undefined
          ? undefined
          : { prepare: prepareInput, status: "pending" },
        undefined,
        prepareWriteOutcomeRegistration
      );
    attachPendingCacheExecutionFriend = (operation, wrapper) =>
      operation.#wrapExecution(wrapper);
    readPendingCacheResultFriend = (operation) => ({
      args: operation.cacheKeyArgs(),
      codec: createRoutedCacheResultCodec(operation.#resolveOperation()),
      executionContext: operation.#context.attribution,
    });
    pendingOperationTransactionOwner = Object.freeze({
      clientId: (operation) => operation.#context.clientId,
      scopeId: (operation) => operation.#context.scopeId,
      model: (operation) => operation.#modelName,
      operation: (operation) => operation.#operation,
      context: (operation) => operation.#context.attribution,
      requiresInterception: (operation) => {
        const requestedOperation = String(operation.#options.originalOperation);
        const requestHandlers = lookupResolvedExtensionHandlers(
          operation.#engine.extensionChain,
          "request",
          operation.#modelName,
          requestedOperation
        );
        const hasRequestHandlers =
          requestHandlers !== undefined && requestHandlers.length > 0;
        const requestNeedsObservedCoordination =
          hasRequestHandlers &&
          (operation.#engine.extensionChain?.observe.length ?? 0) > 0;
        const queryHandlers = lookupResolvedExtensionHandlers(
          operation.#engine.extensionChain,
          "query",
          operation.#modelName,
          requestedOperation
        );
        return (
          requestNeedsObservedCoordination ||
          (queryHandlers !== undefined && queryHandlers.length > 0) ||
          operation.#prepareWriteOutcomeRegistration !== undefined
        );
      },
      prepareAdmission: (operation) => {
        operation.#resolveOperation();
      },
      stagePackageWriteOutcomes: (operation, outcomes) => {
        const registration = operation.#resolveWriteOutcomeRegistration();
        if (registration !== undefined) outcomes.stage(registration);
      },
      startInterception: (operation, child, outcomes, control) => {
        const requestedOperation = String(operation.#options.originalOperation);
        const handlers = lookupResolvedExtensionHandlers(
          operation.#engine.extensionChain,
          "query",
          operation.#modelName,
          requestedOperation
        );
        const preparedOperation = operation.#resolveOperation();
        const writeOutcomeRegistration =
          operation.#resolveWriteOutcomeRegistration();
        if (
          (handlers === undefined || handlers.length === 0) &&
          writeOutcomeRegistration === undefined
        ) {
          return child();
        }
        const queryContext =
          handlers === undefined || handlers.length === 0
            ? undefined
            : Object.freeze({
                mode: "array" as const,
                kind: "model" as const,
                model: operation.#modelName,
                operation: requestedOperation,
                input: snapshotQueryInput(preparedOperation.validatedArgs),
              });
        return executePreparedQuery<unknown, Record<string, unknown>>(
          queryContext,
          handlers,
          child,
          !isReadOperation(requestedOperation),
          outcomes,
          control,
          writeOutcomeRegistration
        );
      },
      executeCore: (operation, driver, notifications) =>
        operation.#execution.executeReserved(() =>
          operation.#runCoreExecution(
            driver,
            notifications?.committed,
            notifications?.mayHaveCommitted
          )
        ),
      isWrite: (operation) =>
        !isReadOperation(String(operation.#options.originalOperation)),
      hasObservation: (operation) =>
        (operation.#engine.extensionChain?.observe.length ?? 0) > 0,
      observe: (operation, child, readCompletionFacts) => {
        const observers = operation.#engine.extensionChain?.observe;
        if (observers === undefined || observers.length === 0) return child();
        return observeOperation(
          observers,
          String(operation.#options.originalOperation),
          operation.#modelName,
          child,
          readCompletionFacts,
          operation.#readInstrumentationFacts()
        );
      },
      reserveWith: (operation, driver) => {
        operation.#execution.reserveWith(driver);
      },
      executeWith: (operation, driver) => {
        const observers = operation.#engine.extensionChain?.observe;
        if (observers === undefined || observers.length === 0) {
          return operation.#execution.executeWith(driver, () =>
            operation.#runCoreExecution(driver)
          );
        }
        return operation.#execution.executeWith(driver, () =>
          observeOperation(
            observers,
            String(operation.#options.originalOperation),
            operation.#modelName,
            () => operation.#runCoreExecution(driver),
            () =>
              operation.#observationCommitCertainty === undefined
                ? undefined
                : {
                    commitCertainty: operation.#observationCommitCertainty,
                  },
            operation.#readInstrumentationFacts()
          )
        );
      },
      prepare: (operation, driver = operation.#engine.driver) => {
        const single = operation.#resolveSinglePlan();
        if (!single) return undefined;
        return operation.#operationExecutor.prepareSingleStatement(
          single,
          driver,
          operation.#context.attribution
        );
      },
      prepareBatch: (operation, driver = operation.#engine.driver) =>
        operation.#operationExecutor.prepareSharedBatch<unknown>(
          operation.#resolveOperation(),
          driver,
          operation.#context.attribution,
          operation.#operation
        ),
      parseResult: (operation, raw) => {
        const resolvedOperation = operation.#resolveOperation();
        if (isRecordSeries(resolvedOperation)) {
          throw new QueryEngineError(
            `Operation '${operation.#operation}' on model '${operation.#modelName}' runs as a transactional record series and parses no single driver result.`
          );
        }
        const single = operation.#resolveSinglePlan();
        if (single) {
          return operation.#operationExecutor.parseSingleStatement<unknown>(
            resolvedOperation,
            single,
            raw
          );
        }
        return resolvedOperation.parse<unknown>({ result: raw.rows });
      },
      observeBatchPhase: (operation, driver, execute) =>
        observeTransactionBatchPhase(
          operation.#context.attribution,
          driver,
          execute
        ),
    } satisfies TransactionOperationOwner<PendingOperation<unknown>>);
    registerTransactionOperationOwner(
      PendingOperation.prototype,
      (value): value is PendingOperation<unknown> => #context in value,
      pendingOperationTransactionOwner
    );
    Object.freeze(PendingOperation.prototype);
  }

  private constructor(
    construction: typeof pendingOperationConstruction,
    engine: QueryEngine,
    model: AnyModel,
    requestedOperation: Operation | `${Operation}OrThrow`,
    args: Record<string, unknown>,
    options?: PrepareOptions,
    context?: OperationExecutionContext,
    deferredExecution?: DeferredExecution<T>,
    operationExecutor?: OperationExecutor,
    inputPreparation?: OperationInputPreparation,
    operationResolution?: OperationResolution,
    prepareWriteOutcomeRegistration?: PrepareWriteOutcomeRegistration
  ) {
    if (construction !== pendingOperationConstruction) {
      throw new InvalidTransactionInputError();
    }
    this.#engine = engine;
    this.#model = model;
    this.#args = args;
    this.#deferredExecution = deferredExecution;
    this.#inputPreparation = inputPreparation;
    this.#prepareWriteOutcomeRegistration = prepareWriteOutcomeRegistration;
    this.#operationResolution = operationResolution;
    this.#operationExecutor =
      operationExecutor ?? new OperationExecutor(engine);
    const isOrThrow = requestedOperation.endsWith(OR_THROW_SUFFIX);
    this.#operation = isOrThrow
      ? (requestedOperation.slice(0, -OR_THROW_SUFFIX.length) as Operation)
      : (requestedOperation as Operation);
    this.#modelName = model["~"].names.ts ?? "unknown";
    this.#execution = new PendingExecution<T>(this.#modelName, this.#operation);
    this.#options = Object.freeze({
      ...options,
      throwIfNotFound: isOrThrow || options?.throwIfNotFound,
      originalOperation: options?.originalOperation ?? requestedOperation,
    });
    this.#context =
      context ??
      createPendingOperationContext(
        this.#modelName,
        this.#operation,
        engine.instrumentation,
        engine.clientId,
        engine.scopeId,
        engine.extensionChain
      );
    Object.freeze(this);
  }

  /** Resolve client request preparation once, caching both values and throws. */
  #resolveArgs(): Record<string, unknown> {
    const preparation = this.#inputPreparation;
    if (preparation === undefined) return this.#args;
    if (preparation.status === "success" && preparation.args) {
      return preparation.args;
    }
    if (preparation.status === "failure") throw preparation.error;

    try {
      const args = preparation.prepare();
      preparation.args = args;
      preparation.status = "success";
      return args;
    } catch (error) {
      preparation.error = error;
      preparation.status = "failure";
      throw error;
    }
  }

  /** Resolve one exact package-owned listener for every lifecycle entry point. */
  #resolveWriteOutcomeRegistration(): WriteOutcomeRegistration | undefined {
    if (this.#writeOutcomeRegistrationResolved) {
      return this.#writeOutcomeRegistration;
    }
    this.#writeOutcomeRegistration = this.#prepareWriteOutcomeRegistration?.(
      this.#context.attribution
    );
    this.#writeOutcomeRegistrationResolved = true;
    return this.#writeOutcomeRegistration;
  }

  /**
   * Construct (once) the V2 operation for this payload. Routing is decided here —
   * lazily, before any I/O — so a validation error surfaces at execution time
   * exactly as intended, never synchronously at client-dispatch time. Every client
   * operation family constructs; a name outside the routed set (unreachable through
   * the typed client, reachable through an untyped call or a removed method name)
   * is a loud "unknown operation" error rather than a silent no-op.
   */
  #resolveOperation(): RoutedExecutableOperation {
    const sharedOperation = this.#operationResolution?.operation;
    if (sharedOperation) return sharedOperation;
    if (this.#operationResolved && this.#operationInstance) {
      return this.#operationInstance;
    }
    const operation = constructRoutedOperation(
      this.#engine,
      this.#model,
      this.#options.originalOperation,
      this.#resolveArgs()
    );
    if (!operation) {
      // The model proxy answers every property with a callable child, so a
      // misspelled or REMOVED operation name (`createManyAndReturn`,
      // `updateManyAndReturn` — see the implicit-returning surface) reaches here
      // instead of failing as "undefined is not a function". Name it as what it
      // is: an unknown operation, listing the surface it is missing from.
      throw new QueryEngineError(
        `Unknown operation '${this.#operation}' on model '${this.#modelName}'. Known operations: ${[...ROUTED_OPERATIONS].sort().join(", ")}.`
      );
    }
    this.#operationInstance = operation;
    this.#operationResolved = true;
    if (this.#operationResolution) {
      this.#operationResolution.operation = operation;
    }
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
  #statementOperation(): ExecutableOperation | undefined {
    const operation = this.#resolveOperation();
    return isRecordSeries(operation) ? undefined : operation;
  }

  #executor(): OperationExecutor {
    return this.#operationExecutor;
  }

  /**
   * The single-statement plan for this operation, memoized. `undefined` means the
   * operation is multi-statement (it uses the atomic-batch seam instead).
   */
  #resolveSinglePlan(): SingleStatementCandidate | undefined {
    if (this.#singlePlan !== null) return this.#singlePlan;
    this.#singlePlan = this.#executor().singleStatementPlan(
      this.#resolveOperation()
    );
    return this.#singlePlan;
  }

  #getPromise(): Promise<T> {
    return this.#execution.executeDefault(() => {
      const observers = this.#engine.extensionChain?.observe;
      if (observers === undefined || observers.length === 0) {
        return this.#runExecution();
      }
      return observeOperation(
        observers,
        String(this.#options.originalOperation),
        this.#modelName,
        () => this.#runExecution(),
        () =>
          this.#observationCommitCertainty === undefined
            ? undefined
            : { commitCertainty: this.#observationCommitCertainty },
        this.#readInstrumentationFacts()
      );
    });
  }

  #readInstrumentationFacts() {
    return createPendingOperationInstrumentationFacts(
      this.#engine.driver,
      this.#context.attribution,
      this.#modelName,
      String(this.#options.originalOperation),
      String(this.#operation),
      this.#model["~"].names.sql ?? this.#modelName,
      isCacheManagedExecution(this.#options)
    );
  }

  #runExecution(
    driverOverride?: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    const observerCommitted = this.#observationNotification("committed");
    const observerMayHaveCommitted =
      this.#observationNotification("may-have-committed");
    const requestedOperation = String(this.#options.originalOperation);
    const handlers = lookupResolvedExtensionHandlers(
      this.#engine.extensionChain,
      "query",
      this.#modelName,
      requestedOperation
    );
    if (
      (handlers === undefined || handlers.length === 0) &&
      this.#prepareWriteOutcomeRegistration === undefined
    ) {
      return this.#runCoreExecution(
        driverOverride,
        combineWriteNotifications(committedWriteSegment, observerCommitted),
        combineWriteNotifications(writeMayBeVisible, observerMayHaveCommitted)
      );
    }
    let preparedOperation: RoutedExecutableOperation;
    try {
      preparedOperation = this.#resolveOperation();
    } catch (error) {
      return Promise.reject(error);
    }
    const writeOutcomeRegistration = this.#resolveWriteOutcomeRegistration();
    if (
      (handlers === undefined || handlers.length === 0) &&
      writeOutcomeRegistration === undefined
    ) {
      return this.#runCoreExecution(
        driverOverride,
        combineWriteNotifications(committedWriteSegment, observerCommitted),
        combineWriteNotifications(writeMayBeVisible, observerMayHaveCommitted)
      );
    }
    const context =
      handlers === undefined || handlers.length === 0
        ? undefined
        : Object.freeze({
            mode: this.#engine.transactionWriteOutcomes
              ? ("transaction" as const)
              : ("direct" as const),
            kind: "model" as const,
            model: this.#modelName,
            operation: requestedOperation,
            input: snapshotQueryInput(preparedOperation.validatedArgs),
          });
    return executePreparedQuery<T, Record<string, unknown>>(
      context,
      handlers,
      (notifications) =>
        this.#runCoreExecution(
          driverOverride,
          combineWriteNotifications(
            committedWriteSegment,
            combineWriteNotifications(
              notifications?.committed,
              observerCommitted
            )
          ),
          combineWriteNotifications(
            writeMayBeVisible,
            combineWriteNotifications(
              notifications?.mayHaveCommitted,
              observerMayHaveCommitted
            )
          )
        ),
      !isReadOperation(requestedOperation),
      this.#engine.transactionWriteOutcomes,
      undefined,
      writeOutcomeRegistration
    );
  }

  #observationNotification(
    certainty: "committed" | "may-have-committed"
  ): (() => Promise<void>) | undefined {
    if (
      this.#engine.transactionWriteOutcomes !== undefined ||
      (this.#engine.extensionChain?.observe.length ?? 0) === 0
    ) {
      return undefined;
    }
    return async () => {
      if (
        certainty === "committed" ||
        this.#observationCommitCertainty === undefined
      ) {
        this.#observationCommitCertainty = certainty;
      }
    };
  }

  #runCoreExecution(
    driverOverride?: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    if (this.#deferredExecution) {
      return this.#deferredExecution(
        driverOverride,
        committedWriteSegment,
        writeMayBeVisible
      );
    }
    return this.#run(driverOverride, committedWriteSegment, writeMayBeVisible);
  }

  #run(
    driverOverride?: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    let operation: RoutedExecutableOperation;
    try {
      operation = this.#resolveOperation();
    } catch (error) {
      return Promise.reject(error);
    }
    return executeRoutedOperation<T>(
      this.#executor(),
      operation,
      this.#context.attribution,
      driverOverride,
      committedWriteSegment,
      writeMayBeVisible
    );
  }

  getArgs(): Record<string, unknown> {
    return this.#args;
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
   * families are cacheable. Routed writes also carry their canonical validated
   * payload for request and query inspection, but this cache-only seam never
   * publishes it; scalar and record-series writes share the same refusal.
   */
  cacheKeyArgs(): Record<string, unknown> {
    const validated = isReadOperation(this.#operation)
      ? this.#statementOperation()?.validatedArgs
      : undefined;
    if (!validated) {
      throw new QueryEngineError(
        `Operation '${this.#operation}' on model '${this.#modelName}' exposes no validated payload to key a cache entry on.`
      );
    }
    return validated;
  }

  /**
   * The one SQL statement this operation compiles to, or `undefined` when it is
   * multi-statement (backs {@link QueryEngine.build}). Unlike the cache/array-batch
   * `prepare()` seam this permits a postcondition — a returning-driver
   * create/update/delete is one `… RETURNING` statement whose exactly-one-row
   * assertion is enforced after execution, and `build()` still wants its SQL.
   */
  buildStatement(): Sql | undefined {
    return this.#executor().buildStatement(this.#resolveOperation());
  }

  #wrapExecution(wrapper: PendingCacheExecution<T>): PendingOperation<T> {
    const operationResolution =
      this.#operationResolution ??
      (this.#operationResolution = { operation: this.#operationInstance });
    const deferredExecution: DeferredExecution<T> = (
      driverOverride,
      outerCommittedWriteSegment,
      outerWriteMayBeVisible
    ) =>
      wrapper(
        (driver, committedWriteSegment, writeMayBeVisible) =>
          this.#runCoreExecution(
            driver ?? driverOverride,
            combineWriteNotifications(
              committedWriteSegment,
              outerCommittedWriteSegment
            ),
            combineWriteNotifications(writeMayBeVisible, outerWriteMayBeVisible)
          ),
        driverOverride
      );
    return new PendingOperation(
      pendingOperationConstruction,
      this.#engine,
      this.#model,
      this.#operation,
      this.#args,
      this.#options,
      this.#context,
      deferredExecution,
      this.#operationExecutor,
      this.#inputPreparation,
      operationResolution,
      this.#prepareWriteOutcomeRegistration
    );
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.#getPromise().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T | TResult> {
    return this.#getPromise().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.#getPromise().finally(onfinally);
  }
}

/** Create one genuine operation without exposing its construction identity. */
export function createPendingOperation<T>(
  engine: QueryEngine,
  model: AnyModel,
  operation: Operation | `${Operation}OrThrow`,
  args: Record<string, unknown>,
  options?: PrepareOptions,
  operationExecutor?: OperationExecutor,
  prepareInput?: PrepareOperationInput,
  prepareWriteOutcomeRegistration?: PrepareWriteOutcomeRegistration
): PendingOperation<T> {
  return createPendingOperationFriend(
    engine,
    model,
    operation,
    args,
    options,
    operationExecutor,
    prepareInput,
    prepareWriteOutcomeRegistration
  );
}

/** Place the official cache child inside arbitrary query interception. */
export function attachPendingCacheExecution<T>(
  operation: PendingOperation<T>,
  wrapper: PendingCacheExecution<T>
): PendingOperation<T> {
  return attachPendingCacheExecutionFriend(operation, wrapper);
}

/** Internal cache reader; resolves the operation-owned canonical payload once. */
export function readPendingCacheResult(
  operation: PendingOperation<unknown>
): PendingCacheResultAccess {
  return readPendingCacheResultFriend(operation);
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
