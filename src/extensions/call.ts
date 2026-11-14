/**
 * `call(fn, target?)` and `around(fn, target?, options?)`: a function on each
 * logical call, in two moments. Every first moment runs in chain order,
 * synchronously, before the call is validated: it reads the arguments and
 * this extension's own (`c.args`, `c.values`), patches the arguments
 * (`c.set`), or refuses the call by throwing. A first moment of
 * `around` may return a second moment, which runs around the prepared
 * call once every first moment ran and the call was validated: the first
 * extension applied outermost. `run()` executes the call once; its failure
 * is the call's, whatever the second moment does after it.
 */
import type { Operations, Schema } from "@client/types";
import type { AnyDriver } from "@drivers/exports";
import { QueryError, VibORMError } from "@errors";
import { isFunction, isRecord } from "@validation/value-guards";
import { errorCause } from "../errors/diagnostic-safety";
import type { Application, ExtensionPart } from "./chain";
import type { ResolvedOperationHandler } from "./chain-state";
import type {
  AnyTarget,
  AroundFacts,
  AroundHandler,
  EmptyFacts,
  MomentOne,
  Part,
  Selection,
} from "./contract";
import { type AdmittedControls, controlsOwnedBy } from "./controls";
import { coordinate, QUERIES } from "./coordination";
import { extensionError } from "./definition";
import { builtPart, type DefinitionDraft } from "./extension";
import { compileHandlers, type OperationHandlers } from "./handlers";
import { MODEL_OPERATIONS, type SelectionValue, selectionOf } from "./on";
import type { QueryInterceptorContext } from "./query";
import type { RequestControls, RuntimeRequestContribution } from "./request";
import { REGISTER, type Watching, watched, watchPart } from "./watch-part";

/** One `call` or `around` part, as the extension wrote it. */
export interface CallEntry {
  readonly handler: (context: never) => unknown;
  readonly on: SelectionValue | undefined;
  readonly around: boolean;
  readonly inner: boolean;
}

/** What a first moment is handed, beside what `contract.ts` types. */
interface FirstContext {
  readonly kind: "model" | "raw";
  readonly schema: Schema | undefined;
  readonly model: string | undefined;
  readonly operation: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly values: AdmittedControls;
  set(patch: unknown): void;
  /**
   * What `watch` and `settled` register through: false where nothing would
   * tell the watch, which `call-words.ts` refuses.
   */
  readonly [REGISTER]: (watching: Watching) => boolean;
}

/** The keys a second moment's `run` carries for `again` and `via`. */
export const AGAIN = Symbol("viborm.again");
export const VIA = Symbol("viborm.via");

/** What `again(run)` and `via(run, driver)` read of a `run`. */
export interface RunCapabilities {
  readonly [AGAIN]: () => boolean;
  readonly [VIA]: (driver: AnyDriver) => Promise<unknown>;
}

type FirstMoment = (context: FirstContext) => unknown;
type SecondMoment = (run: unknown) => unknown;

/**
 * Per call, what each first moment returned for its second: kept beside
 * the call, never on a chain, and gone with the call.
 */
const seconds = new WeakMap<object, Map<FirstMoment, SecondMoment>>();
/** The schema each first moment's extension was applied to. */
const schemas = new WeakMap<CallableFunction, Schema>();

const NO_VALUES: AdmittedControls = Object.freeze({});

/** The keys of a call's arguments that decide its result's shape. */
const SHAPE_KEYS: ReadonlySet<string> = new Set([
  "select",
  "include",
  "omit",
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
  "by",
]);

function failure(
  extension: string,
  model: string | undefined,
  operation: string,
  problem: string,
  cause?: unknown
): QueryError {
  return new QueryError(
    `Extension "${extension}" request handler for ${model === undefined ? operation : `${model}.${operation}`} ${problem}.`,
    { cause: errorCause(cause), meta: { model, operation } }
  );
}

/**
 * Run one first moment: what it throws refuses the call (an error of
 * viborm's own as it is, any other as the cause of a `QueryError`); a
 * promise is refused; a second moment is kept for the call.
 */
function runFirst(
  handler: ResolvedOperationHandler,
  context: FirstContext,
  call: object | undefined
): SecondMoment | undefined {
  const { extension } = handler;
  const { model, operation } = context;
  let returned: unknown;
  try {
    returned = (handler.handler as FirstMoment)(context);
  } catch (cause) {
    if (cause instanceof VibORMError) throw cause;
    throw failure(extension, model, operation, "threw", cause);
  }
  if (isRecord(returned) && "then" in returned && isFunction(returned.then)) {
    throw failure(
      extension,
      model,
      operation,
      "returned a promise",
      new TypeError("A call's first moment runs synchronously")
    );
  }
  if (!isFunction(returned)) return undefined;
  if (call !== undefined) {
    let returnedBy = seconds.get(call);
    if (returnedBy === undefined) seconds.set(call, (returnedBy = new Map()));
    returnedBy.set(handler.handler as FirstMoment, returned as SecondMoment);
  }
  return returned as SecondMoment;
}

