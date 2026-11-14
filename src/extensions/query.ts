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
import { isError } from "../errors/diagnostic-safety";
import type { ResolvedOperationHandler } from "./chain";
import type { AdmittedControls } from "./controls";
import { AGAIN, CALL, type CallOrigin, VIA } from "./origin";

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
  /**
   * One object per call, the same one its first moments were handed: what
   * links an `around` part's two moments.
   */
  readonly call?: CallOrigin;
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
}

export interface PreparedRawQueryContext<Input extends object>
  extends PreparedQueryContextBase<Input> {
  readonly kind: RawQueryKind;
  readonly model: undefined;
  readonly operation: RawQueryOperation;
}

/** The prepared logical-operation facts safe for query arounds to inspect. */
export type PreparedQueryContext<
  Input extends object = Record<string, unknown>,
> = PreparedModelQueryContext<Input> | PreparedRawQueryContext<Input>;

export type WriteOutcome = Readonly<{
  certainty: "committed" | "may-have-committed";
}>;

export type WriteOutcomeListener = (
  outcome: WriteOutcome
) => unknown | Promise<unknown>;

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

/** A `run()` no second moment may make once it returned. */
const AFTER_RETURN = "called run() after its second moment returned";

/** The child a handler chain runs: on the driver a handler chose, if any. */
type Child<Result> = (driver?: AnyDriver) => Promise<Result>;

/**
 * What one `around` part runs for a call: its second moment, handed `run`
 * by the runner; `register` gives the runner the `settled` functions a raw
 * statement's first moment kept, told of the statement's outcome.
 */
export type AroundRunner = (
  prepared: PreparedQueryContext<object>,
  run: () => Promise<unknown>,
  register: (listener: WriteOutcomeListener) => void
) => unknown;

/** The `around` parts one call runs, the first applied outermost. */
export type AroundHandlers = readonly ResolvedOperationHandler<AroundRunner>[];

type ReadCommitCertainty = () => WriteOutcome["certainty"] | undefined;

/** Private coordination hooks used only while array members await admission. */
export interface AroundExecutionControl {
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
  arounds: AroundHandlers | undefined,
  child: (
    notifications?: WriteOutcomeNotifications,
    driver?: AnyDriver
  ) => Promise<Result>,
  isWrite: boolean,
  transactionWriteOutcomes?: TransactionWriteOutcomes,
  control?: AroundExecutionControl,
  preRegisteredWriteOutcome?: WriteOutcomeRegistration
): Promise<Result> {
  if (
    (context === undefined || arounds === undefined || arounds.length === 0) &&
    preRegisteredWriteOutcome === undefined
  ) {
    return child();
  }
  if (
    !isWrite &&
    preRegisteredWriteOutcome === undefined &&
    context !== undefined &&
    arounds !== undefined &&
    arounds.length > 0
  ) {
    return runArounds(
      context,
      arounds,
      (driver) => child(undefined, driver),
      discardReadWriteOutcomeRegistration,
      control?.readCommitCertainty,
      control?.reportAdmissionFailure
    );
  }
  return executeInterceptedQuery(
    context,
    arounds,
    child,
    isWrite,
    transactionWriteOutcomes,
    control,
    preRegisteredWriteOutcome,
    (prepared, handlers, executeChild, capture, ...rest) =>
      runArounds(
        prepared,
        handlers,
        executeChild,
        // Inside a transaction, only a collector holds a raw statement's
        // `settled` until the commit: without one it is refused.
        transactionWriteOutcomes !== undefined || prepared.mode === "direct"
          ? capture
          : refuseUncollected,
        ...rest
      )
  );
}

/**
 * {@link executePreparedQuery} on a chain without `around` parts: what
 * wraps the call is its write-outcome registration, the only reason it is
 * asked, so the code that runs handlers is not carried.
 */
