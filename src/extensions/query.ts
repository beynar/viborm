import { attachCommitCertainty } from "@drivers/driver-error-context";
import { bindExecutionTransactionPhases } from "@drivers/execution-context";
import type { AnyDriver, QueryExecutionContext } from "@drivers/exports";
import type { TransactionOptions } from "@drivers/shared/transaction-options";
import {
  isVibORMError,
  QueryError,
  retainWriteOutcomeFailure,
  VibORMError,
} from "@errors";
import { isReadOperation } from "@query-engine/routed-operations";
import { isFunction } from "@validation/value-guards";
import { isError } from "../errors/diagnostic-safety";
import type { ExtensionPart, ResolvedOperationHandler } from "./chain";
import { type AdmittedControls, controlsOwnedBy } from "./controls";
import { coordinate, QUERIES } from "./coordination";
import { handlersOf, type PlacedHandler } from "./handlers";

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

/**
 * Run one already-compiled interceptor chain around one prepared child, the
 * first handler outermost.
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
  const at = (index: number, driver?: AnyDriver): Promise<Result> => {
    const interceptor = interceptors?.[index];
    return interceptor === undefined
      ? child(driver)
      : runOneInterceptor(
          context,
          interceptor,
          (chosen) => at(index + 1, chosen ?? driver),
          captureWriteOutcome,
          readCommitCertainty,
          reportAdmissionFailure,
          () => child(driver)
        );
  };
  return at(0);
}

/**
 * One handler around its child. Once the child ran, its failure is the
 * call's, whatever the handler returns or throws after it; a handler that
 * breaks the protocol fails the call with that refusal once the child
 * succeeded.
 */
async function runOneInterceptor<Result, Input extends object>(
  prepared: PreparedQueryContext<Input>,
  interceptor: ResolvedOperationHandler,
  child: Child<Result>,
  captureWriteOutcome: WriteOutcomeRegistrationCapture,
  readCommitCertainty: ReadCommitCertainty | undefined,
  reportAdmissionFailure: ((failure: unknown) => void) | undefined,
  core: () => Promise<Result>
): Promise<Result> {
  const { extension } = interceptor;
  const directRead =
    prepared.mode === "direct" &&
    prepared.kind === "model" &&
    isReadOperation(prepared.operation);
  // A direct read may run once more after its handler returned (a value
  // served now and refreshed later): that run is the core's alone.
  let replayable = directRead;
  let open = true;
  let settled = false;
  let childFailed = false;
  let running: Promise<Result> | undefined;
  let protocolFailure: QueryError | undefined;
  const refuse = (failure: string): QueryError => {
    if (protocolFailure === undefined) {
      protocolFailure = interceptorError(extension, prepared, failure);
      reportAdmissionFailure?.(protocolFailure);
    }
    return protocolFailure;
  };
  const proceed = (driver?: AnyDriver): Promise<Result> => {
    if (!open) throw refuse("called proceed more than once");
    if (settled) throw refuse("called proceed after its handler settled");
    open = false;
    childFailed = false;
    const promise = startChild(() => child(driver));
    // Attached first, so a handler's own `catch` already reads it.
    promise.then(undefined, () => {
      childFailed = true;
    });
    running = promise;
    return promise;
  };
  const capabilities: QueryInterceptorCapabilities<Result> = {
    proceed: () => proceed(),
    onWriteOutcome(listener) {
      if (!isFunction(listener))
        throw refuse("registered a non-function write-outcome listener");
      if (running !== undefined || settled)
        throw refuse("registered a write-outcome listener after proceed");
      captureWriteOutcome(Object.freeze({ extension, listener }));
    },
    // A direct call whose child failed with nothing written, or maybe
    // written, may be made again: once per failure.
    again() {
      if (
        prepared.mode !== "direct" ||
        !childFailed ||
        settled ||
        readCommitCertainty?.() !== undefined
      )
        return false;
      childFailed = false;
      open = true;
      return true;
    },
    proceedOn: (driver) => (directRead ? proceed(driver) : proceed()),
    replay() {
      if (!replayable) throw refuse("ran the call again");
      replayable = false;
      return startChild(core);
    },
  };
  // `kind`, `model` and `operation` are copied from one prepared context, so
  // they stay one of its arms; TypeScript cannot correlate the copies.
  // `input` is read through: the prepared context snapshots it at the first
  // read, which a handler that never inspects it does not pay for.
  const handlerContext = Object.freeze({
    mode: prepared.mode,
    kind: prepared.kind,
    model: prepared.model,
    operation: prepared.operation,
    get input() {
      return prepared.input;
    },
    ...(prepared.kind === "model" && { call: prepared.call }),
    // For the handlers of the `query` member to take their own from.
    ...(prepared.kind === "model" &&
      prepared.controls !== undefined && { controls: prepared.controls }),
    ...capabilities,
  }) as QueryInterceptorContext<Result, Input>;
  let outcome: { readonly value: Result } | { readonly reason: unknown };
  try {
    outcome = {
      value: await Reflect.apply(interceptor.handler, undefined, [
        handlerContext,
      ]),
    };
  } catch (reason) {
    outcome = { reason };
  }
  settled = true;
  const failure =
    "reason" in outcome &&
    (protocolFailure === undefined || outcome.reason !== protocolFailure)
      ? interceptorFailure(
          extension,
          prepared,
          outcome.reason,
          readCommitCertainty?.()
        )
      : undefined;
  if (running === undefined) {
    if (protocolFailure !== undefined) throw protocolFailure;
    if (failure !== undefined) throw failure;
    if (requiresProceed(prepared))
      throw interceptorError(extension, prepared, "completed without proceed");
  } else {
    if (failure !== undefined && !childFailed)
      reportAdmissionFailure?.(failure);
    await running;
  }
  if ("value" in outcome && protocolFailure === undefined) return outcome.value;
  throw protocolFailure ?? failure;
}

