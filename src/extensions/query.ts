import type { ClientSchema } from "@client/schema-links";
import type { AnyDriver } from "@drivers/exports";
import { QueryError, VibORMError } from "@errors";
import { isReadOperation } from "@query-engine/routed-operations";
import { isFunction } from "@validation/value-guards";
import { isError } from "../errors/diagnostic-safety";
import type { ExtensionPart, ResolvedOperationHandler } from "./chain";
import { type AdmittedControls, controlsOwnedBy } from "./controls";
import { coordinate, QUERIES } from "./coordination";
import { compileHandlers, hasCompiledHandlers } from "./handlers";

/** Frozen runtime contribution after hostile definition normalization. */
type RuntimeQueryFunction = (...args: never[]) => unknown;
export type RuntimeQueryContribution =
  | RuntimeQueryFunction
  | Readonly<Record<string, Readonly<Record<string, RuntimeQueryFunction>>>>;

export type QueryInterceptionMode = "direct" | "transaction" | "array";

export type RawQueryKind =
  | "queryRaw"
  | "executeRaw"
  | "queryRawUnsafe"
  | "executeRawUnsafe";

export type RawQueryOperation = `$${RawQueryKind}`;

interface PreparedQueryContextBase<Input extends object> {
  readonly mode: QueryInterceptionMode;
  readonly input: Readonly<Input>;
}

export interface PreparedModelQueryContext<Input extends object>
  extends PreparedQueryContextBase<Input> {
  readonly kind: "model";
  readonly model: string;
  readonly operation: string;
  /**
   * The call's admitted controls. A handler sees only its own extension's,
   * and only when that extension declares any.
   */
  readonly controls?: AdmittedControls;
  /**
   * One object per call, the same one its first moments were handed: what
   * links a `call.around` part's two moments.
   */
  readonly call?: object;
}

export interface PreparedRawQueryContext<Input extends object>
  extends PreparedQueryContextBase<Input> {
  readonly kind: RawQueryKind;
  readonly model: undefined;
  readonly operation: RawQueryOperation;
}

/** The prepared logical-operation facts safe for query interceptors to inspect. */
export type PreparedQueryContext<
  Input extends object = Record<string, unknown>,
> = PreparedModelQueryContext<Input> | PreparedRawQueryContext<Input>;

export type WriteOutcome = Readonly<{
  certainty: "committed" | "may-have-committed";
}>;

export type WriteOutcomeListener = (
  outcome: WriteOutcome
) => unknown | Promise<unknown>;

export type GenericQueryKind = "model" | RawQueryKind;

type GenericQueryContextBase<Result> = {
  readonly mode: QueryInterceptionMode;
  readonly input: Readonly<Record<string, unknown>>;
  readonly proceed: () => Promise<Result>;
  readonly onWriteOutcome: (listener: WriteOutcomeListener) => void;
};

type GenericModelQueryContext<Result> = GenericQueryContextBase<Result> & {
  readonly kind: "model";
  readonly model: string;
  readonly operation: Operations;
  /** The call's controls this handler's extension declares, and only those. */
  readonly controls?: AdmittedControls;
};

type GenericRawQueryContext<Result> = GenericQueryContextBase<Result> &
  {
    [Kind in RawQueryKind]: {
      readonly kind: Kind;
      readonly model: undefined;
      readonly operation: `$${Kind}`;
    };
  }[RawQueryKind];

export type GenericQueryContext<Result> =
  | GenericModelQueryContext<Result>
  | GenericRawQueryContext<Result>;

type GenericQueryHandlerCall = <Result>(
  context: GenericQueryContext<Result>
) => Promise<Result>;

declare const officialQueryHandlerIdentity: unique symbol;

/** Public ordinary query handler; official identities cannot be erased into it. */
export type GenericQueryHandler = GenericQueryHandlerCall & {
  readonly [officialQueryHandlerIdentity]?: never;
};

/** Internal nominal call shape used by official query-based capabilities. */
export type OfficialGenericQueryHandler = GenericQueryHandlerCall & {
  readonly [officialQueryHandlerIdentity]: true;
};

/**
 * Per-model query handlers. Their results read the result context of the
 * chain they are applied to: `Hidden` names the models its `rows` can hide
 * (`rows` cannot follow a model-mapped handler, so a later extension adds
 * none). A `rows` entry in the handler's OWN definition is not seen, as no
 * definition types against its own contributions: declare it one step
 * earlier.
 */
