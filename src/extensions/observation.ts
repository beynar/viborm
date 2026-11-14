/**
 * The one generation of unit handlers: what runs a unit under a chain's
 * `unit` parts, and `work`, by which an extension emits a unit of its own.
 */
import {
  getExecutionExtensionChain,
  isRecoverableExecution,
  trustedExecutionContext,
} from "@drivers/execution-context";
import { QueryError } from "@errors";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { Sql } from "@sql";
import type { ExtensionPart } from "./chain";
import { coordinate, UNITS } from "./coordination";
import { scopeOf } from "./origin";
import { collect } from "./query";
import {
  originOf,
  type TransactionStatementRunner,
  type Unit,
  type UnitEnd,
  type UnitHandler,
  type UnitKind,
  type UnitSource,
  unitOf,
} from "./unit-source";

/**
 * What a unit runs at its core, once every handler called `next()`: given
 * the statement a logical statement's rewriting units handed on.
 */
export type Child<Result> = (statement?: Sql) => Promise<Result>;

/** One `unit` part of a chain: its extension, its handler, its kinds. */
export interface UnitLayer {
  readonly extension: string;
  readonly handler: UnitHandler;
  /** The kinds it runs around; every kind when absent. */
  readonly kinds?: readonly UnitKind[] | undefined;
}

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
  handlers: readonly UnitLayer[],
  source: UnitSource,
  child: Child<Result>,
  reached?: () => void
): Promise<Result> {
  const unit = unitOf(source);
  let core: Promise<Result> | undefined;
  let entered = false;
  const startCore = (): Promise<Result> => {
    core ??= attempt(() => child(source.statement));
    return core;
  };
  const transaction =
    source.kind === "transaction"
      ? openTransaction(source, startCore)
      : undefined;
  const enter = (index: number): Promise<Result> => {
    const resolved = handlers[index];
    // A layer that names other kinds is not around this unit at all.
    if (resolved?.kinds?.includes(source.kind) === false)
      return enter(index + 1);
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
  resolved: UnitLayer,
  unit: Unit,
  source: UnitSource,
  rest: () => Promise<Result>
): Promise<Result> {
  let started: Promise<Result> | undefined;
  let misuse: QueryError | undefined;
  // `next(sql)` hands on another statement to a logical statement's rest.
  const next = (statement?: Sql): Promise<UnitEnd> => {
    if (started !== undefined) {
      misuse ??= unitError(resolved, unit, "called next() more than once");
      return Promise.reject(misuse);
    }
    const at = Date.now();
    const handed = statement !== undefined && source.statement !== undefined;
    // The statement is rendered after every rewrite: refused here, it is
    // refused in the extension's name, not as the renderer's TypeError.
    if (handed && !(statement instanceof Sql))
      started = Promise.reject(
        unitError(resolved, unit, "handed next() something not a statement")
      );
    else {
      if (handed) source.statement = statement;
      started = rest();
    }
    return started.then(
      () => settle(source, at, false, undefined),
      (failure: unknown) => settle(source, at, true, failure)
    );
  };
  let returned: unknown;
  try {
    returned = resolved.handler(unit, next);
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
  source.settledAt ??= Date.now();
  const certainty = source.certainty?.();
  return {
    status: failed ? "failure" : "success",
    duration: Math.max(0, source.settledAt - at),
    ...(certainty === undefined ? {} : { certainty }),
    ...(failed && isRecoverableExecution(source.context)
      ? { recovered: true as const }
      : {}),
  };
}

function unitError(
  resolved: UnitLayer,
  unit: Unit,
  failure: string
): QueryError {
  return new QueryError(
    `Extension "${resolved.extension}" unit() for ${unit.kind} ${failure}.`,
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
  const openedWith = (run: TransactionStatementRunner) => {
    runner = run;
    announce?.(run);
    if (aborted !== undefined) return Promise.reject(aborted.failure);
    if (bodyEntered) return undefined;
    return new Promise<void>((resolve, reject) => {
      ready = resolve;
      refuse = reject;
    });
  };
  // Named first, then stored: a function literal assigned to a property is
  // allocated outside the young generation and keeps the unit alive.
  source.opened = openedWith;
  const runIn = (statement: Sql) => {
    if (runner !== undefined) return runner(statement);
    const core = startCore();
    return Promise.race([
      opened,
      core.then(() => {
        throw new QueryError("run() was called on a transaction that ended.");
      }),
    ]).then((run) => run(statement));
  };
  source.run = runIn;
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
  readonly handlers: readonly UnitLayer[];
  readonly run: <Result>(
    source: UnitSource,
    child: Child<Result>
  ) => Promise<Result>;
  /**
   * One member of `$transaction([...])`: its unit runs until its child is
   * reached. The array waits for every member's `reached` before it prepares
   * any: a handler that waits (for a tracer to load) does so before the
   * array's work, and each member's work runs inside its unit.
   */
  readonly enter: <Result>(
    source: UnitSource,
    child: Child<Result>
  ) => { readonly done: Promise<Result>; readonly reached: Promise<void> };
  /**
   * Every member's unit, entered: resolves once each reached its child, with
   * what settles once every unit did (and fails as the first that failed).
   */
  readonly members: (
    members: readonly (readonly [UnitSource, Child<unknown>])[]
  ) => Promise<{ readonly done: Promise<unknown> }>;
}

export function observationOf(handlers: readonly UnitLayer[]): Observation {
  const enter: Observation["enter"] = (source, child) => {
    let reach: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const done = runUnit(handlers, source, child, reach);
    done.then(reach, reach);
    return { done, reached };
  };
  return {
    handlers,
    run: (source, child) => runUnit(handlers, source, child),
    enter,
    members: async (members) => {
      const units = members.map(([source, child]) => enter(source, child));
      await Promise.all(units.map((unit) => unit.reached));
      const done = Promise.all(units.map((unit) => unit.done));
      done.catch(() => undefined);
      return { done };
    },
  };
}

/**
 * The host part of one `unit(handler, kinds)`: it adds a layer to the
 * chain's units, the first extension outermost. It brings no interception
 * of `$transaction([...])`: the array starts every member's unit, and waits
 * until each reached its child, before it prepares any member.
 */
export function unitLayerPart(
  handler: UnitHandler,
  kinds: readonly UnitKind[] | undefined
): ExtensionPart {
  return {
    join({ next, owner }) {
      next.observation = observationOf([
        ...(next.observation?.handlers ?? []),
        { extension: owner.name, handler, kinds },
      ]);
      coordinate(next, UNITS, collect);
    },
  };
}

/**
 * Run `fn` as a unit of the extension's own (`kind` is any string), under
 * every `unit` part of the chain `origin` belongs to: `origin` is a call's
 * context or `run`, a unit a handler received, one `work` made, or a
 * method's scope. Without a chain that observes units, `fn` runs alone.
 * `fn` receives the unit, to `note` on it.
 */
export function work<Result>(
  origin: object,
  unit: {
    readonly kind: UnitKind;
    readonly operation: string;
    readonly model?: string;
    /** A first fact, noted before any handler sees the unit. */
    readonly note?: unknown;
  },
  fn: (unit: Unit) => Promise<Result>
): Promise<Result> {
  const scope = scopeOf(origin);
  const context =
    originOf(origin)?.context ??
    trustedExecutionContext(origin) ??
    // A method works outside any call: its unit is an execution of its own,
    // with its own correlation.
    (scope &&
      createOperationExecutionContext(
        unit.model ?? scope.extension,
        unit.operation,
        scope.engine.extensionChain
      ));
  const observation = getExecutionExtensionChain(context)?.observation;
  const source: UnitSource = {
    kind: unit.kind,
    operation: unit.operation,
    model: unit.model,
    context,
    notes: unit.note === undefined ? [] : [unit.note],
  };
  // `fn` gets a unit of the same record: what it notes, handlers read.
  return observation === undefined
    ? fn(unitOf(source))
    : observation.run(source, () => fn(unitOf(source)));
}
