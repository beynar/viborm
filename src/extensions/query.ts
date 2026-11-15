import { attachCommitCertainty } from "@drivers/driver-error-context";
import type { AnyDriver } from "@drivers/exports";
import {
  isVibORMError,
  QueryError,
  retainWriteOutcomeFailure,
  VibORMError,
} from "@errors";
import { isReadOperation } from "@query-engine/routed-operations";
import { errorCause, isError } from "../errors/diagnostic-safety";
import type { AdmittedArgs } from "./arguments";
import type { CallHandler } from "./chain";
import { ATTEMPT, CALL, type CallOrigin } from "./origin";

export type CallMode = "direct" | "transaction" | "array";

export type RawQueryKind =
  | "queryRaw"
  | "executeRaw"
  | "queryRawUnsafe"
  | "executeRawUnsafe";

export type RawQueryOperation = `$${RawQueryKind}`;

interface PreparedQueryContextBase<Input extends object> {
  readonly mode: CallMode;
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
   * The call's admitted arguments. A handler sees only its own extension's,
   * and only when that extension declares any.
   */
  readonly values?: AdmittedArgs;
}

export interface PreparedRawQueryContext<Input extends object>
  extends PreparedQueryContextBase<Input> {
  readonly kind: RawQueryKind;
  readonly model: undefined;
  readonly operation: RawQueryOperation;
}

/** The prepared logical-operation facts safe for `around` parts to inspect. */
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
  /**
   * What installs a transaction scope's collector, brought by the word that
   * registered (`settled`); absent, the scope's own, installed at its start
   * by a chain whose parts hear writes.
   */
  readonly collect?: typeof collect;
  /**
   * What tells a call's registrations of its outcome, brought by what
   * registered (`settled`, the part that watches writes): a chain where
   * nothing registers carries none of it.
   */
  readonly tell?: typeof tell;
  /** In a transaction: the call reached its outcome, so it is told at the scope's end. */
  ok?: true;
}

export interface WriteOutcomeNotifications {
  readonly committed: () => Promise<void>;
  readonly mayHaveCommitted: () => Promise<void>;
}

/** A `run()` no second moment may make once it returned. */
const AFTER_RETURN = "called run() after its second moment returned";

/** The child a handler chain runs: on the driver a handler chose, if any. */
type Child<Result> = (driver?: AnyDriver) => Promise<Result>;

/** What one `around` part runs for a call: its second moment, handed `run` by the runner. */
export type AroundRunner = (
  prepared: PreparedQueryContext<object>,
  run: () => Promise<unknown>
) => unknown;

/** The `around` parts one call runs, the first applied outermost. */
export type AroundHandlers = readonly CallHandler<AroundRunner>[];

type Certainty = WriteOutcome["certainty"];

/** Private coordination hooks used only while array members await admission. */
export interface AdmissionHooks {
  readonly reportAdmissionFailure?: (failure: unknown) => void;
  readonly readCommitCertainty?: () => Certainty | undefined;
}

/** The child of a prepared call, told of the commits it reaches. */
type PreparedChild<Result> = (
  notifications?: WriteOutcomeNotifications,
  driver?: AnyDriver
) => Promise<Result>;

/**
 * Execute one prepared operation through its `around` parts and under what
 * its write registered.
 */
export function executePreparedQuery<Result, Input extends object>(
  context: PreparedQueryContext<Input> | undefined,
  arounds: AroundHandlers | undefined,
  child: PreparedChild<Result>,
  isWrite: boolean,
  scope?: TransactionScope,
  hooks?: AdmissionHooks,
  registration?: WriteOutcomeRegistration
): Promise<Result> {
  // A context is prepared only for a call some `around` part wraps.
  const intercepted = context !== undefined;
  if (!(intercepted || registration)) return child();
  return isWrite || registration
    ? executeRegisteredQuery(
        context,
        arounds,
        child,
        isWrite,
        scope,
        hooks,
        registration,
        runArounds
      )
    : runArounds(
        context!,
        arounds,
        (driver) => child(undefined, driver),
        hooks?.readCommitCertainty,
        hooks?.reportAdmissionFailure
      );
}

/**
 * One write under what it registered (the registration a model write's
 * watches made, or the `settled` functions a raw statement's first moments
 * kept on it), around its `around` parts when `intercept` runs them, which
 * {@link executePreparedQuery} passes: a chain without `around` parts does
 * not carry their runner. Each commit the child reports is told (outside a
 * transaction, the certainty it reached is what `again` reads), and a write
 * that succeeded without reporting one is told it committed.
 */