export type QueryHandlerMap<
  C extends VibORMConfig,
  Hidden extends string = never,
> = {
  readonly [ModelName in keyof ClientSchema<C>]?: {
    readonly [OperationName in Operations]?: <
      Arg extends Exclude<
        OperationPayload<OperationName, ClientSchema<C>[ModelName]>,
        undefined
      >,
    >(context: {
      readonly mode: QueryInterceptionMode;
      readonly kind: "model";
      readonly model: ModelName;
      readonly operation: OperationName;
      readonly input: Readonly<Arg>;
      /** The call's controls this handler's extension declares, and only those. */
      readonly controls?: AdmittedControls;
      readonly proceed: () => Promise<
        ContextualOperationResult<
          C,
          ModelName,
          OperationName,
          Arg,
          ClientRowsContext<C, Hidden>
        >
      >;
      readonly onWriteOutcome: (listener: WriteOutcomeListener) => void;
    }) => Promise<
      ContextualOperationResult<
        C,
        ModelName,
        OperationName,
        Arg,
        ClientRowsContext<C, Hidden>
      >
    >;
  };
};

export interface WriteOutcomeRegistration {
  readonly extension: string;
  readonly listener: WriteOutcomeListener;
  /** Package-owned listeners may already translate failures at their boundary. */
  readonly failurePolicy?: "boundary-owned";
}

export type WriteOutcomeRegistrationCapture = (
  registration: WriteOutcomeRegistration
) => void;

export interface WriteOutcomeNotifications {
  readonly committed: () => Promise<void>;
  readonly mayHaveCommitted: () => Promise<void>;
}

interface QueryInterceptorCapabilities<Result> {
  readonly proceed: () => Promise<Result>;
  readonly onWriteOutcome: (listener: WriteOutcomeListener) => void;
  /**
   * Whether the call may be made again, and if so, `proceed` may be called
   * once more: a direct call whose child failed with nothing written.
   */
  readonly again: () => boolean;
  /** `proceed` on another driver: a direct read only; elsewhere `proceed`. */
  readonly proceedOn: (driver: AnyDriver) => Promise<Result>;
  /**
   * Run the core alone, once, whatever the handler did: a direct read's
   * refresh after its handler returned. Anything else is refused.
   */
  readonly replay: () => Promise<Result>;
}

/** The child a handler chain runs: on the driver a handler chose, if any. */
type Child<Result> = (driver?: AnyDriver) => Promise<Result>;

export type QueryInterceptorContext<
  Result,
  Input extends object = Record<string, unknown>,
> = Readonly<
  PreparedQueryContext<Input> & QueryInterceptorCapabilities<Result>
>;

const queryCoordinationFailures = new WeakMap<AggregateError, unknown>();
const publicationFailures = new WeakMap<AggregateError, readonly Error[]>();

type ReadCommitCertainty = () => WriteOutcome["certainty"] | undefined;

/** Private coordination hooks used only while array members await admission. */
export interface QueryInterceptorExecutionControl {
  readonly reportAdmissionFailure?: (failure: unknown) => void;
  readonly readCommitCertainty?: ReadCommitCertainty;
}

/**
 * Execute one prepared operation through its exact precompiled query chain.
 *
 * The absent-chain arm calls the child directly and allocates no context,
 * registration list, notification callback, or runner promise.
 */
export function executePreparedQuery<Result, Input extends object>(
  context: PreparedQueryContext<Input> | undefined,
  interceptors: readonly ResolvedOperationHandler[] | undefined,
  child: (
    notifications?: WriteOutcomeNotifications,
    driver?: AnyDriver
  ) => Promise<Result>,
  isWrite: boolean,
  transactionWriteOutcomes?: TransactionWriteOutcomes,
  control?: QueryInterceptorExecutionControl,
  preRegisteredWriteOutcome?: WriteOutcomeRegistration
): Promise<Result> {
  if (
    (context === undefined ||
      interceptors === undefined ||
      interceptors.length === 0) &&
    preRegisteredWriteOutcome === undefined
  ) {
    return child();
  }
  if (
    !isWrite &&
    preRegisteredWriteOutcome === undefined &&
    context !== undefined &&
    interceptors !== undefined &&
    interceptors.length > 0
  ) {
    return runCompiledQueryInterceptors(
      context,
      interceptors,
      (driver) => child(undefined, driver),
      discardReadWriteOutcomeRegistration,
      control?.readCommitCertainty,
      control?.reportAdmissionFailure
    );
  }
  return executeInterceptedQuery(
    context,
    interceptors,
    child,
    isWrite,
    transactionWriteOutcomes,
    control,
    preRegisteredWriteOutcome,
    runCompiledQueryInterceptors
  );
}

