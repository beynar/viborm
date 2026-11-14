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
 *
 * Without a target, a part concerns every model call and every raw
 * statement; `target(...)` names model operations only, so a targeted part
 * never sees a raw statement.
 */
import type { Schema } from "@client/types";
import type { AnyDriver } from "@drivers/exports";
import { QueryError, VibORMError } from "@errors";
import { isFunction, isRecord } from "@validation/value-guards";
import { errorCause } from "../errors/diagnostic-safety";
import type { Application, ExtensionPart } from "./chain";
import type { ResolvedControls, ResolvedOperationHandler } from "./chain-state";
import type {
  AnyTarget,
  AroundFacts,
  AroundHandler,
  EmptyFacts,
  MomentOne,
  Part,
  Selection,
} from "./contract";
import type { AdmittedControls } from "./controls";
import { coordinate, QUERIES } from "./coordination";
import { extensionError } from "./definition";
import { builtPart, type DefinitionDraft } from "./extension";
import { compileHandlers, type OperationHandlers } from "./handlers";
import { MODEL_OPERATIONS, type SelectionValue, selectionOf } from "./on";
import type { QueryInterceptorContext } from "./query";
import { SHAPE_KEYS } from "./request";
import type { Registering, WatchPart } from "./watch-part";

/**
 * What a first moment is handed, beside what `contract.ts` types: where the
 * part brings what tells `watch` and `settled`, what they register through.
 */
interface FirstContext extends Partial<Registering> {
  readonly kind: "model" | "raw";
  readonly schema: Schema;
  readonly model: string | undefined;
  readonly operation: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly values: AdmittedControls;
  set(patch: unknown): void;
}

/**
 * One `call` or `around` part, as its builder wrote it. What only `around`
 * or a watching set needs is handed in by the builder that has it, so a
 * program building `call` alone carries none of it.
 */
interface CallSpec {
  readonly handler: (context: FirstContext) => unknown;
  readonly on: SelectionValue | undefined;
  /** `around` only: keeps the second moment a first returned, for the call. */
  readonly keep?: (
    call: object,
    first: FirstMoment,
    second: SecondMoment
  ) => void;
  /** What registers `watch` and `settled`, where the part brings what tells them. */
  readonly watch?: WatchPart | undefined;
  /** `around` only: placed nearest the core. */
  readonly inner?: boolean;
}

/**
 * One part as its extension is applied to one schema: what its builder
 * wrote, and its first moment, made against that schema. The two host parts
 * share that first moment: `around`'s second is found by it.
 */
export interface CallEntry extends CallSpec {
  readonly first: FirstMoment;
}

/**
 * One first moment, as the request lookup holds it: run for one call by
 * `runFirstMoments`, it keeps the second moment its handler returned.
 */
export type FirstMoment = (
  owner: Pick<ResolvedOperationHandler, "extension" | "controls">,
  model: string | undefined,
  operation: string,
  state: { args: Readonly<Record<string, unknown>> },
  call: object,
  controls: ResolvedControls | undefined,
  admitted: AdmittedControls | undefined
) => void;

/** The keys a second moment's `run` carries for `again` and `via`. */
export const AGAIN = Symbol("viborm.again");
export const VIA = Symbol("viborm.via");

type SecondMoment = (run: unknown) => unknown;

const NO_VALUES: AdmittedControls = Object.freeze({});

/**
 * One part's first moment against one schema. What the handler throws
 * refuses the call (an error of viborm's own as it is, any other as the
 * cause of a `QueryError`); a promise is refused, and so is a function
 * returned by `call`; a second moment returned by `around` is kept for the
 * call.
 */