export function executeRegisteredQuery<Result, Input extends object>(
  context: PreparedQueryContext<Input> | undefined,
  arounds: AroundHandlers | undefined,
  child: PreparedChild<Result>,
  isWrite: boolean,
  scope?: TransactionScope,
  hooks?: AdmissionHooks,
  registration?: WriteOutcomeRegistration,
  intercept?: typeof runArounds
): Promise<Result> {
  const registrations = registration ? [registration] : context?.call?.told;
  const told = registrations?.[0]?.tell?.(registrations, scope);
  let reported = false;
  let certainty: Certainty | undefined;
  const notified = (reached: Certainty) => async (): Promise<void> => {
    reported = true;
    if (!scope) certainty = reached;
    await told?.(reached);
  };
  const notifications: WriteOutcomeNotifications = {
    committed: notified("committed"),
    mayHaveCommitted: notified("may-have-committed"),
  };
  // What fails before its outcome is reached is never marked, so never told.
  const executeChild = async (driver?: AnyDriver): Promise<Result> => {
    const value = await child(notifications, driver);
    if (isWrite && !reported) await notifications.committed();
    return value;
  };
  return intercept && context && arounds?.length
    ? intercept(
        context,
        arounds,
        executeChild,
        () => certainty ?? hooks?.readCommitCertainty?.(),
        hooks?.reportAdmissionFailure
      )
    : executeChild();
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
  readCommitCertainty?: () => Certainty | undefined,
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
          readCommitCertainty,
          reportAdmissionFailure,
          () => child(driver)
        );
  };
  return at(0);
}

/**
 * One `run` of one `around` part, as the words that read it find it
 * (`again`, `via`): what may start the child, and what happened to it.
 */
export interface Attempt {
  /** `run()` may start the child. */
  open: boolean;
  /** The child's last start failed. */
  failed: boolean;
  /** The second moment returned. */
  done: boolean;
  /** A direct call outside a transaction and an array. */
  readonly direct: boolean;
  /** A direct read: what `via` may run on another driver. */
  readonly routable: boolean;
  readonly certainty: (() => Certainty | undefined) | undefined;
  readonly start: (driver?: AnyDriver) => Promise<unknown>;
}

/**
 * One handler around its child. Once the child ran, its failure is the
 * call's, whatever the handler returns or throws after it; a handler that
 * breaks the protocol fails the call with that refusal once the child
 * succeeded.
 */
async function runAround<Result, Input extends object>(
  prepared: PreparedQueryContext<Input>,
  part: CallHandler<AroundRunner>,
  child: Child<Result>,
  readCommitCertainty: (() => Certainty | undefined) | undefined,
  reportAdmissionFailure: ((failure: unknown) => void) | undefined,
  core: () => Promise<Result>
): Promise<Result> {
  const { extension } = part;
  const direct = prepared.mode === "direct";
  const routable =
    direct && prepared.kind === "model" && isReadOperation(prepared.operation);
  // A direct read may run once more after its handler returned (a value
  // served now and refreshed later): that run is the core's alone.
  let replayable = routable;
  let running: Promise<Result> | undefined;
  let protocolFailure: QueryError | undefined;
  const refuse = (failure: string): QueryError => {
    if (protocolFailure === undefined) {
      protocolFailure = aroundError(extension, prepared, failure);
      reportAdmissionFailure?.(protocolFailure);
    }
    return protocolFailure;
  };
  const attempt: Attempt = {
    open: true,
    failed: false,
    done: false,
    direct,
    routable,
    certainty: readCommitCertainty,
    start(driver) {
      if (!attempt.open) throw refuse("called run() more than once");
      if (attempt.done) throw refuse(AFTER_RETURN);
      attempt.open = false;
      attempt.failed = false;
      // What the child throws, even at once, is its promise's rejection.
      running = (async () => child(driver))();
      // Attached first, so a handler's own `catch` already reads it.
      running.then(undefined, () => {
        attempt.failed = true;
      });
      return running;
    },
  };
  const run = Object.defineProperties(
    (): Promise<unknown> => {
      if (!attempt.done) return attempt.start();
      if (!replayable) throw refuse(AFTER_RETURN);
      replayable = false;
      return (async () => core())();
    },
    {
      // Read when asked: the context snapshots the input the first time.
      input: { get: () => prepared.input },
      mode: { value: prepared.mode },
      [CALL]: { value: prepared.kind === "model" ? prepared.call : undefined },
      [ATTEMPT]: { value: attempt },
    }
  );
  let outcome: { readonly value: Result } | { readonly reason: unknown };
  try {
    outcome = {
      // A second moment answers the call: `around`'s types hold its value
      // to the call's result.
      value: (await part.handler(prepared, run)) as Result,
    };
  } catch (reason) {
    outcome = { reason };
  }
  attempt.done = true;
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
    if (failure !== undefined) throw failure;
    if (
      prepared.mode === "array" ||
      prepared.kind !== "model" ||
      !isReadOperation(prepared.operation)
    )
      throw aroundError(extension, prepared, "returned without run()");
  } else {
    if (failure !== undefined && !attempt.failed)
      reportAdmissionFailure?.(failure);
    await running;
  }
  if ("value" in outcome && protocolFailure === undefined) return outcome.value;
  throw protocolFailure ?? failure;
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
    errorCause(reason),
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
        operation: context.operation,
        ...(commitCertainty === undefined ? {} : { commitCertainty }),
      },
    }
  );
}