/**
 * {@link executePreparedQuery} on a chain without query handlers: what
 * wraps the call is its write-outcome registration, the only reason it is
 * asked, so the code that runs handlers is not carried.
 */
export function executeRegisteredQuery<Result, Input extends object>(
  _context: PreparedQueryContext<Input> | undefined,
  _interceptors: readonly ResolvedOperationHandler[] | undefined,
  child: (
    notifications?: WriteOutcomeNotifications,
    driver?: AnyDriver
  ) => Promise<Result>,
  isWrite: boolean,
  transactionWriteOutcomes?: TransactionWriteOutcomes,
  control?: QueryInterceptorExecutionControl,
  preRegisteredWriteOutcome?: WriteOutcomeRegistration
): Promise<Result> {
  return executeInterceptedQuery(
    undefined,
    undefined,
    child,
    isWrite,
    transactionWriteOutcomes,
    control,
    preRegisteredWriteOutcome
  );
}

function discardReadWriteOutcomeRegistration(): void {
  return;
}

async function executeInterceptedQuery<Result, Input extends object>(
  context: PreparedQueryContext<Input> | undefined,
  interceptors: readonly ResolvedOperationHandler[] | undefined,
  child: (
    notifications?: WriteOutcomeNotifications,
    driver?: AnyDriver
  ) => Promise<Result>,
  isWrite: boolean,
  transactionWriteOutcomes: TransactionWriteOutcomes | undefined,
  control: QueryInterceptorExecutionControl | undefined,
  preRegisteredWriteOutcome: WriteOutcomeRegistration | undefined,
  // Passed by the caller that has handlers to run: the one that has none
  // does not carry their runner.
  intercept?: typeof runCompiledQueryInterceptors
): Promise<Result> {
  const registrations: WriteOutcomeRegistration[] =
    preRegisteredWriteOutcome === undefined ? [] : [preRegisteredWriteOutcome];
  if (preRegisteredWriteOutcome !== undefined) {
    transactionWriteOutcomes?.stage(preRegisteredWriteOutcome);
  }
  const captureWriteOutcome = (
    registration: WriteOutcomeRegistration
  ): void => {
    registrations.push(registration);
    transactionWriteOutcomes?.stage(registration);
  };
  let publishedDirectUnits = 0;
  let directCommitCertainty: WriteOutcome["certainty"] | undefined;
  let transactionConfirmed = false;
  const publish = async (
    certainty: WriteOutcome["certainty"]
  ): Promise<void> => {
    if (transactionWriteOutcomes) {
      if (registrations.length === 0) return;
      if (transactionConfirmed) return;
      transactionConfirmed = true;
      transactionWriteOutcomes.confirm(registrations);
      return;
    }
    publishedDirectUnits += 1;
    directCommitCertainty = certainty;
    if (registrations.length === 0) return;
    await publishWriteOutcomes(registrations, { certainty });
  };
  const notifications: WriteOutcomeNotifications = Object.freeze({
    committed: () => publish("committed"),
    mayHaveCommitted: () => publish("may-have-committed"),
  });
  const executeChild = async (driver?: AnyDriver): Promise<Result> => {
    try {
      const value = await child(notifications, driver);
      if (
        isWrite &&
        (transactionWriteOutcomes !== undefined || publishedDirectUnits === 0)
      ) {
        await publish("committed");
      }
      return value;
    } catch (error) {
      if (transactionWriteOutcomes && !transactionConfirmed) {
        transactionWriteOutcomes.discard(registrations);
      }
      throw error;
    }
  };

  try {
    const value =
      intercept === undefined ||
      context === undefined ||
      interceptors === undefined ||
      interceptors.length === 0
        ? await executeChild()
        : await intercept(
            context,
            interceptors,
            executeChild,
            captureWriteOutcome,
            () => directCommitCertainty ?? control?.readCommitCertainty?.(),
            control?.reportAdmissionFailure
          );
    return value;
  } catch (error) {
    if (transactionWriteOutcomes && !transactionConfirmed) {
      transactionWriteOutcomes.discard(registrations);
    }
    throw error;
  }
}

