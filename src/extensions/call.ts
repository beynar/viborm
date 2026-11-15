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
import { QueryError, VibORMError } from "@errors";
import { isFunction, isRecord } from "@validation/value-guards";
import { errorCause } from "../errors/diagnostic-safety";
import type { AdmittedArgs } from "./arguments";
import type { Application, ExtensionPart } from "./chain";
import { extensionError } from "./chain";
import type { ResolvedArgs, ResolvedOperationHandler } from "./chain-state";
import type {
  AnyTarget,
  AroundFacts,
  AroundHandler,
  EmptyFacts,
  MomentOne,
  Part,
  Selection,
} from "./contract";
import { coordinate, QUERIES } from "./coordination";
import { handlersOf, type PlacedHandler } from "./handlers";
import { MODEL_OPERATIONS, type SelectionValue, selectionOf } from "./on";
import { CALL, type CallOrigin } from "./origin";
import type { AroundRunner } from "./query";
import { SHAPE_KEYS } from "./request";
import { REGISTER, type Registering, type WatchPart } from "./watch-part";

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
  readonly values: AdmittedArgs;
  set(patch: unknown): void;
  /** A model call itself, for the words that read it (`database`, `key`). */
  readonly [CALL]: object | undefined;
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
    call: CallOrigin,
    first: FirstMoment,
    second: SecondMoment
  ) => void;
  /**
   * `around` only: what a raw statement's first moment registers `settled`
   * through, kept on the call, which the host tells of the outcome.
   */
  readonly told?: (call: CallOrigin, extension: string) => Registering;
  /** What registers `watch` and `settled`, where the part brings what tells them. */
  readonly watch?: WatchPart | undefined;
  /** `around` only: placed nearest the core. */
  readonly inner?: boolean;
}

/**
 * One first moment, as the request lookup holds it: run for one call by
 * `runFirstMoments`, it keeps the second moment its handler returned.
 */
export type FirstMoment = (
  owner: Pick<ResolvedOperationHandler, "extension" | "args">,
  model: string | undefined,
  operation: string,
  state: { args: Readonly<Record<string, unknown>> },
  call: CallOrigin,
  declared: ResolvedArgs | undefined,
  admitted: AdmittedArgs | undefined
) => void;

type SecondMoment = (run: unknown) => unknown;

const NO_VALUES: AdmittedArgs = /* @__PURE__ */ Object.freeze({});

/**
 * One part's first moment against one schema. What the handler throws
 * refuses the call (an error of viborm's own as it is, any other as the
 * cause of a `QueryError`); a promise is refused, and so is a function
 * returned by `call`; a second moment returned by `around` is kept for the
 * call.
 */
