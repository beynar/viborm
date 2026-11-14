import { isRecoverableExecution } from "@drivers/execution-context";
import { QueryError } from "@errors";
import type { ExtensionPart, ResolvedExtensionHandler } from "./chain";
import { ARRAYS, coordinate } from "./coordination";
import {
  type TransactionStatementRunner,
  type Unit,
  type UnitEnd,
  type UnitHandler,
  type UnitSource,
  unitOf,
} from "./unit-source";

export type {
  CommitCertainty,
  Unit,
  UnitEnd,
  UnitHandler,
  UnitKind,
  UnitSource,
} from "./unit-source";

/** Kept under their former names for the entries that still export them. */
export type ObservationUnit = Unit;
export type ObservationCompletion = UnitEnd;
export type ObserveHandler = UnitHandler;
export type LifecycleUnit = Unit;

/** Formerly the facts handed to one observer; a unit's are read by words. */
export type ObservedFacts = never;

const nothing = (): undefined => undefined;

/**
 * Runs one unit under `handlers`, the first one outermost. Each handler is a
 * plain wrapper: the next one, and at the end the child, starts only when it
 * calls `next()`, and the host waits for the promise it returns. The child's
 * failure fails the unit; once the child succeeded, what a handler throws
 * does. `next()` is called once: never calling it, or calling it again,
 * fails the unit. The host contains nothing a handler does.
 */
export function runUnit<Result>(
  handlers: readonly ResolvedExtensionHandler[],
  source: UnitSource,
  child: () => Promise<Result>,
  reached?: () => void
): Promise<Result> {
  const unit = unitOf(source);
  let core: Promise<Result> | undefined;
  let entered = false;
  const startCore = (): Promise<Result> => {
    core ??= attempt(child);
    return core;
  };
  const transaction =
    source.kind === "transaction" ? openTransaction(source, startCore) : undefined;
  const enter = (index: number): Promise<Result> => {
    const resolved = handlers[index];
    if (resolved === undefined) {
      entered = true;
      reached?.();
      transaction?.enter();
      return startCore();
    }
    return around(resolved, unit, source, () => enter(index + 1));
  };
  const result = enter(0);
  return transaction === undefined
    ? result
    : result.catch(async (failure: unknown) => {
        // A transaction `run(unit, sql)` opened whose body was never let run
        // rolls back before the unit fails.
        if (core !== undefined && !entered) {
          transaction.abort(failure);
          await core.catch(nothing);
        }
        throw failure;
      });
}

function attempt<Result>(child: () => Promise<Result>): Promise<Result> {
  try {
    return child();
  } catch (failure) {
    return Promise.reject(failure);
  }
}

/** One handler around the rest of the unit. */
async function around<Result>(
  resolved: ResolvedExtensionHandler,
  unit: Unit,
  source: UnitSource,
  rest: () => Promise<Result>
): Promise<Result> {
  let started: Promise<Result> | undefined;
  let misuse: QueryError | undefined;
  const next = (): Promise<UnitEnd> => {
    if (started !== undefined) {
      misuse ??= unitError(resolved, unit, "called next() more than once");
      return Promise.reject(misuse);
    }
    const at = Date.now();
    started = rest();
    return started.then(
      () => settle(source, at, false, undefined),
      (failure: unknown) => settle(source, at, true, failure)
    );
  };
  let returned: unknown;
  try {
    returned = Reflect.apply(resolved.handler, undefined, [unit, next]);
  } catch (failure) {
    returned = Promise.reject(failure);
  }
  let handlerFailure: { readonly failure: unknown } | undefined;
  try {
    await returned;
  } catch (failure) {
    handlerFailure = { failure };
  }
  if (started === undefined)
    throw (
      handlerFailure?.failure ??
      unitError(resolved, unit, "settled without calling next()")
    );
  const value = await started;
  if (handlerFailure !== undefined) throw handlerFailure.failure;
  if (misuse !== undefined) throw misuse;
  return value;
}