type Settled<Value> =
  | { readonly status: "fulfilled"; readonly value: Value }
  | { readonly status: "rejected"; readonly reason: unknown };

type HandlerOutcome<Value> =
  | { readonly status: "fulfilled"; readonly value: Value }
  | {
      readonly status: "rejected";
      readonly reason: unknown;
      readonly failure: Error;
    };

type ExtensionFailures = readonly [Error] | readonly [Error, Error] | undefined;

/**
 * Run one already-compiled interceptor chain around one prepared child.
 *
 * The undefined/empty branch deliberately returns the child's promise directly:
 * unextended operations allocate no runner promise, context, closure, or list.
 */
export function runCompiledQueryInterceptors<Result, Input extends object>(
  context: PreparedQueryContext<Input>,
  interceptors: readonly ResolvedOperationHandler[] | undefined,
  child: Child<Result>,
  captureWriteOutcome: WriteOutcomeRegistrationCapture,
  readCommitCertainty?: ReadCommitCertainty,
  reportAdmissionFailure?: (failure: unknown) => void
): Promise<Result> {
  if (interceptors === undefined || interceptors.length === 0) return child();
  return runInterceptorAt(
    context,
    interceptors,
    0,
    child,
    captureWriteOutcome,
    readCommitCertainty,
    reportAdmissionFailure,
    undefined,
    child
  );
}

function runInterceptorAt<Result, Input extends object>(
  context: PreparedQueryContext<Input>,
  interceptors: readonly ResolvedOperationHandler[],
  index: number,
  child: Child<Result>,
  captureWriteOutcome: WriteOutcomeRegistrationCapture,
  readCommitCertainty: ReadCommitCertainty | undefined,
  reportAdmissionFailure: ((failure: unknown) => void) | undefined,
  driver: AnyDriver | undefined,
  core: Child<Result>
): Promise<Result> {
  const interceptor = interceptors[index];
  if (interceptor === undefined) return child(driver);

  return runOneInterceptor(
    context,
    interceptor,
    (chosen) =>
      runInterceptorAt(
        context,
        interceptors,
        index + 1,
        child,
        captureWriteOutcome,
        readCommitCertainty,
        reportAdmissionFailure,
        chosen ?? driver,
        core
      ),
    captureWriteOutcome,
    readCommitCertainty,
    reportAdmissionFailure,
    () => core(driver)
  );
}