function startChild<Result>(child: () => Promise<Result>): Promise<Result> {
  try {
    return Promise.resolve(child());
  } catch (reason) {
    return Promise.reject(reason);
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
  return new QueryError(
    `Extension "${extension}" query handler for ${context.kind === "model" ? `${context.model}.${context.operation}` : context.operation} ${failure}.`,
    {
      ...(cause && { cause }),
      meta: {
        method: "query",
        model: context.model,
        operation: String(context.operation),
        ...(commitCertainty === undefined ? {} : { commitCertainty }),
      },
    }
  );
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

/**
 * Run one transaction whose write outcomes this scope collects. A root scope
 * tracks the commit phases, so a failure after COMMIT was sent still reports
 * its certainty and publishes what may have committed; a savepoint promotes
 * its outcomes into the parent collector, which owns that decision.
 */
export async function runOutcomeTransaction<T>(
  driver: AnyDriver,
  outcomes: TransactionWriteOutcomes,
  parentOutcomes: TransactionWriteOutcomes | undefined,
  options: TransactionOptions | undefined,
  context: QueryExecutionContext,
  body: (driver: AnyDriver) => Promise<T>,
  report?: (certainty: WriteOutcome["certainty"]) => void
): Promise<T> {
  let phase: "ready" | "committed" | undefined;
  let result: T;
  try {
    result = await driver.withTransaction(
      body,
      options,
      parentOutcomes
        ? context
        : bindExecutionTransactionPhases(context, {
            readyToCommit: () => {
              phase = "ready";
            },
            committed: () => {
              phase = "committed";
            },
          })
    );
  } catch (failure) {
    if (phase === undefined) {
      outcomes.discardAll();
      throw failure;
    }
    const certainty = phase === "ready" ? "may-have-committed" : phase;
    report?.(certainty);
    const primary = isVibORMError(failure)
      ? attachCommitCertainty(failure, certainty)
      : failure;
    try {
      await outcomes.publish(certainty);
    } catch (outcomeFailure) {
      throw retainWriteOutcomeFailure(primary, outcomeFailure);
    }
    throw primary;
  }
  if (parentOutcomes) outcomes.promoteTo(parentOutcomes);
  else {
    report?.("committed");
    await outcomes.publishCommitted();
  }
  return result;
}

/**
 * Deliver every registered listener in registration order, all of them. The
 * first fault rejects: an error of viborm's own as it is, any other value as
 * the cause of a `QueryError`; later faults are lost.
 */
export async function publishWriteOutcomes(
  registrations: readonly WriteOutcomeRegistration[],
  outcome: WriteOutcome
): Promise<void> {
  let first: { readonly failure: Error } | undefined;
  for (const registration of registrations) {
    try {
      await registration.listener(outcome);
    } catch (reason) {
      if (first !== undefined) continue;
      const cause = isError(reason) ? reason : undefined;
      first = {
        failure:
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
              ),
      };
    }
  }
  if (first !== undefined) throw first.failure;
}

import type { Operations } from "@client/types";

/**
 * `query`: handlers around each prepared call, written as a definition's raw
 * member (one handler of every call, or one per model and operation): what
 * the tests of the host give it. A chain built with this part always holds a
 * lookup, empty where no definition declared one.
 */
export const queryPart: ExtensionPart = {
  join({ next, chain, definition, owner }) {
    const contribution = definition.query;
    const declared = owner.controls;
    // A handler sees its own extension's controls, and only those.
    const own = (
      handler: RuntimeQueryFunction,
      on?: PlacedHandler["on"]
    ): PlacedHandler =>
      Object.freeze({
        extension: owner.name,
        handler: ({
          controls,
          ...context
        }: {
          readonly kind: string;
          readonly controls?: AdmittedControls;
        }) =>
          Reflect.apply(handler, undefined, [
            Object.freeze(
              declared === undefined || context.kind !== "model"
                ? context
                : { ...context, controls: controlsOwnedBy(controls, declared) }
            ),
          ]),
        controls: declared,
        on,
      });
    const added =
      typeof contribution === "function"
        ? [own(contribution)]
        : Object.entries(contribution ?? {}).flatMap(([model, operations]) =>
            Object.entries(operations).map(([operation, handler]) =>
              own(handler, {
                models: new Set([model]),
                operations: new Set([operation]),
              })
            )
          );
    if (added.length === 0 && chain?.query !== undefined) return;
    next.query = Object.freeze(
      handlersOf([...(chain?.query?.placed ?? []), ...added])
    );
    if (next.query.placed.length > 0) coordinate(next, QUERIES);
  },
};