/** One first moment's context over the arguments it reads and patches. */
function firstContext(
  handler: ResolvedOperationHandler,
  model: string | undefined,
  operation: string,
  state: { args: Readonly<Record<string, unknown>> },
  controls: RequestControls | undefined,
  call: object | undefined
): FirstContext {
  const { extension } = handler;
  return {
    kind: model === undefined ? ("raw" as const) : ("model" as const),
    schema: schemas.get(handler.handler),
    model,
    operation,
    get args() {
      return state.args;
    },
    values:
      handler.controls === undefined
        ? NO_VALUES
        : controlsOwnedBy(controls?.admitted, handler.controls),
    set(patch: unknown) {
      if (model === undefined || !isRecord(patch))
        throw failure(
          extension,
          model,
          operation,
          "set no model call's arguments"
        );
      for (const key of Object.keys(patch))
        if (SHAPE_KEYS.has(key) || controls?.names.has(key))
          throw failure(
            extension,
            model,
            operation,
            SHAPE_KEYS.has(key)
              ? `set "${key}", which decides the result's shape`
              : `named control "${key}"`
          );
      state.args = Object.freeze({ ...state.args, ...patch });
    },
    [REGISTER]: (watching: Watching) => {
      if (call === undefined || !WATCHING.has(handler.handler)) return false;
      let byExtension = watched.get(call);
      if (byExtension === undefined)
        watched.set(call, (byExtension = new Map()));
      byExtension.set(extension, [
        ...(byExtension.get(extension) ?? []),
        watching,
      ]);
      return true;
    },
  };
}

/**
 * Every first moment of one model call, in chain order, over its arguments
 * with the controls taken out: what `chain.request.apply` runs before the
 * call is validated. The arguments each sees are those the moments before it
 * left.
 */
export function runFirstMoments(
  model: string,
  operation: Operations,
  input: Record<string, unknown> | undefined,
  handlers: readonly ResolvedOperationHandler[] | undefined,
  controls?: RequestControls,
  call?: object
): Record<string, unknown> | undefined {
  if (handlers === undefined || handlers.length === 0) return input;
  const state = { args: Object.freeze({ ...input }) };
  for (const handler of handlers)
    runFirst(
      handler,
      firstContext(handler, model, operation, state, controls, call),
      call
    );
  return state.args;
}

/**
 * The second moment of one `around` part, as a query handler: the
 * second its first returned for this call (a raw statement runs its first
 * moment here, having had none before), run around the child. Once the
 * child failed, the call fails with the child's error.
 */
function secondMoment(first: FirstMoment, extension: string) {
  return async (
    context: QueryInterceptorContext<unknown> & { readonly call?: object }
  ): Promise<unknown> => {
    const second =
      context.kind === "model"
        ? context.call && seconds.get(context.call)?.get(first)
        : runFirst(
            { extension, handler: first },
            firstContext(
              { extension, handler: first },
              undefined,
              context.operation,
              { args: context.input },
              undefined,
              undefined
            ),
            undefined
          );
    if (second === undefined) return context.proceed();
    let failed: { readonly error: unknown } | undefined;
    const settle = (promise: Promise<unknown>) =>
      promise.then(
        (value) => {
          failed = undefined;
          return value;
        },
        (error: unknown) => {
          failed = { error };
          throw error;
        }
      );
    const run = Object.defineProperties(() => settle(context.proceed()), {
      input: { get: () => context.input },
      mode: { value: context.mode },
      [AGAIN]: { value: context.again },
      [VIA]: {
        value: (driver: AnyDriver) => settle(context.proceedOn(driver)),
      },
    });
    let value: unknown;
    try {
      value = await second(run);
    } catch (error) {
      // Once the child failed, its error is the call's.
      throw failed === undefined ? error : failed.error;
    }
    if (failed !== undefined) throw failed.error;
    return value;
  };
}

/** What a `call` (moment one alone) runs: it may return nothing to come back to. */
const momentOneOnly =
  (handler: CallEntry["handler"]): FirstMoment =>
  (context) => {
    const returned = handler(context as never);
    if (isFunction(returned))
      throw new TypeError("call() returned a function: write around()");
    return returned;
  };

/** The second moments placed nearest the core (`inner`), whatever the chain's order. */
const INNER = new WeakSet<CallableFunction>();

function innerLast(lookup: OperationHandlers): OperationHandlers {
  const order = (
    list: readonly ResolvedOperationHandler[]
  ): readonly ResolvedOperationHandler[] =>
    Object.freeze([
      ...list.filter((handler) => !INNER.has(handler.handler)),
      ...list.filter((handler) => INNER.has(handler.handler)),
    ]);
  const models: Record<
    string,
    Readonly<Record<string, readonly ResolvedOperationHandler[]>>
  > = Object.create(null);
  for (const [model, operations] of Object.entries(lookup.models)) {
    const ordered: Record<string, readonly ResolvedOperationHandler[]> =
      Object.create(null);
    for (const [operation, list] of Object.entries(operations))
      ordered[operation] = order(list);
    models[model] = Object.freeze(ordered);
  }
  const global = order(lookup.global);
  return {
    global,
    models: Object.freeze(models),
    handlers: (model, operation) =>
      model === undefined
        ? global.length === 0
          ? undefined
          : global
        : (models[model]?.[operation] ??
          (global.length === 0 ? undefined : global)),
  };
}