async function runOneInterceptor<Result, Input extends object>(
  prepared: PreparedQueryContext<Input>,
  interceptor: ResolvedOperationHandler,
  child: Child<Result>,
  captureWriteOutcome: WriteOutcomeRegistrationCapture,
  readCommitCertainty: ReadCommitCertainty | undefined,
  reportAdmissionFailure: ((failure: unknown) => void) | undefined,
  core: () => Promise<Result>
): Promise<Result> {
  let continuationOpen = true;
  // A direct read may run once more after its handler returned (a value
  // served now and refreshed later): that run is the core's alone.
  let replayable =
    prepared.mode === "direct" &&
    prepared.kind === "model" &&
    isReadOperation(prepared.operation);
  let childOutcomePromise: Promise<Settled<Result>> | undefined;
  let handlerSettled = false;
  let registrationOpen = true;
  let protocolFailure: QueryError | undefined;

  const recordProtocolFailure = (failure: string): QueryError => {
    if (protocolFailure) return protocolFailure;
    const error = interceptorError(interceptor.extension, prepared, failure);
    protocolFailure = error;
    reportAdmissionFailure?.(error);
    return error;
  };

  let childFailed = false;
  const proceed = (driver?: AnyDriver): Promise<Result> => {
    if (!continuationOpen) {
      throw recordProtocolFailure("called proceed more than once");
    }
    if (handlerSettled) {
      throw recordProtocolFailure("called proceed after its handler settled");
    }

    registrationOpen = false;
    continuationOpen = false;
    childFailed = false;
    const promise = startChild(() => child(driver));
    // Attached first, so a handler's own `catch` already reads it.
    promise.then(undefined, () => {
      childFailed = true;
    });
    childOutcomePromise = settle(promise);
    return promise;
  };

  // A direct call whose child failed with nothing written, or maybe written,
  // may be made again: once per failure.
  const again = (): boolean => {
    if (
      prepared.mode !== "direct" ||
      !childFailed ||
      handlerSettled ||
      readCommitCertainty?.() !== undefined
    )
      return false;
    childFailed = false;
    continuationOpen = true;
    return true;
  };

  const replay = (): Promise<Result> => {
    if (!replayable) throw recordProtocolFailure("ran the call again");
    replayable = false;
    return startChild(core);
  };

  const proceedOn = (driver: AnyDriver): Promise<Result> =>
    prepared.mode === "direct" &&
    prepared.kind === "model" &&
    isReadOperation(prepared.operation)
      ? proceed(driver)
      : proceed();

  const onWriteOutcome = (listener: WriteOutcomeListener): void => {
    if (!isFunction(listener)) {
      throw recordProtocolFailure(
        "registered a non-function write-outcome listener"
      );
    }
    if (!registrationOpen || handlerSettled) {
      throw recordProtocolFailure(
        "registered a write-outcome listener after proceed"
      );
    }
    captureWriteOutcome(
      Object.freeze({ extension: interceptor.extension, listener })
    );
  };

  const handlerContext = exposeHandlerContext(
    prepared,
    { proceed: () => proceed(), onWriteOutcome, again, proceedOn, replay },
    interceptor.controls
  );
  let handlerValue: Promise<Result>;
  try {
    handlerValue = Promise.resolve<Result>(
      Reflect.apply(interceptor.handler, undefined, [handlerContext])
    );
  } catch (reason) {
    handlerValue = Promise.reject(reason);
  }

  const settledHandler = await settle(handlerValue);
  handlerSettled = true;
  registrationOpen = false;
  const handlerOutcome: HandlerOutcome<Result> =
    settledHandler.status === "fulfilled"
      ? settledHandler
      : {
          ...settledHandler,
          failure:
            protocolFailure !== undefined &&
            settledHandler.reason === protocolFailure
              ? protocolFailure
              : interceptorFailure(
                  interceptor.extension,
                  prepared,
                  settledHandler.reason,
                  readCommitCertainty?.()
                ),
        };

  if (
    childOutcomePromise !== undefined &&
    handlerOutcome.status === "rejected" &&
    handlerOutcome.reason !== protocolFailure
  ) {
    reportAdmissionFailure?.(handlerOutcome.failure);
  }

  if (childOutcomePromise === undefined) {
    if (protocolFailure) throw protocolFailure;
    if (handlerOutcome.status === "rejected") {
      throw handlerOutcome.failure;
    }
    if (requiresProceed(prepared)) {
      throw interceptorError(
        interceptor.extension,
        prepared,
        "completed without proceed"
      );
    }
    return handlerOutcome.value;
  }

  const childOutcome = await childOutcomePromise;
  if (childOutcome.status === "rejected") {
    const extensionFailures = selectExtensionFailures(
      protocolFailure,
      handlerOutcome,
      childOutcome
    );
    if (extensionFailures) {
      throw retainSuppressedFailures(childOutcome.reason, extensionFailures);
    }
    throw childOutcome.reason;
  }
  const extensionFailures = selectExtensionFailures(
    protocolFailure,
    handlerOutcome,
    childOutcome
  );
  if (extensionFailures) throwExtensionFailures(extensionFailures);
  // With the child fulfilled, a rejected handler always selects a failure.
  return (handlerOutcome as Extract<HandlerOutcome<Result>, { value: Result }>)
    .value;
}