function firstOf(
  { handler, keep, watch }: CallSpec,
  schema: Schema
): FirstMoment {
  const first: FirstMoment = (
    { extension, controls: own },
    model,
    operation,
    state,
    call,
    controls,
    admitted
  ) => {
    const refusal = (problem: string, cause?: unknown) =>
      new QueryError(
        `Extension "${extension}" request handler for ${model === undefined ? operation : `${model}.${operation}`} ${problem}.`,
        { cause: errorCause(cause), meta: { model, operation } }
      );
    let returned: unknown;
    try {
      returned = handler({
        kind: model === undefined ? "raw" : "model",
        schema,
        model,
        operation,
        get args() {
          return state.args;
        },
        // An extension that declares arguments brings the chain's controls.
        values: (own && controls?.owned(admitted, own)) ?? NO_VALUES,
        set(patch: unknown) {
          if (model === undefined || !isRecord(patch))
            throw refusal("set no model call's arguments");
          for (const key of Object.keys(patch)) {
            const shape = SHAPE_KEYS.has(key);
            if (shape || controls?.names.has(key))
              throw refusal(
                shape
                  ? `set "${key}", which decides the result's shape`
                  : `named control "${key}"`
              );
          }
          state.args = Object.freeze({ ...state.args, ...patch });
        },
        // Only a part on a set of writes has one, and a raw statement never
        // reaches such a part.
        ...watch?.registering(call, extension),
      });
    } catch (cause) {
      if (cause instanceof VibORMError) throw cause;
      throw refusal("threw", cause);
    }
    // A first moment runs synchronously.
    if (isRecord(returned) && isFunction(returned.then))
      throw refusal("returned a promise");
    if (!isFunction<SecondMoment>(returned)) return;
    if (keep === undefined)
      throw refusal("returned a function: write around()");
    keep(call, first, returned);
  };
  return first;
}

/**
 * Every first moment of one call, in chain order, over its arguments with
 * the controls taken out: what `chain.request.apply` runs before a model
 * call is validated, and before a raw statement is sent (`raw.ts`, with no
 * model and its input for arguments). The arguments each sees are those the
 * moments before it left. `call` is the one object both moments of the call
 * are handed: what links an `around` part's second moment to its first.
 */
export function runFirstMoments(
  operation: string,
  input: Readonly<Record<string, unknown>>,
  handlers: readonly ResolvedOperationHandler<FirstMoment>[],
  call: object,
  model?: string,
  controls?: ResolvedControls,
  admitted?: AdmittedControls
): Record<string, unknown> {
  const state = { args: Object.freeze({ ...input }) };
  for (const handler of handlers)
    handler.handler(handler, model, operation, state, call, controls, admitted);
  return state.args;
}

/**
 * Per call, what each `around` part's first moment returned for its second:
 * kept beside the call, never on a chain or a part (both outlive the call),
 * and gone with the call.
 */
const seconds = new WeakMap<object, Map<FirstMoment, SecondMoment>>();

/** What `around` hands its first moments: the call's second moments kept. */
function keepSecond(
  call: object,
  first: FirstMoment,
  second: SecondMoment
): void {
  let returnedBy = seconds.get(call);
  if (returnedBy === undefined) seconds.set(call, (returnedBy = new Map()));
  returnedBy.set(first, second);
}

/**
 * The second moment of one `around` part, as a query handler: the second
 * its first returned for this call, run around the child. Once the child
 * failed, the call fails with the child's error.
 */
