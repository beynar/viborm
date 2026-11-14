/**
 * Deferred operation lifecycle owned by the query engine.
 * Validation, SQL construction, and execution remain lazy until a lifecycle
 * method is called. Every operation is served by the single (V2) engine.
 */

import type { AnyDriver, QueryExecutionContext } from "@drivers/exports";
import {
  InvalidTransactionInputError,
  retainWriteOutcomeFailure,
} from "@errors";
import type { ResolvedOperationHandler } from "@extensions/chain";
import type { AdmittedControls } from "@extensions/controls";
import type { CallOrigin } from "@extensions/origin";
import type {
  PreparedModelQueryContext,
  QueryInterceptionMode,
  WriteOutcomeRegistration,
} from "@extensions/query";
import type { AnyModel } from "@schema/model";
import type { Sql } from "@sql";
import {
  createPendingOperationContext,
  createPendingOperationInstrumentationFacts,
  type OperationExecutionContext,
  observeTransactionBatchPhase,
  withOperationErrorContext,
} from "./execution-context";
import { batchFindUnique } from "./find-unique-batch";
import { PendingExecution } from "./pending-execution";
import type { QueryEngine } from "./query-engine";
import { snapshotQueryInput } from "./query-inspection";
import type { CommandEngine, PreparedOperation } from "./raptor3/commands";
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

/**
 * Client-owned work that must finish before operation construction starts. It
 * receives the arguments without their controls, and the controls admitted
 * from them.
 */
export type PrepareOperationInput = (
  args: Record<string, unknown>,
  controls: AdmittedControls | undefined,
  /** One object per call: what an extension's two moments of it share. */
  call: object
) => Record<string, unknown>;

/** Package-owned write listener prepared only after the operation input is trusted. */
export type PrepareWriteOutcomeRegistration = (
  context: QueryExecutionContext,
  controls: AdmittedControls | undefined,
  call: object | undefined
) => WriteOutcomeRegistration | undefined;