function selectExtensionFailures(
  protocolFailure: QueryError | undefined,
  handlerOutcome: HandlerOutcome<unknown>,
  childOutcome: Settled<unknown>
): ExtensionFailures {
  if (
    protocolFailure &&
    childOutcome.status === "rejected" &&
    childOutcome.reason === protocolFailure
  ) {
    return undefined;
  }
  if (handlerOutcome.status !== "rejected") {
    return protocolFailure ? [protocolFailure] : undefined;
  }
  if (
    (protocolFailure !== undefined &&
      handlerOutcome.reason === protocolFailure) ||
    (childOutcome.status === "rejected" &&
      handlerOutcome.reason === childOutcome.reason)
  ) {
    return protocolFailure ? [protocolFailure] : undefined;
  }
  const handlerFailure = handlerOutcome.failure;
  return protocolFailure ? [protocolFailure, handlerFailure] : [handlerFailure];
}

function exposeHandlerContext<Result, Input extends object>(
  context: PreparedQueryContext<Input>,
  capabilities: QueryInterceptorCapabilities<Result>,
  ownControls: readonly string[] | undefined
): QueryInterceptorContext<Result, Input> {
  // `kind`, `model` and `operation` are copied from one prepared context, so
  // they stay one of its arms; TypeScript cannot correlate the copies.
  // `input` is read through: the prepared context snapshots it at the first
  // read, which a handler that never inspects it does not pay for.
  return Object.freeze({
    mode: context.mode,
    kind: context.kind,
    model: context.model,
    operation: context.operation,
    get input() {
      return context.input;
    },
    ...(context.kind === "model" && ownControls !== undefined
      ? { controls: controlsOwnedBy(context.controls, ownControls) }
      : {}),
    ...(context.kind === "model" && { call: context.call }),
    ...capabilities,
  }) as QueryInterceptorContext<Result, Input>;
}

function startChild<Result>(child: () => Promise<Result>): Promise<Result> {
  try {
    return Promise.resolve(child());
  } catch (reason) {
    return Promise.reject(reason);
  }
}

async function settle<Value>(promise: Promise<Value>): Promise<Settled<Value>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function requiresProceed(context: PreparedQueryContext<object>): boolean {
  return (
    context.mode === "array" ||
    context.kind !== "model" ||
    !isReadOperation(context.operation)
  );
}

function interceptorFailure<Input extends object>(
  extension: string,
  context: PreparedQueryContext<Input>,
  reason: unknown,
  commitCertainty?: WriteOutcome["certainty"]
): Error {
  if (isError(reason)) return reason;
  return interceptorError(
    extension,
    context,
    "failed",
    new Error("Query interceptor rejected with a non-Error value"),
    commitCertainty
  );
}

function interceptorError<Input extends object>(
  extension: string,
  context: PreparedQueryContext<Input>,
  failure: string,
  cause?: Error,
  commitCertainty?: WriteOutcome["certainty"]
): QueryError {
  const message = `Extension "${extension}" query handler for ${describeOperation(context)} ${failure}.`;
  const meta = {
    method: "query",
    model: context.model,
    operation: String(context.operation),
    ...(commitCertainty === undefined ? {} : { commitCertainty }),
  };
  return cause
    ? new QueryError(message, { cause, meta })
    : new QueryError(message, { meta });
}

function describeOperation(context: PreparedQueryContext<object>): string {
  return context.kind === "model"
    ? `${context.model}.${context.operation}`
    : context.operation;
}

function throwExtensionFailures(
  failures: NonNullable<ExtensionFailures>
): never {
  const primary = failures[0];
  if (failures.length === 1) throw primary;
  throw new AggregateError(
    failures,
    "Query interceptor protocol and handler both failed.",
    { cause: primary }
  );
}

function retainSuppressedFailures(
  childFailure: unknown,
  extensionFailures: NonNullable<ExtensionFailures>
): AggregateError {
  const failure = new AggregateError(
    [childFailure, ...extensionFailures],
    "Query execution and extension post-work both failed.",
    { cause: childFailure }
  );
  queryCoordinationFailures.set(failure, childFailure);
  return failure;
}

/** Decompose only this runner's own child-plus-post-work coordination error. */
export function decomposeQueryCoordinationFailure(failure: unknown):
  | Readonly<{
      child: unknown;
      postWork: readonly unknown[];
    }>
  | undefined {
  if (!(failure instanceof AggregateError)) return undefined;
  if (!queryCoordinationFailures.has(failure)) return undefined;
  const child = queryCoordinationFailures.get(failure);
  if (failure.cause !== child || failure.errors[0] !== child) {
    return undefined;
  }
  return Object.freeze({
    child,
    postWork: Object.freeze(failure.errors.slice(1)),
  });
}

