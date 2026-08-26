import { QueryError } from "@errors";
import { isReadOperation } from "@query-engine/write-engine/routing";
import { isFunction } from "@validation/value-guards";
import { isError } from "../errors/diagnostic-safety";
import type { ResolvedExtensionHandler } from "./chain";

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

export type RawQueryOperation =
  | "$queryRaw"
  | "$executeRaw"
  | "$queryRawUnsafe"
  | "$executeRawUnsafe";

interface PreparedQueryContextBase<Input extends object> {
  readonly mode: QueryInterceptionMode;
  readonly input: Readonly<Input>;
}

export interface PreparedModelQueryContext<Input extends object>
  extends PreparedQueryContextBase<Input> {
  readonly kind: "model";
  readonly model: string;
  readonly operation: string;
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

export type GenericQueryKind =
  | "model"
  | "queryRaw"
  | "executeRaw"
  | "queryRawUnsafe"
  | "executeRawUnsafe";

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
};

type GenericRawQueryContext<Result> = GenericQueryContextBase<Result> &
  (
    | {
        readonly kind: "queryRaw";
        readonly model: undefined;
        readonly operation: "$queryRaw";
      }
    | {
        readonly kind: "executeRaw";
        readonly model: undefined;
        readonly operation: "$executeRaw";
      }
    | {
        readonly kind: "queryRawUnsafe";
        readonly model: undefined;
        readonly operation: "$queryRawUnsafe";
      }
    | {
        readonly kind: "executeRawUnsafe";
        readonly model: undefined;
        readonly operation: "$executeRawUnsafe";
      }
  );

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

export type QueryHandlerMap<C extends VibORMConfig> = {
  readonly [ModelName in keyof C["schema"]]?: {
    readonly [OperationName in Operations]?: <
      Arg extends Exclude<
        OperationPayload<OperationName, C["schema"][ModelName]>,
        undefined
      >,
    >(context: {
      readonly mode: QueryInterceptionMode;
      readonly kind: "model";
      readonly model: ModelName;
      readonly operation: OperationName;
      readonly input: Readonly<Arg>;
      readonly proceed: () => Promise<
        ClientOperationResult<C, ModelName, OperationName, Arg>
      >;
      readonly onWriteOutcome: (listener: WriteOutcomeListener) => void;
    }) => Promise<ClientOperationResult<C, ModelName, OperationName, Arg>>;
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
}

export type QueryInterceptorContext<
  Result,
  Input extends object = Record<string, unknown>,
> = Readonly<
  PreparedQueryContext<Input> & QueryInterceptorCapabilities<Result>
>;

export type QueryInterceptor<
  Result,
  Input extends object = Record<string, unknown>,
> = ResolvedExtensionHandler<
  (context: QueryInterceptorContext<Result, Input>) => Promise<Result>
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
  interceptors: readonly ResolvedExtensionHandler[] | undefined,
  child: (notifications?: WriteOutcomeNotifications) => Promise<Result>,
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
      child,
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
    preRegisteredWriteOutcome
  );
}

function discardReadWriteOutcomeRegistration(): void {
  return;
}