/**
 * The collector of one transaction scope: the registrations its calls
 * staged, each told at the scope's end if its call reached its outcome.
 */
export class TransactionWriteOutcomes {
  readonly staged: WriteOutcomeRegistration[] = [];

  /** Tell what reached its outcome; a native batch's scope ends so. */
  publish(certainty: Certainty): Promise<void> {
    return publishWriteOutcomes(
      this.staged.filter((registration) => registration.ok),
      { certainty }
    );
  }

  /**
   * End the scope this collects for, with what its transaction settled
   * with. A savepoint that commits hands what it collected to its parent's
   * collector, which owns the decision; the outermost publishes it after
   * its commit, or, when its commit failed after COMMIT was sent, with the
   * certainty reached, which the failure then carries.
   */
  async end<T>(
    { parent, root }: TransactionScope,
    settled: T,
    failed?: true
  ): Promise<T> {
    if (!failed) {
      if (parent)
        collect(parent).staged.push(
          ...this.staged.filter((registration) => registration.ok)
        );
      else await this.publish("committed");
      return settled;
    }
    const { certainty } = root;
    if (parent || certainty === undefined) throw settled;
    const primary = isVibORMError(settled)
      ? attachCommitCertainty(settled, certainty)
      : settled;
    try {
      await this.publish(certainty);
    } catch (outcomeFailure) {
      throw retainWriteOutcomeFailure(primary, outcomeFailure);
    }
    throw primary;
  }
}

/**
 * One transaction scope, as `transact` (`coordination.ts`) runs it: what its
 * calls register waits in it until it ends. The scope holds no code: the
 * first registration installs the collector (`collect`), which brings the
 * code that ends the scope, so a transaction where nothing registers runs
 * none of it.
 */
export interface TransactionScope {
  /** The scope this one is a savepoint of. */
  readonly parent: TransactionScope | undefined;
  /** The outermost scope's commit phase, as its driver reports it. */
  readonly root: CommitPhase;
  outcomes?: TransactionWriteOutcomes;
}

/** How far a transaction's commit went; nothing before COMMIT was sent. */
export interface CommitPhase {
  certainty?: Certainty;
}

/** The collector of a transaction scope, installed by its first registration. */
export function collect(scope: TransactionScope): TransactionWriteOutcomes {
  scope.outcomes ??= new TransactionWriteOutcomes();
  return scope.outcomes;
}

/**
 * What tells one call's registrations of the commits it reaches: inside a
 * transaction, each is staged in the scope and marked once the call reached
 * its outcome, told when the scope ends; outside one, each commit is told.
 */
export function tell(
  registrations: readonly WriteOutcomeRegistration[],
  scope: TransactionScope | undefined
): (certainty: Certainty) => Promise<void> {
  if (scope === undefined)
    return (certainty) => publishWriteOutcomes(registrations, { certainty });
  for (const registration of registrations)
    (registration.collect?.(scope) ?? scope.outcomes)?.staged.push(
      registration
    );
  return async () => {
    for (const registration of registrations) registration.ok = true;
  };
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
  let first: unknown;
  for (const { extension, listener } of registrations) {
    try {
      await listener(outcome);
    } catch (reason) {
      first ??=
        reason instanceof VibORMError
          ? reason
          : new QueryError(
              `Extension "${extension}" settled() failed (${outcome.certainty}).`,
              {
                cause: errorCause(reason),
                meta: {
                  method: "settled",
                  commitCertainty: outcome.certainty,
                },
              }
            );
    }
  }
  if (first) throw first;
}