function secondMoment(first: FirstMoment, inner: boolean) {
  const handler = async (
    context: QueryInterceptorContext<unknown>
  ): Promise<unknown> => {
    // The object both moments of the call were handed: a model call's
    // own, and for a raw statement its input, which `raw.ts` hands both.
    const call = context.kind === "model" ? context.call : context.input;
    const second = call && seconds.get(call)?.get(first);
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
  // Placed nearest the core (`inner`), whatever the chain's order: a fact
  // of the handler, read wherever a later join reorders the chain.
  return inner ? Object.assign(handler, { inner }) : handler;
}

const isInner = (handler: ResolvedOperationHandler): boolean =>
  "inner" in handler.handler && handler.handler.inner === true;

function innerLast(lookup: OperationHandlers): OperationHandlers {
  const order = (
    list: readonly ResolvedOperationHandler[]
  ): readonly ResolvedOperationHandler[] =>
    Object.freeze([
      ...list.filter((handler) => !isInner(handler)),
      ...list.filter(isInner),
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

/**
 * The handler a part names, per model and operation of its target; the
 * handler itself, for every call, without one. A name the schema or the
 * operations do not hold is refused: the types refuse it where `target` is
 * written, and a caller without them would otherwise get a part that never
 * runs.
 */
function contributionOf<H extends CallableFunction>(
  selection: SelectionValue | undefined,
  handler: H,
  schema: Schema,
  extension: string
): H | Record<string, Record<string, H>> {
  if (selection === undefined) return handler;
  const unknown = (name: string): never =>
    extensionError(
      `Extension "${extension}" target names unknown model or operation "${name}".`,
      extension
    );
  const operations = selection.operations ?? MODEL_OPERATIONS;
  const map: Record<string, Record<string, H>> = {};
  for (const model of selection.models ?? Object.keys(schema)) {
    if (!Object.hasOwn(schema, model)) unknown(model);
    const entry: Record<string, H> = {};
    for (const operation of operations)
      entry[MODEL_OPERATIONS.has(operation) ? operation : unknown(operation)] =
        handler;
    map[model] = entry;
  }
  return map;
}

/** The first moments of `call` and `around` parts, before validation. */
const firstPart: ExtensionPart = {
  join({ next, chain, definition, owner, schema }: Application) {
    const entries = definition.calls;
    if (entries === undefined) return;
    let request: OperationHandlers<FirstMoment> | undefined = chain?.request;
    for (const entry of entries)
      request = compileHandlers<FirstMoment>(
        request,
        owner,
        contributionOf(entry.on, entry.first, schema, owner.name),
        // A first moment without a target runs on raw statements too.
        true
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
      if (entry.keep === undefined) continue;
      query = compileHandlers(
        query,
        owner,
        contributionOf(
          entry.on,
          secondMoment(entry.first, entry.inner === true),
          schema,
          owner.name
        ),
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
  (spec: CallSpec) =>
  (draft: DefinitionDraft, schema: Schema): void => {
    // An entry per schema: its first moment is made against that schema.
    draft.calls = [
      ...(draft.calls ?? []),
      { ...spec, first: firstOf(spec, schema) },
    ];
  };

/**
 * A first moment alone: it reads, patches or refuses each call it selects,
 * before validation; without a target, every model call and raw statement.
 */
export function call<T extends AnyTarget, M = never, O = never>(
  handler: (c: MomentOne<T, M, O>) => void,
  selected?: Selection<T, M, O>
): Part<T, EmptyFacts>;
export function call(
  handler: (context: never) => unknown,
  selected?: unknown
): unknown {
  // Each overload types the handler against its client's context, which is
  // a \`FirstContext\` at runtime.
  if (!isFunction<CallSpec["handler"]>(handler))
    throw new TypeError("call() takes a function of the call");
  const on = selectionOf(selected);
  return builtPart(
    [
      firstPart,
      // What watches the call's writes comes with a set that names writes
      // (`target(writes)`): a call that only patches does not carry it.
      ...(on?.watch ? [on.watch] : []),
    ],
    write({ handler, on, watch: on?.watch })
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
  handler: (context: never) => unknown,
  selected?: unknown,
  options?: { readonly inner?: true }
): unknown {
  // Each overload types the handler against its client's context, which is
  // a \`FirstContext\` at runtime.
  if (!isFunction<CallSpec["handler"]>(handler))
    throw new TypeError("around() takes a function of the call");
  const on = selectionOf(selected);
  return builtPart(
    // As for `call`: what watches the writes comes with a set that names them.
    [aroundPart, ...(on?.watch ? [on.watch] : [])],
    write({
      handler,
      on,
      keep: keepSecond,
      watch: on?.watch,
      inner: options?.inner,
    })
  );
}