interface OperationInputPreparation extends CallOrigin {
  readonly prepare: PrepareOperationInput;
  status: "pending" | "success" | "failure";
  args?: Record<string, unknown>;
  /** The operation's one admission record, settled with its arguments. */
  controls?: AdmittedControls;
  error?: unknown;
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
export class PendingOperation<T>
  implements Promise<T>, TransactionOperation<T>
{
  readonly [Symbol.toStringTag] = "Promise";
  readonly [PENDING_OPERATION_SYMBOL] = true;
  readonly #context: OperationExecutionContext;
  readonly #engine: QueryEngine;
  readonly #model: AnyModel;
  readonly #args: Record<string, unknown>;
  readonly #modelName: string;
  readonly #operation: Operation;
  readonly #options: ResolvedPrepareOptions;

  readonly #execution: PendingExecution<T>;
  readonly #inputPreparation: OperationInputPreparation | undefined;
  readonly #prepareWriteOutcomeRegistration:
    | PrepareWriteOutcomeRegistration
    | undefined;
  #writeOutcomeRegistration: WriteOutcomeRegistration | undefined;
  #writeOutcomeRegistrationResolved = false;
  #observationCommitCertainty: "committed" | "may-have-committed" | undefined;

  // The ONE operation owner (C-01). Every client lineage builds it in
  // `VibORM`'s constructor and `bind()` forwards it, so an operation that was
  // created from a client has one.
  readonly #route: CommandEngine;
  #routedInstance: PreparedOperation | undefined;
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
        prepareInput === undefined
          ? undefined
          : { prepare: prepareInput, status: "pending" },
        prepareWriteOutcomeRegistration
      );
    pendingOperationTransactionOwner = Object.freeze({
      clientId: (operation) => operation.#context.clientId,
      scopeId: (operation) => operation.#context.scopeId,
      model: (operation) => operation.#modelName,
      operation: (operation) => operation.#operation,
      context: (operation) => operation.#context.attribution,
      requiresInterception: (operation) => {
        const requestedOperation = String(operation.#options.originalOperation);
        const chain = operation.#engine.extensionChain;
        const requestHandlers = chain?.request?.handlers(
          operation.#modelName,
          requestedOperation
        );
        const hasRequestHandlers =
          requestHandlers !== undefined && requestHandlers.length > 0;
        const requestNeedsObservedCoordination =
          hasRequestHandlers && chain?.observation !== undefined;
        const queryHandlers = chain?.query?.handlers(
          operation.#modelName,
          requestedOperation
        );
        return (
          requestNeedsObservedCoordination ||
          (queryHandlers !== undefined && queryHandlers.length > 0) ||
          // A listener resolved as absent (a write no hook concerns) asks
          // for none; one not resolved yet is assumed.
          (operation.#prepareWriteOutcomeRegistration !== undefined &&
            (!operation.#writeOutcomeRegistrationResolved ||
              operation.#writeOutcomeRegistration !== undefined))
        );
      },
      prepareAdmission: (operation, phase = "input") => {
        operation.#preparedInput();
        if (phase === "plan") operation.#resolveSinglePackage();
      },
      stagePackageWriteOutcomes: (operation, outcomes) => {
        const registration = operation.#resolveWriteOutcomeRegistration();
        if (registration !== undefined) outcomes.stage(registration);
      },
      startInterception: (operation, child, outcomes, control) => {
        const requestedOperation = String(operation.#options.originalOperation);
        const chain = operation.#engine.extensionChain;
        const handlers = chain?.query?.handlers(
          operation.#modelName,
          requestedOperation
        );
        const preparedInput = operation.#preparedInput();
        const writeOutcomeRegistration =
          operation.#resolveWriteOutcomeRegistration();
        const coordination = chain?.coordination;
        if (
          coordination === undefined ||
          ((handlers === undefined || handlers.length === 0) &&
            writeOutcomeRegistration === undefined)
        ) {
          return child();
        }
        const queryContext =
          handlers === undefined || handlers.length === 0
            ? undefined
            : operation.#queryContext("array", preparedInput);
        return coordination.executePreparedQuery<
          unknown,
          Record<string, unknown>
        >(
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
        operation.#engine.extensionChain?.observation !== undefined,
      observe: (operation, child, readCompletionFacts) => {
        const observation = operation.#engine.extensionChain?.observation;
        if (observation === undefined) return child();
        return observation.operation(
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
        const observation = operation.#engine.extensionChain?.observation;
        if (observation === undefined) {
          return operation.#execution.executeWith(driver, () =>
            operation.#runCoreExecution(driver)
          );
        }
        return operation.#execution.executeWith(driver, () =>
          observation.operation(
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
      finishResult: (operation, value) =>
        operation.#options.finishResult
          ? operation.#options.finishResult(value)
          : value,
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
    inputPreparation?: OperationInputPreparation,
    prepareWriteOutcomeRegistration?: PrepareWriteOutcomeRegistration
  ) {
    if (construction !== pendingOperationConstruction) {
      throw new InvalidTransactionInputError();
    }
    this.#engine = engine;
    this.#model = model;
    this.#args = args;
    this.#inputPreparation = inputPreparation;
    this.#prepareWriteOutcomeRegistration = prepareWriteOutcomeRegistration;
    // Every client lineage installs the route in `VibORM`'s constructor and
    // `bind()` forwards it (C-01); an engine built outside that lineage owns no
    // operation path at all.
    this.#route = engine.route;
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
    this.#context = createPendingOperationContext(
      this.#modelName,
      this.#operation,
      engine.clientId,
      engine.scopeId,
      engine.extensionChain
    );
    // The call object an extension's moments share is where the words on the
    // call (`key`, `codec`, `database`) find the operation it became.
    if (inputPreparation)
      inputPreparation.of = {
        engine,
        context: this.#context.attribution,
        prepared: () => this.#resolveRouted(),
      };
    Object.freeze(this);
  }

  /**
   * Resolve client request preparation once, caching both values and throws.
   * The operation's controls leave its arguments and are admitted first, so
   * the record is settled with the arguments and no request handler sees one.
   */
  #resolveArgs(): Record<string, unknown> {
    const preparation = this.#inputPreparation;
    if (preparation === undefined) return this.#args;
    if (preparation.status === "success" && preparation.args) {
      return preparation.args;
    }
    if (preparation.status === "failure") throw preparation.error;

    try {
      const admission = this.#engine.extensionChain?.controls?.admit(
        this.#modelName,
        String(this.#options.originalOperation),
        this.#operation,
        this.#args,
        this.#engine.bound
      );
      const args = preparation.prepare(
        admission?.args ?? this.#args,
        admission?.controls,
        preparation
      );
      preparation.args = args;
      preparation.controls = admission?.controls;
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
      this.#context.attribution,
      this.#inputPreparation?.controls,
      this.#inputPreparation
    );
    this.#writeOutcomeRegistrationResolved = true;
    return this.#writeOutcomeRegistration;
  }

  /** Construct (once) the route's view of this operation. */
  #resolveRouted(): PreparedOperation {
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
    const args = this.#resolveArgs();
    // A package-owned listener may tell the engine what to report while it
    // plans (a write hook's upsert arm): it exists before any planning.
    this.#resolveWriteOutcomeRegistration();
    const routed = this.#route.prepare(
      this.#modelName,
      // Refused above where it is no operation the engine knows.
      this.#options.originalOperation as never,
      args,
      this.#callRows()
    );
    this.#routedInstance = routed;
    return routed;
  }

  /** The row facts this call's admitted controls resolve to, if any. */
  #callRows() {
    const binding = this.#engine.extensionChain?.callRows;
    return binding?.call(this.#modelName, this.#inputPreparation?.controls);
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
    return this.#resolveRouted().args;
  }

  /**
   * The prepared facts one query handler chain inspects. Its `input` is
   * snapshotted at the first read, once for the whole chain: the prepared
   * payload is the admission's own and nothing writes it after admission, so
   * a later snapshot says what an eager one would, and a chain that never
   * reads it never copies it.
   */
  #queryContext(
    mode: QueryInterceptionMode,
    preparedInput: Record<string, unknown>
  ): PreparedModelQueryContext<Record<string, unknown>> {
    const controls = this.#inputPreparation?.controls;
    let input: Readonly<Record<string, unknown>> | undefined;
    return Object.freeze({
      mode,
      kind: "model" as const,
      model: this.#modelName,
      operation: String(this.#options.originalOperation),
      get input() {
        input ??= snapshotQueryInput(preparedInput);
        return input;
      },
      ...(controls === undefined ? {} : { controls }),
      call: this.#inputPreparation,
    });
  }

  #getPromise(): Promise<T> {
    return this.#execution.executeDefault(() => {
      const observation = this.#engine.extensionChain?.observation;
      if (observation === undefined) {
        return this.#finished(this.#runExecution());
      }
      return observation.operation(
        String(this.#options.originalOperation),
        this.#modelName,
        () => this.#finished(this.#runExecution()),
        () =>
          this.#observationCommitCertainty === undefined
            ? undefined
            : { commitCertainty: this.#observationCommitCertainty },
        this.#readInstrumentationFacts()
      );
    });
  }

  /** The value its caller receives: the client's last step applied, if any. */
  #finished(value: Promise<T>): Promise<T> {
    const finish = this.#options.finishResult;
    return finish ? value.then((result) => finish(result) as T) : value;
  }

  #readInstrumentationFacts() {
    return createPendingOperationInstrumentationFacts(
      this.#engine.driver,
      this.#context.attribution,
      this.#modelName,
      String(this.#options.originalOperation),
      String(this.#operation),
      this.#model["~"].names.sql ?? this.#modelName
    );
  }

  #runExecution(
    driverOverride?: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    return withOperationErrorContext(this.#context.attribution, () =>
      this.#runAttributedExecution(
        driverOverride,
        committedWriteSegment,
        writeMayBeVisible
      )
    );
  }

  #runAttributedExecution(
    driverOverride?: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    const observerCommitted = this.#observationNotification("committed");
    const observerMayHaveCommitted =
      this.#observationNotification("may-have-committed");
    const requestedOperation = String(this.#options.originalOperation);
    const handlers = this.#engine.extensionChain?.query?.handlers(
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
    return this.#runExtendedExecution(
      handlers,
      requestedOperation,
      observerCommitted,
      observerMayHaveCommitted,
      driverOverride,
      committedWriteSegment,
      writeMayBeVisible
    );
  }

  /** Query extensions and write-outcome registration, out of line. */
  #runExtendedExecution(
    handlers: readonly ResolvedOperationHandler[] | undefined,
    requestedOperation: string,
    observerCommitted: (() => Promise<void>) | undefined,
    observerMayHaveCommitted: (() => Promise<void>) | undefined,
    driverOverride?: AnyDriver,
    committedWriteSegment?: CommittedWriteSegmentNotification,
    writeMayBeVisible?: WriteMayBeVisibleNotification
  ): Promise<T> {
    let preparedInput: Record<string, unknown>;
    try {
      preparedInput = this.#preparedInput();
    } catch (error) {
      return Promise.reject(error);
    }
    const writeOutcomeRegistration = this.#resolveWriteOutcomeRegistration();
    const coordination = this.#engine.extensionChain?.coordination;
    if (
      coordination === undefined ||
      ((handlers === undefined || handlers.length === 0) &&
        writeOutcomeRegistration === undefined)
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
        : this.#queryContext(
            this.#engine.transactionWriteOutcomes ? "transaction" : "direct",
            preparedInput
          );
    return coordination.executePreparedQuery<T, Record<string, unknown>>(
      context,
      handlers,
      (notifications, driver) =>
        this.#runCoreExecution(
          driver ?? driverOverride,
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
      this.#engine.extensionChain?.observation === undefined
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
    const run = (
      driver: AnyDriver | undefined,
      committed?: CommittedWriteSegmentNotification,
      mayBeVisible?: WriteMayBeVisibleNotification
    ) => this.#run(driver, committed, mayBeVisible);
    const units = this.#engine.extensionChain?.units;
    // A call inside a transaction, or a member of an array, is its owner's.
    if (
      units === undefined ||
      driverOverride !== undefined ||
      this.#engine.transactionWriteOutcomes !== undefined
    )
      return run(driverOverride, committedWriteSegment, writeMayBeVisible);
    const operation = String(this.#options.originalOperation);
    return units.send(
      { model: this.#modelName, operation },
      () => this.#resolveArgs(),
      !isReadOperation(operation),
      run,
      committedWriteSegment,
      writeMayBeVisible
    );
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
    let routed: PreparedOperation;
    try {
      routed = this.#resolveRouted();
    } catch (error) {
      return Promise.reject(error);
    }
    const run = () =>
      routed.run({
        committedWriteSegment,
        context: this.#context.attribution,
        driverOverride,
        engineDriver: this.#engine.driver,
        isWrite: !isReadOperation(String(this.#options.originalOperation)),
        writeMayBeVisible,
      }) as Promise<T>;
    // Below every per-call lifecycle step, outside any borrowed scope: a
    // `findUnique` may share one read with the calls of the same tick.
    if (this.#operation === "findUnique" && driverOverride === undefined) {
      const batched = batchFindUnique({
        engine: this.#engine,
        model: this.#model,
        requested: String(this.#options.originalOperation),
        args: this.#resolveArgs(),
        controls: this.#inputPreparation?.controls,
        rows: () => this.#callRows(),
        routed,
        context: this.#context.attribution,
        run,
      });
      if (batched !== undefined) return batched as Promise<T>;
    }
    return run();
  }

  getArgs(): Record<string, unknown> {
    return this.#args;
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
    return this.#resolveRouted().read?.statement;
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