function firstOf(
  { handler, keep, told, watch }: CallSpec,
  schema: Schema
): FirstMoment {
  const first: FirstMoment = (
    { extension, args: own },
    model,
    operation,
    state,
    call,
    declared,
    admitted
  ) => {
    const refusal = (problem: string, cause?: unknown) =>
      new QueryError(
        `Extension "${extension}" first moment for ${model === undefined ? operation : `${model}.${operation}`} ${problem}.`,
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
        // An extension that declares arguments brings the chain's arguments.
        values: (own && declared?.owned(admitted, own)) ?? NO_VALUES,
        set(patch: unknown) {
          if (model === undefined || !isRecord(patch))
            throw refusal("set no model call's arguments");
          for (const key of Object.keys(patch)) {
            const shape = SHAPE_KEYS.has(key);
            if (shape || declared?.names.has(key))
              throw refusal(
                shape
                  ? `set "${key}", which decides the result's shape`
                  : `set argument "${key}"`
              );
          }
          state.args = Object.freeze({ ...state.args, ...patch });
        },
        // Only a part on a set of writes watches a model call, and a raw
        // statement never reaches such a part; an `around` hears a raw
        // statement's outcome.
        ...(model === undefined
          ? told?.(call, extension)
          : watch?.registering(call, extension)),
        [CALL]: model === undefined ? undefined : call,
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
 * the arguments taken out: what `chain.request.apply` runs before a model
 * call is validated, and before a raw statement is sent (`raw.ts`, with no
 * model and its input for arguments). The arguments each sees are those the
 * moments before it left. `call` is the one object both moments of the call
 * are handed: what links an `around` part's second moment to its first.
 */
export function runFirstMoments(
  operation: string,
  input: Readonly<Record<string, unknown>>,
  handlers: readonly ResolvedOperationHandler<FirstMoment>[],
  call: CallOrigin,
  model?: string,
  declared?: ResolvedArgs,
  admitted?: AdmittedArgs
): Record<string, unknown> {
  // An argument that is no object is validation's to refuse, as it is.
  const state = {
    args: isRecord(input) ? Object.freeze({ ...input }) : input,
  };
  for (const handler of handlers)
    handler.handler(handler, model, operation, state, call, declared, admitted);
  return state.args;
}

/** A call's `seconds`: the second moment each `around` part's first returned. */
export type Seconds = Map<FirstMoment, SecondMoment>;

/** What `around` hands its first moments: the call's second moments kept. */
function keepSecond(
  call: CallOrigin,
  first: FirstMoment,
  second: SecondMoment
): void {
  (call.seconds ??= new Map()).set(first, second);
}

/**
 * What a raw statement's first moment registers through: its `settled`
 * functions, kept on the call, which the host tells of an execute's
 * outcome. A raw statement shows no rows: a `watch` would never be told,
 * and is refused.
 */
const rawTold = (call: CallOrigin, extension: string): Registering => ({
  [REGISTER]({ settled, collect, tell }) {
    if (settled === undefined) return false;
    (call.told ??= []).push({ extension, listener: settled, collect, tell });
    return true;
  },
});

/** The second moment of one `around` part: the second its first returned for this call. */
const secondMoment =
  (first: FirstMoment): AroundRunner =>
  (prepared, run) => {
    const second = prepared.call?.seconds?.get(first);
    return second === undefined ? run() : second(run);
  };

/**
 * One part's handler, placed on the calls of its target; on every call
 * without one. A name the schema or the operations do not hold is refused:
 * the types refuse it where `target` is written, and a caller without them
 * would otherwise get a part that never runs.
 */
function placed<H extends CallableFunction>(
  { on: selection, inner }: CallSpec,
  handler: H,
  { schema, owner }: Application
): PlacedHandler<H> {
  const own = { extension: owner.name, handler, args: owner.args };
  if (selection === undefined) return { ...own, inner };
  const known = (names: readonly string[], holds: (name: string) => boolean) =>
    new Set(
      names.map((name) =>
        holds(name)
          ? name
          : extensionError(
              `Extension "${owner.name}" target names unknown model or operation "${name}".`,
              owner.name
            )
      )
    );
  return {
    ...own,
    inner,
    on: {
      models: known(selection.models ?? Object.keys(schema), (model) =>
        Object.hasOwn(schema, model)
      ),
      operations: known(
        selection.operations ?? [...MODEL_OPERATIONS],
        (operation) => MODEL_OPERATIONS.has(operation)
      ),
    },
  };
}

/** One first moment appended to the chain's, in the order the parts join. */
function appendFirst(
  application: Application,
  spec: CallSpec,
  first: FirstMoment
): void {
  const { next } = application;
  next.call = {
    ...handlersOf([
      ...(next.call?.placed ?? []),
      placed(spec, first, application),
    ]),
    apply: runFirstMoments,
  };
}

/** What `call` returns: its first moment, made against the schema it joins. */
function callPart(spec: CallSpec): ExtensionPart {
  return {
    // What watches the call's writes comes with a set that names writes
    // (`target(writes)`): a call that only patches does not carry it.
    uses: spec.watch && [spec.watch],
    join(application) {
      appendFirst(application, spec, firstOf(spec, application.schema));
    },
  };
}

/**
 * What `around` returns: its first moment, and its second around the
 * prepared call, nearest the core with `inner` (after every other part,
 * whatever the chain's order: a later extension's lands before it).
 */
function aroundPart(spec: CallSpec): ExtensionPart {
  return {
    uses: spec.watch && [spec.watch],
    join(application) {
      const { next } = application;
      const first = firstOf(spec, application.schema);
      appendFirst(application, spec, first);
      const handler = placed(spec, secondMoment(first), application);
      const list = next.around?.placed ?? [];
      next.around = handlersOf(
        handler.inner
          ? [...list, handler]
          : [
              ...list.filter((other) => !other.inner),
              handler,
              ...list.filter((other) => other.inner),
            ]
      );
      coordinate(next, QUERIES);
    },
  };
}

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
  // a `FirstContext` at runtime.
  if (!isFunction<CallSpec["handler"]>(handler))
    throw new TypeError("call() takes a function of the call");
  const on = selectionOf(selected);
  return callPart({ handler, on, watch: on?.watch });
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
  // a `FirstContext` at runtime.
  if (!isFunction<CallSpec["handler"]>(handler))
    throw new TypeError("around() takes a function of the call");
  const on = selectionOf(selected);
  return aroundPart({
    handler,
    on,
    keep: keepSecond,
    told: rawTold,
    watch: on?.watch,
    inner: options?.inner,
  });
}