export function executeRegisteredQuery<Result, Input extends object>(
  _context: PreparedQueryContext<Input> | undefined,
  _interceptors: AroundHandlers | undefined,
  child: (
    notifications?: WriteOutcomeNotifications,
    driver?: AnyDriver
  ) => Promise<Result>,
  isWrite: boolean,
  transactionWriteOutcomes?: TransactionWriteOutcomes,
  control?: AroundExecutionControl,
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
  arounds: AroundHandlers | undefined,
  child: (
    notifications?: WriteOutcomeNotifications,
    driver?: AnyDriver
  ) => Promise<Result>,
  isWrite: boolean,
  transactionWriteOutcomes: TransactionWriteOutcomes | undefined,
  control: AroundExecutionControl | undefined,
  preRegisteredWriteOutcome: WriteOutcomeRegistration | undefined,
  // Passed by the caller that has handlers to run: the one that has none
  // does not carry their runner.
  intercept?: typeof runArounds
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
      arounds === undefined ||
      arounds.length === 0
        ? await executeChild()
        : await intercept(
            context,
            arounds,
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
 * Run one already-compiled part chain around one prepared child, the
 * first handler outermost.
 *
 * The undefined/empty branch deliberately returns the child's promise directly:
 * unextended operations allocate no runner promise, context, closure, or list.
 */
export function runArounds<Result, Input extends object>(
  context: PreparedQueryContext<Input>,
  arounds: AroundHandlers | undefined,
  child: Child<Result>,
  captureWriteOutcome: WriteOutcomeRegistrationCapture,
  readCommitCertainty?: ReadCommitCertainty,
  reportAdmissionFailure?: (failure: unknown) => void
): Promise<Result> {
  const at = (index: number, driver?: AnyDriver): Promise<Result> => {
    const part = arounds?.[index];
    return part === undefined
      ? child(driver)
      : runAround(
          context,
          part,
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
async function runAround<Result, Input extends object>(
  prepared: PreparedQueryContext<Input>,
  part: ResolvedOperationHandler<AroundRunner>,
  child: Child<Result>,
  captureWriteOutcome: WriteOutcomeRegistrationCapture,
  readCommitCertainty: ReadCommitCertainty | undefined,
  reportAdmissionFailure: ((failure: unknown) => void) | undefined,
  core: () => Promise<Result>
): Promise<Result> {
  const { extension } = part;
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
      protocolFailure = aroundError(extension, prepared, failure);
      reportAdmissionFailure?.(protocolFailure);
    }
    return protocolFailure;
  };
  const start = (driver?: AnyDriver): Promise<Result> => {
    if (!open) throw refuse("called run() more than once");
    if (settled) throw refuse(AFTER_RETURN);
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
  const run = Object.defineProperties(
    (): Promise<Result> => {
      if (!settled) return start();
      if (!replayable) throw refuse(AFTER_RETURN);
      replayable = false;
      return startChild(core);
    },
    {
      input: { get: () => prepared.input },
      mode: { value: prepared.mode },
      [CALL]: { value: prepared.kind === "model" ? prepared.call : undefined },
      // A direct call whose child failed with nothing written, or maybe
      // written, may be made again: once per failure.
      [AGAIN]: {
        value: () => {
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
      },
      [VIA]: {
        value: (driver: AnyDriver) => (directRead ? start(driver) : start()),
      },
    }
  );
  let outcome: { readonly value: Result } | { readonly reason: unknown };
  try {
    outcome = {
      // A second moment answers the call: `around`'s types hold its value
      // to the call's result.
      value: (await part.handler(prepared, run, (listener) =>
        captureWriteOutcome({ extension, listener })
      )) as Result,
    };
  } catch (reason) {
    outcome = { reason };
  }
  settled = true;
  const failure =
    "reason" in outcome &&
    (protocolFailure === undefined || outcome.reason !== protocolFailure)
      ? aroundFailure(
          extension,
          prepared,
          outcome.reason,
          readCommitCertainty?.()
        )
      : undefined;
  if (running === undefined) {
    if (protocolFailure !== undefined) throw protocolFailure;
    if (failure !== undefined) throw failure;
    if (requiresRun(prepared))
      throw aroundError(extension, prepared, "returned without run()");
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

function requiresRun(context: PreparedQueryContext<object>): boolean {
  return (
    context.mode === "array" ||
    context.kind !== "model" ||
    !isReadOperation(context.operation)
  );
}

function aroundFailure<Input extends object>(
  extension: string,
  context: PreparedQueryContext<Input>,
  reason: unknown,
  commitCertainty?: WriteOutcome["certainty"]
): Error {
  if (isError(reason)) return reason;
  return aroundError(
    extension,
    context,
    "failed",
    new Error("around() rejected with a non-Error value"),
    commitCertainty
  );
}

function aroundError<Input extends object>(
  extension: string,
  context: PreparedQueryContext<Input>,
  failure: string,
  cause?: Error,
  commitCertainty?: WriteOutcome["certainty"]
): QueryError {
  return new QueryError(
    `Extension "${extension}" around() for ${context.kind === "model" ? `${context.model}.${context.operation}` : context.operation} ${failure}.`,
    {
      ...(cause && { cause }),
      meta: {
        method: "around",
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
    await outcomes.publish("committed");
  }
  return result;
}

/**
 * Refuse a `settled` registered inside a transaction whose chain collects no
 * write outcome: it could only be told before the commit, or never.
 */
export function refuseUncollected(): never {
  throw new TypeError(
    "settled() in a transaction needs a part on target(writes)"
  );
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
                `Extension "${registration.extension}" settled() failed (${outcome.certainty}).`,
                {
                  cause:
                    cause ??
                    new Error("settled() rejected with a non-Error value"),
                  meta: {
                    method: "settled",
                    commitCertainty: outcome.certainty,
                  },
                }
              ),
      };
    }
  }
  if (first !== undefined) throw first.failure;
}