function settle(
  source: UnitSource,
  at: number,
  failed: boolean,
  failure: unknown
): UnitEnd {
  source.failed = failed;
  source.failure = failure;
  const certainty = source.certainty?.();
  return {
    status: failed ? "failure" : "success",
    duration: Math.max(0, Date.now() - at),
    ...(certainty === undefined ? {} : { certainty }),
    ...(failed && isRecoverableExecution(source.context)
      ? { recovered: true as const }
      : {}),
  };
}

function unitError(
  resolved: ResolvedExtensionHandler,
  unit: Unit,
  failure: string
): QueryError {
  return new QueryError(
    `Extension "${resolved.extension}" unit handler for ${unit.kind} ${failure}.`,
    { meta: { method: "unit", operation: unit.operation, model: unit.model } }
  );
}

/**
 * A transaction unit's `run(unit, sql)`: it opens the transaction if no
 * `next()` has yet, and runs the statement there before the body. The body
 * then waits for the innermost `next()`.
 */
function openTransaction<Result>(
  source: UnitSource,
  startCore: () => Promise<Result>
) {
  let runner: TransactionStatementRunner | undefined;
  let ready: (() => void) | undefined;
  let refuse: ((failure: unknown) => void) | undefined;
  let aborted: { readonly failure: unknown } | undefined;
  let bodyEntered = false;
  let announce: ((run: TransactionStatementRunner) => void) | undefined;
  const opened = new Promise<TransactionStatementRunner>((resolve) => {
    announce = resolve;
  });
  source.opened = (run) => {
    runner = run;
    announce?.(run);
    if (aborted !== undefined) return Promise.reject(aborted.failure);
    if (bodyEntered) return undefined;
    return new Promise<void>((resolve, reject) => {
      ready = resolve;
      refuse = reject;
    });
  };
  source.run = (statement) => {
    if (runner !== undefined) return runner(statement);
    const core = startCore();
    return Promise.race([
      opened,
      core.then(() => {
        throw new QueryError("run() was called on a transaction that ended.");
      }),
    ]).then((run) => run(statement));
  };
  return {
    enter: () => {
      bodyEntered = true;
      ready?.();
    },
    abort: (failure: unknown) => {
      aborted = { failure };
      refuse?.(failure);
    },
  };
}

/** What runs a unit under a chain's handlers. */
export interface Observation {
  readonly handlers: readonly ResolvedExtensionHandler[];
  readonly run: <Result>(
    source: UnitSource,
    child: () => Promise<Result>
  ) => Promise<Result>;
  /**
   * One member of `$transaction([...])`: its unit runs until its child is
   * reached. The array waits for every member's `reached` before it prepares
   * any: a handler that waits (for a tracer to load) does so before the
   * array's work, and each member's work runs inside its unit.
   */
  readonly enter: <Result>(
    source: UnitSource,
    child: () => Promise<Result>
  ) => { readonly done: Promise<Result>; readonly reached: Promise<void> };
}

function observationOf(
  handlers: readonly ResolvedExtensionHandler[]
): Observation {
  return {
    handlers,
    run: (source, child) => runUnit(handlers, source, child),
    enter: (source, child) => {
      let reach: (() => void) | undefined;
      const reached = new Promise<void>((resolve) => {
        reach = resolve;
      });
      const done = runUnit(handlers, source, child, reach);
      done.then(reach, reach);
      return { done, reached };
    },
  };
}

/** `observe`: a handler around each unit of real work. */
export const observePart: ExtensionPart = {
  members: ["observe"],
  join({ next, chain, definition, owner }) {
    const handler = definition.observe;
    if (handler === undefined) return;
    next.observation = observationOf([
      ...(chain?.observation?.handlers ?? []),
      { extension: owner.name, handler },
    ]);
    coordinate(next, ARRAYS);
  },
};