async function executeInterceptedQuery<Result, Input extends object>(
  context: PreparedQueryContext<Input> | undefined,
  interceptors: readonly ResolvedExtensionHandler[] | undefined,
  child: (notifications?: WriteOutcomeNotifications) => Promise<Result>,
  isWrite: boolean,
  transactionWriteOutcomes: TransactionWriteOutcomes | undefined,
  control: QueryInterceptorExecutionControl | undefined,
  preRegisteredWriteOutcome: WriteOutcomeRegistration | undefined
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
  const executeChild = async (): Promise<Result> => {
    try {
      const value = await child(notifications);
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
      context === undefined ||
      interceptors === undefined ||
      interceptors.length === 0
        ? await executeChild()
        : await runCompiledQueryInterceptors(
            context,
            interceptors,
            executeChild,
            captureWriteOutcome,
            () => directCommitCertainty ?? control?.readCommitCertainty?.(),
            control?.reportAdmissionFailure
          );
    if (!isWrite && transactionWriteOutcomes) {
      transactionWriteOutcomes.discard(registrations);
    }
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

type ExtensionFailures =
  | readonly [QueryError]
  | readonly [QueryError, QueryError]
  | undefined;

/**
 * Run one already-compiled interceptor chain around one prepared child.
 *
 * The undefined/empty branch deliberately returns the child's promise directly:
 * unextended operations allocate no runner promise, context, closure, or list.
 */
export function runQueryInterceptors<
  Result,
  Input extends object = Record<string, unknown>,
>(
  context: PreparedQueryContext<Input>,
  interceptors: readonly [
    QueryInterceptor<Result, Input>,
    ...QueryInterceptor<Result, Input>[],
  ],
  child: () => Promise<NoInfer<Result>>,
  captureWriteOutcome: WriteOutcomeRegistrationCapture
): Promise<Result>;
export function runQueryInterceptors<
  Result,
  Input extends object = Record<string, unknown>,
>(
  context: PreparedQueryContext<Input>,
  interceptors: readonly QueryInterceptor<Result, Input>[] | undefined,
  child: () => Promise<Result>,
  captureWriteOutcome: WriteOutcomeRegistrationCapture
): Promise<Result>;
export function runQueryInterceptors<
  Result,
  Input extends object = Record<string, unknown>,
>(
  context: PreparedQueryContext<Input>,
  interceptors: readonly QueryInterceptor<Result, Input>[] | undefined,
  child: () => Promise<Result>,
  captureWriteOutcome: WriteOutcomeRegistrationCapture
): Promise<Result> {
  return runCompiledQueryInterceptors(
    context,
    interceptors,
    child,
    captureWriteOutcome
  );
}

function runCompiledQueryInterceptors<Result, Input extends object>(
  context: PreparedQueryContext<Input>,
  interceptors: readonly ResolvedExtensionHandler[] | undefined,
  child: () => Promise<Result>,
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
    reportAdmissionFailure
  );
}

function runInterceptorAt<Result, Input extends object>(
  context: PreparedQueryContext<Input>,
  interceptors: readonly ResolvedExtensionHandler[],
  index: number,
  child: () => Promise<Result>,
  captureWriteOutcome: WriteOutcomeRegistrationCapture,
  readCommitCertainty: ReadCommitCertainty | undefined,
  reportAdmissionFailure: ((failure: unknown) => void) | undefined
): Promise<Result> {
  const interceptor = interceptors[index];
  if (interceptor === undefined) return child();

  return runOneInterceptor(
    context,
    interceptor,
    () =>
      runInterceptorAt(
        context,
        interceptors,
        index + 1,
        child,
        captureWriteOutcome,
        readCommitCertainty,
        reportAdmissionFailure
      ),
    captureWriteOutcome,
    readCommitCertainty,
    reportAdmissionFailure
  );
}

async function runOneInterceptor<Result, Input extends object>(
  prepared: PreparedQueryContext<Input>,
  interceptor: ResolvedExtensionHandler,
  child: () => Promise<Result>,
  captureWriteOutcome: WriteOutcomeRegistrationCapture,
  readCommitCertainty: ReadCommitCertainty | undefined,
  reportAdmissionFailure: ((failure: unknown) => void) | undefined
): Promise<Result> {
  let continuationOpen = true;
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

  const proceed = (): Promise<Result> => {
    if (!continuationOpen) {
      throw recordProtocolFailure("called proceed more than once");
    }
    if (handlerSettled) {
      throw recordProtocolFailure("called proceed after its handler settled");
    }

    registrationOpen = false;
    continuationOpen = false;
    const promise = startChild(child);
    childOutcomePromise = settle(promise);
    return promise;
  };

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
    proceed,
    onWriteOutcome
  );
  let handlerValue: Promise<Result>;
  try {
    handlerValue = Promise.resolve<Result>(
      Reflect.apply(interceptor.handler, undefined, [handlerContext])
    );
  } catch (reason) {
    handlerValue = Promise.reject(reason);
  }

  const handlerOutcome = await settle(handlerValue);
  handlerSettled = true;
  registrationOpen = false;
  let reportedHandlerFailure: QueryError | undefined;

  if (
    childOutcomePromise !== undefined &&
    handlerOutcome.status === "rejected" &&
    handlerOutcome.reason !== protocolFailure
  ) {
    reportedHandlerFailure = interceptorFailure(
      interceptor.extension,
      prepared,
      handlerOutcome.reason,
      readCommitCertainty?.()
    );
    reportAdmissionFailure?.(reportedHandlerFailure);
  }

  if (childOutcomePromise === undefined) {
    if (protocolFailure) throw protocolFailure;
    if (handlerOutcome.status === "rejected") {
      throw interceptorFailure(
        interceptor.extension,
        prepared,
        handlerOutcome.reason
      );
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
  const extensionFailures = selectExtensionFailures(
    protocolFailure,
    handlerOutcome,
    childOutcome,
    interceptor.extension,
    prepared,
    readCommitCertainty?.(),
    reportedHandlerFailure
  );

  if (childOutcome.status === "rejected") {
    if (extensionFailures) {
      throw retainSuppressedFailures(childOutcome.reason, extensionFailures);
    }
    throw childOutcome.reason;
  }
  if (extensionFailures) throwExtensionFailures(extensionFailures);
  return childOutcome.value;
}

function selectExtensionFailures<Input extends object>(
  protocolFailure: QueryError | undefined,
  handlerOutcome: Settled<unknown>,
  childOutcome: Settled<unknown>,
  extension: string,
  context: PreparedQueryContext<Input>,
  commitCertainty: WriteOutcome["certainty"] | undefined,
  reportedHandlerFailure: QueryError | undefined
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
    handlerOutcome.reason === protocolFailure ||
    (childOutcome.status === "rejected" &&
      handlerOutcome.reason === childOutcome.reason)
  ) {
    return protocolFailure ? [protocolFailure] : undefined;
  }
  const handlerFailure =
    reportedHandlerFailure ??
    interceptorFailure(
      extension,
      context,
      handlerOutcome.reason,
      commitCertainty
    );
  if (
    childOutcome.status === "rejected" &&
    childOutcome.reason === handlerFailure
  ) {
    return protocolFailure ? [protocolFailure] : undefined;
  }
  return protocolFailure ? [protocolFailure, handlerFailure] : [handlerFailure];
}

function exposeHandlerContext<Result, Input extends object>(
  context: PreparedQueryContext<Input>,
  proceed: () => Promise<Result>,
  onWriteOutcome: (listener: WriteOutcomeListener) => void
): QueryInterceptorContext<Result, Input> {
  if (context.kind === "model") {
    return Object.freeze({
      mode: context.mode,
      kind: context.kind,
      model: context.model,
      operation: context.operation,
      input: context.input,
      proceed,
      onWriteOutcome,
    });
  }
  return Object.freeze({
    mode: context.mode,
    kind: context.kind,
    model: context.model,
    operation: context.operation,
    input: context.input,
    proceed,
    onWriteOutcome,
  });
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
): QueryError {
  return interceptorError(
    extension,
    context,
    "failed",
    normalizeInterceptorFailure(reason),
    commitCertainty
  );
}

function normalizeInterceptorFailure(reason: unknown): Error {
  return isError(reason)
    ? reason
    : new Error("Query interceptor rejected with a non-Error value");
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
  private readonly staged: StagedWriteOutcome[] = [];

  stage(registration: WriteOutcomeRegistration): void {
    for (const staged of this.staged) {
      if (staged.registration === registration) return;
    }
    this.staged.push({ registration, state: "pending" });
  }

  confirm(registrations: readonly WriteOutcomeRegistration[]): void {
    this.setState(registrations, "confirmed");
  }

  discard(registrations: readonly WriteOutcomeRegistration[]): void {
    this.setState(registrations, "discarded");
  }

  discardAll(): void {
    for (const staged of this.staged) staged.state = "discarded";
  }

  promoteTo(parent: TransactionWriteOutcomes): void {
    for (const staged of this.staged) {
      if (staged.state === "confirmed") {
        parent.staged.push({ ...staged });
      }
      staged.state = "discarded";
    }
  }

  publishCommitted(): Promise<void> {
    return this.publish("committed");
  }

  async publish(certainty: WriteOutcome["certainty"]): Promise<void> {
    const registrations: WriteOutcomeRegistration[] = [];
    for (const staged of this.staged) {
      if (staged.state === "confirmed") {
        registrations.push(staged.registration);
      }
      staged.state = "discarded";
    }
    await publishWriteOutcomes(registrations, { certainty });
  }

  private setState(
    registrations: readonly WriteOutcomeRegistration[],
    state: "confirmed" | "discarded"
  ): void {
    for (const staged of this.staged) {
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
      const failure =
        registration.failurePolicy === "boundary-owned" && cause !== undefined
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

/** Keep the execution failure primary while retaining every listener failure. */
export function retainWriteOutcomeFailure(
  primary: unknown,
  outcomeFailure: unknown,
  message = "Query execution and write-outcome publication both failed."
): AggregateError {
  const suppressed =
    outcomeFailure instanceof AggregateError
      ? [...outcomeFailure.errors]
      : [outcomeFailure];
  return new AggregateError([primary, ...suppressed], message, {
    cause: primary,
  });
}

import type { VibORMConfig } from "@client/client";
import type {
  ClientOperationResult,
  OperationPayload,
  Operations,
} from "@client/types";