type StagedWriteOutcome = {
  readonly registration: WriteOutcomeRegistration;
  state: "pending" | "confirmed" | "discarded";
};

/** Transaction-local staging for extension write-outcome registrations. */
export class TransactionWriteOutcomes {
  readonly #staged: StagedWriteOutcome[] = [];

  stage(registration: WriteOutcomeRegistration): void {
    for (const staged of this.#staged) {
      if (staged.registration === registration) return;
    }
    this.#staged.push({ registration, state: "pending" });
  }

  confirm(registrations: readonly WriteOutcomeRegistration[]): void {
    this.#setState(registrations, "confirmed");
  }

  discard(registrations: readonly WriteOutcomeRegistration[]): void {
    this.#setState(registrations, "discarded");
  }

  discardAll(): void {
    for (const staged of this.#staged) staged.state = "discarded";
  }

  promoteTo(parent: TransactionWriteOutcomes): void {
    for (const staged of this.#staged) {
      if (staged.state === "confirmed") {
        parent.#staged.push({ ...staged });
      }
      staged.state = "discarded";
    }
  }

  publishCommitted(): Promise<void> {
    return this.publish("committed");
  }

  async publish(certainty: WriteOutcome["certainty"]): Promise<void> {
    const registrations: WriteOutcomeRegistration[] = [];
    for (const staged of this.#staged) {
      if (staged.state === "confirmed") {
        registrations.push(staged.registration);
      }
      staged.state = "discarded";
    }
    await publishWriteOutcomes(registrations, { certainty });
  }

  #setState(
    registrations: readonly WriteOutcomeRegistration[],
    state: "confirmed" | "discarded"
  ): void {
    for (const staged of this.#staged) {
      if (
        staged.state === "pending" &&
        registrations.includes(staged.registration)
      ) {
        staged.state = state;
      }
    }
  }
}

/** Deliver every registered listener in registration order. */
export async function publishWriteOutcomes(
  registrations: readonly WriteOutcomeRegistration[],
  outcome: WriteOutcome
): Promise<void> {
  let failures: Error[] | undefined;
  for (const registration of registrations) {
    try {
      await registration.listener(outcome);
    } catch (reason) {
      const cause = isError(reason) ? reason : undefined;
      // An error of viborm's own is already said as the listener means it.
      const failure =
        cause !== undefined &&
        (registration.failurePolicy === "boundary-owned" ||
          cause instanceof VibORMError)
          ? cause
          : new QueryError(
              `Extension "${registration.extension}" write-outcome listener failed after ${outcome.certainty}.`,
              {
                cause:
                  cause ??
                  new Error(
                    "Write-outcome listener rejected with a non-Error value"
                  ),
                meta: {
                  method: "onWriteOutcome",
                  commitCertainty: outcome.certainty,
                },
              }
            );
      (failures ??= []).push(failure);
    }
  }
  if (failures === undefined) return;
  const [primary] = failures;
  if (failures.length === 1) throw primary;
  const aggregate = new AggregateError(
    failures,
    "Multiple extension write-outcome listeners failed.",
    { cause: primary }
  );
  publicationFailures.set(aggregate, failures);
  throw aggregate;
}

/** Decompose only the aggregate created by this publication owner. */
export function decomposeWriteOutcomePublicationFailure(
  failure: unknown
): readonly unknown[] {
  if (!(failure instanceof AggregateError)) return [failure];
  return publicationFailures.get(failure) ?? [failure];
}

import type { VibORMConfig } from "@client/client";
import type {
  ClientRowsContext,
  ContextualOperationResult,
  OperationPayload,
  Operations,
} from "@client/types";

/**
 * `query`: handlers around each prepared call. A chain built with this part
 * always holds a lookup, empty where no definition declared one.
 */
export const queryPart: ExtensionPart = {
  members: ["query"],
  join({ next, chain, definition, owner }) {
    const query =
      definition.query === undefined && chain?.query !== undefined
        ? chain.query
        : Object.freeze(
            compileHandlers(chain?.query, owner, definition.query, true)
          );
    next.query = query;
    next.hasQueryHandlers = hasCompiledHandlers(query);
    if (next.hasQueryHandlers) coordinate(next, QUERIES);
  },
};
