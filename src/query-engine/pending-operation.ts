/**
 * Deferred operation lifecycle owned by the query engine.
 * Validation, SQL construction, and execution remain lazy until a lifecycle
 * method is called. Every operation is served by the single (V2) engine.
 */

import type { AnyDriver, QueryExecutionContext } from "@drivers";
import {
  InvalidTransactionInputError,
  retainWriteOutcomeFailure,
} from "@errors";
import { lookupResolvedExtensionHandlers } from "@extensions/chain";
import { observeOperation } from "@extensions/observation";
import {
  executePreparedQuery,
  type WriteOutcomeRegistration,
} from "@extensions/query";
import type { AnyModel } from "@schema/model";
import type { Sql } from "@sql";
import { type CacheResultCodec, isCacheManagedExecution } from "./cache-flow";
import {
  createPendingOperationContext,
  createPendingOperationInstrumentationFacts,
  type OperationExecutionContext,
  observeTransactionBatchPhase,
} from "./execution-context";
import { PendingExecution } from "./pending-execution";
import type { QueryEngine } from "./query-engine";
import { snapshotQueryInput } from "./query-inspection";
import type {
  ClientOperationRoute,
  RoutedCandidateOperation,
} from "./raptor3/route/client-route";
import { isReadOperation, ROUTED_OPERATIONS } from "./routed-operations";
import {
  registerTransactionOperationOwner,
  type TransactionOperation,
  type TransactionOperationOwner,
} from "./transaction-operation";
import {
  type Operation,
  type PreparedBatchOperation,
  type PrepareOptions,
  QueryEngineError,
} from "./types";

export const PENDING_OPERATION_SYMBOL = Symbol.for("viborm.pendingOperation");