/** The handler a part names, per model and operation of its selection. */
function contributionOf(
  selection: SelectionValue | undefined,
  handler: (...args: never[]) => unknown,
  schema: Schema,
  extension: string
): RuntimeRequestContribution {
  if (selection === undefined) return handler;
  const operations = selection.operations ?? MODEL_OPERATIONS;
  const map: Record<string, Record<string, (...args: never[]) => unknown>> = {};
  for (const model of selection.models ?? Object.keys(schema)) {
    if (!Object.hasOwn(schema, model))
      extensionError(
        `Extension "${extension}" call names unknown model "${model}".`,
        extension
      );
    const entry: Record<string, (...args: never[]) => unknown> = {};
    // `target` refused an unknown operation where it was written.
    for (const operation of operations) entry[operation] = handler;
    map[model] = entry;
  }
  return map;
}

/** Each part's first moment, made once per entry (an entry is one schema's). */
const firsts = new WeakMap<CallEntry, FirstMoment>();
/** The first moments whose part brings what tells `watch` and `settled`. */
const WATCHING = new WeakSet<CallableFunction>();

function firstOf(entry: CallEntry, schema: Schema): FirstMoment {
  let first = firsts.get(entry);
  if (first === undefined) {
    first = entry.around
      ? (context) => entry.handler(context as never)
      : momentOneOnly(entry.handler);
    firsts.set(entry, first);
    schemas.set(first, schema);
    if (entry.around || entry.on?.watch !== undefined) WATCHING.add(first);
  }
  return first;
}

/** The first moments of `call` and `around` parts, before validation. */
const firstPart: ExtensionPart = {
  join({ next, chain, definition, owner, schema }: Application) {
    const entries = definition.calls;
    if (entries === undefined) return;
    let request: OperationHandlers | undefined = chain?.request;
    for (const entry of entries)
      request = compileHandlers(
        request,
        owner,
        contributionOf(entry.on, firstOf(entry, schema), schema, owner.name),
        false
      );
    next.request = Object.freeze({ ...request!, apply: runFirstMoments });
  },
};

/** The second moments of `around` parts, around the prepared call. */
const aroundPart: ExtensionPart = {
  uses: [firstPart],
  join({ next, chain, definition, owner, schema }: Application) {
    let query: OperationHandlers | undefined = chain?.query;
    for (const entry of definition.calls ?? []) {
      if (!entry.around) continue;
      const second = secondMoment(firstOf(entry, schema), owner.name);
      if (entry.inner) INNER.add(second);
      query = compileHandlers(
        query,
        owner,
        contributionOf(entry.on, second, schema, owner.name),
        true
      );
    }
    if (query === chain?.query) return;
    // Reordered at every join: a later extension's handler lands after an
    // earlier one placed nearest the core.
    next.query = Object.freeze(innerLast(query!));
    next.hasQueryHandlers = true;
    coordinate(next, QUERIES);
  },
};

const write =
  (entry: CallEntry) =>
  (draft: DefinitionDraft): void => {
    // A copy per schema: its first moment is made against that schema.
    draft.calls = [...(draft.calls ?? []), { ...entry }];
  };

/**
 * A first moment alone: it reads, patches or refuses each call it selects,
 * before validation. On a model's calls only: a raw statement is reached by
 * `around`.
 */
export function call<T extends AnyTarget, M = never, O = never>(
  handler: (c: MomentOne<T, M, O>) => void,
  selected?: Selection<T, M, O>
): Part<T, EmptyFacts>;
export function call(
  handler: CallEntry["handler"],
  selected?: unknown
): unknown {
  if (!isFunction(handler))
    throw new TypeError("call() takes a function of the call");
  const on = selectionOf(selected);
  return builtPart(
    [
      firstPart,
      // What watches the call's writes comes with a set that names writes
      // (`target(writes)`): a call that only patches does not carry it.
      ...(on?.watch ? [on.watch] : []),
    ],
    write({ handler, on, around: false, inner: false })
  );
}

/**
 * Both moments: the first may return a second, `(run) => …`, which runs
 * around the prepared call. With `{ inner: true }` it sits nearest the core,
 * whatever the chain's order (a part that may answer for the core).
 */
export function around<T extends AnyTarget, M = never, O = never>(
  handler: AroundHandler<T, M, O>,
  selected?: Selection<T, M, O>,
  options?: { readonly inner?: true }
): Part<T, AroundFacts<M, O>>;
export function around(
  handler: CallEntry["handler"],
  selected?: unknown,
  options?: { readonly inner?: true }
): unknown {
  if (!isFunction(handler))
    throw new TypeError("around() takes a function of the call");
  return builtPart(
    [aroundPart, watchPart],
    write({
      handler,
      on: selectionOf(selected),
      around: true,
      inner: options?.inner === true,
    })
  );
}