/** Publish a durably committed write segment to the cache and observers. */
export type CommittedWriteSegmentNotification = () => Promise<void>;
/** Conservatively invalidate after dispatch when provider acknowledgement is ambiguous. */
export type WriteMayBeVisibleNotification = () => Promise<void>;

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
  routed?: RoutedCandidateOperation;
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

  // The ONE operation owner (C-01). Every client lineage builds it in
  // `VibORM`'s constructor and `bind()` forwards it, so an operation that was
  // created from a client has one.
  readonly #route: ClientOperationRoute;
  #routedInstance: RoutedCandidateOperation | undefined;
  #singlePackage: PreparedBatchOperation<unknown> | undefined;
  #singlePackageResolved = false;

  static {
    createPendingOperationFriend = <T>(
      engine: QueryEngine,
      model: AnyModel,
      operation: Operation | `${Operation}OrThrow`,
      args: Record<string, unknown>,
      options?: PrepareOptions,
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
      codec: operation.#cacheResultCodec(),
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
        operation.#preparedInput();
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
        const preparedInput = operation.#preparedInput();
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
                input: snapshotQueryInput(preparedInput),
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
      // One preparation answers both arms: the package this operation prepares
      // to synchronously publishes the one query and the parser for its one
      // result. A verb that needs the asynchronous fold publishes no single
      // query, and the array owner asks it for the package instead.
      prepare: (operation) => operation.#resolveSinglePackage()?.queries[0],
      prepareBatch: (operation) =>
        operation.#resolveRouted().prepareBatch(operation.#context.attribution),
      parseResult: (operation, raw) => {
        const single = operation.#resolveSinglePackage();
        if (!single) {
          throw new QueryEngineError(
            `Operation '${operation.#operation}' on model '${operation.#modelName}' publishes no single driver result to parse.`
          );
        }
        return single.parseResult([raw]);
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
    // Every client lineage installs the route in `VibORM`'s constructor and
    // `bind()` forwards it (C-01); an engine built outside that lineage owns no
    // operation path at all.
    this.#route = engine.route as ClientOperationRoute;
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
   * Construct (once) the route's view of this operation. It shares the
   * cache wrapper's resolution object, so a wrapped copy and its source name
   * one operation, exactly as the shipped construction above does.
   */
  #resolveRouted(): RoutedCandidateOperation {
    const shared = this.#operationResolution?.routed;
    if (shared) return shared;
    if (this.#routedInstance) return this.#routedInstance;
    // The model proxy answers every property with a callable child, so a
    // misspelled or REMOVED operation name (`createManyAndReturn`,
    // `updateManyAndReturn` — see the implicit-returning surface) reaches here
    // instead of failing as "undefined is not a function". Name it as what it
    // is, from the one vocabulary owner, before the route is asked for a verb
    // it has no construction path for.
    if (!ROUTED_OPERATIONS.has(this.#operation)) {
      throw new QueryEngineError(
        `Unknown operation '${this.#operation}' on model '${this.#modelName}'. Known operations: ${[...ROUTED_OPERATIONS].sort().join(", ")}.`
      );
    }
    const routed = this.#route.operation(
      this.#model,
      String(this.#options.originalOperation),
      this.#resolveArgs()
    );
    this.#routedInstance = routed;
    if (this.#operationResolution) {
      this.#operationResolution.routed = routed;
    }
    return routed;
  }

  /**
   * The ONE prepared package this operation compiles to when it compiles to
   * exactly one driver query — every read. The route prepares it once and both
   * array-owner arms read it: the query `prepare()` publishes and the parser
   * `parseResult()` applies come from that single preparation, so a member's
   * statement and its decoder cannot describe different queries.
   */
  #resolveSinglePackage(): PreparedBatchOperation<unknown> | undefined {
    if (this.#singlePackageResolved) return this.#singlePackage;
    const prepared = this.#resolveRouted().prepareSingle(
      this.#context.attribution
    );
    this.#singlePackage = prepared?.queries.length === 1 ? prepared : undefined;
    this.#singlePackageResolved = true;
    return this.#singlePackage;
  }

  /**
   * The payload this operation runs: the prepared operation's ONE admission.
   * Resolving it settles request preparation and admits the operation.
   */
  #preparedInput(): Record<string, unknown> {
    return this.#resolveRouted().preparedArgs;
  }

  /** The detached cache representation of this read, from its result owner. */
  #cacheResultCodec(): CacheResultCodec {
    return this.#resolveRouted().cacheResultCodec();
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
    let preparedInput: Record<string, unknown>;
    try {
      preparedInput = this.#preparedInput();
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
            input: snapshotQueryInput(preparedInput),
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

  /**
   * Run this operation through the route. The driver an existing transaction or
   * array owner supplied stays exactly the driver it supplied; this owner opens
   * and closes no scope of its own, and retries nothing here. The engine's four
   * bounded recoveries live inside the route (`raptor3/AGENTS.md`, "Which
   * recovery REPLAYS and which RE-PLANS"); one of them reads `meta.raceable`
   * off the failure to decide whether a premise may be answered by a second
   * attempt.
   */
  #run(
    driverOverride?: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    let routed: RoutedCandidateOperation;
    try {
      routed = this.#resolveRouted();
    } catch (error) {
      return Promise.reject(error);
    }
    return routed.execute<T>({
      committedWriteSegment,
      context: this.#context.attribution,
      driverOverride,
      engineDriver: this.#engine.driver,
      isWrite: !isReadOperation(String(this.#options.originalOperation)),
      writeMayBeVisible,
    });
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
    const validated = this.#cacheKeyPayload();
    if (!validated) {
      throw new QueryEngineError(
        `Operation '${this.#operation}' on model '${this.#modelName}' exposes no validated payload to key a cache entry on.`
      );
    }
    return validated;
  }

  /** The read payload a cache entry is keyed on, from its admitting owner. */
  #cacheKeyPayload(): Record<string, unknown> | undefined {
    if (!isReadOperation(this.#operation)) return undefined;
    return this.#resolveRouted().preparedArgs;
  }

  /**
   * The one SQL statement this operation compiles to, or `undefined` when it
   * does not compile to exactly one (backs {@link QueryEngine.build}).
   *
   * Every read compiles to one statement and publishes it, from the prepared
   * read the execution itself runs — there is no second lowering here. A write
   * answers `undefined`: the engine's only write fold is the asynchronous
   * `prepareBatch()`, which publishes driver-prepared queries rather than an
   * `Sql`, and this accessor is synchronous.
   */
  buildStatement(): Sql | undefined {
    return this.#resolveRouted().buildStatement();
  }

  #wrapExecution(wrapper: PendingCacheExecution<T>): PendingOperation<T> {
    const operationResolution =
      this.#operationResolution ??
      (this.#operationResolution = { routed: this.#routedInstance });
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
  prepareInput?: PrepareOperationInput,
  prepareWriteOutcomeRegistration?: PrepareWriteOutcomeRegistration
): PendingOperation<T> {
  return createPendingOperationFriend(
    engine,
    model,
    operation,
    args,
    options,
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
