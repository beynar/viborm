// viborm/on: per-model write hooks that run after commit.
//
// An extension like any other: it declares `written`, the point where a
// definition is told the rows a write call wrote, and nothing of it is known
// to core. It watches only a write a hook concerns; of that write it keeps
// its own copy of the rows the engine shows it (the call's own and those its
// nested writes reach), and runs the hooks once the write is durable: after
// the write committed, after the outermost commit inside a transaction, never
// after a rollback.

import type { OperationResult } from "../client/exports"; // public today
// The classes are imported where viborm defines them, so the built entry
// shares the root's chunk.
import { ClientInitializationError, QueryError } from "../errors";
import { defineHooks } from "../extensions/define";
import type {
  AnyModel,
  AnyRelation,
  ClientSchema,
  ClientTypeState,
  ExtensionState,
  VibORMClient,
  VibORMConfig,
  WriteKind,
  WriteOutcome,
  WrittenCall,
  WrittenWatch,
} from "../index";

const NAME = "viborm.on";
/** How many declarations were made: each is an extension of its own name. */
let declared = 0;

/** What a hook is named after: what happened to the rows it receives. */
export type OnKind = "create" | "update" | "delete";

/**
 * A row as a hook receives it: every scalar field a plain `findMany` returns
 * from the schema alone. `defaultOmit()` does not hide a field from a hook,
 * and computed `result` fields are not attached.
 */
export type OnRow<M extends AnyModel> = OperationResult<
  "findMany",
  M,
  Record<never, never>
>[number];

/** The write whose rows a hook receives. */
export interface OnEvent<Model extends string = string> {
  /** The model the call named: for a nested write, the root call's model. */
  readonly model: Model;
  /** The operation the call ran: `upsert` for either arm of an upsert. */
  readonly operation: OnOperation;
  /** The call's arguments, after request transforms and default omit. */
  readonly args: Readonly<Record<string, unknown>>;
  /**
   * `"committed"`, or `"may-have-committed"` when the provider could not
   * confirm the commit (the write may still be durable).
   */
  readonly certainty: WriteOutcome["certainty"];
}

export type OnOperation =
  | "create"
  | "createMany"
  | "update"
  | "updateMany"
  | "upsert"
  | "delete"
  | "deleteMany";

/**
 * One hook: VibORM awaits what it returns before the write's promise (or,
 * inside a transaction, the transaction's) resolves. Return nothing and hand
 * the work to `ctx.waitUntil()` to not wait for it.
 */
export type OnHook<
  Row = Record<string, unknown>,
  Model extends string = string,
> = (rows: readonly Row[], event: OnEvent<Model>) => unknown;

/**
 * Per model, a hook per kind. Bound to a client's config, the model names,
 * hook names and rows are its schema's; unbound (declared apart from any
 * client), any model name and plain records.
 */
export type OnHooks<C extends VibORMConfig = VibORMConfig> =
  string extends keyof ClientSchema<C>
    ? {
        readonly [model: string]:
          | { readonly [K in OnKind]?: OnHook }
          | undefined;
      }
    : {
        readonly [M in keyof ClientSchema<C>]?: {
          readonly [K in OnKind]?: OnHook<
            HookRow<OnRow<ClientSchema<C>[M]>, GatedFields<C, M>>,
            keyof ClientSchema<C> & string
          >;
        };
      };

/**
 * The fields a `rows` extension's `reads` gates on a model: the client omits
 * them as `boolean` (a `defaultOmit()` field is `true`), and a row carries one
 * only where the call may read it.
 */
type GatedFields<C, M> = C extends { readonly omit: infer Omit }
  ? M extends keyof Omit
    ? {
        [K in keyof Omit[M]]: boolean extends Omit[M][K] ? K : never;
      }[keyof Omit[M]]
    : never
  : never;

/** A model's row with its read-gated fields optional. */
type HookRow<Row, Gated> = [Gated] extends [never]
  ? Row
  : { [K in keyof Row as K extends Gated ? never : K]: Row[K] } & {
      [K in keyof Row as K extends Gated ? K : never]?: Row[K];
    };

/**
 * Where a failing hook is reported. A hook never fails its write: the write
 * committed, so its promise resolves, and the hook's failure comes here as a
 * `QueryError` (`meta.method: "on"`, `meta.commitCertainty`, `cause` the
 * hook's own error). Without `onError`, it goes to `console.error`.
 */
export interface OnOptions<Model extends string = string> {
  readonly onError?: (error: QueryError, event: OnEvent<Model>) => unknown;
}

/** An unbound declaration: applies to any client, which it returns. */
export type OnExtension = <
  Base extends { $extends(...args: never[]): unknown },
>(
  base: Base
) => Base;

type RuntimeHook = (rows: readonly Row[], event: OnEvent) => unknown;
type RuntimeHooks = Readonly<
  Record<string, Readonly<Partial<Record<OnKind, RuntimeHook>>> | undefined>
>;
type Row = Record<string, unknown>;

const HOOK_KINDS: ReadonlySet<string> = new Set(["create", "update", "delete"]);

/** What each operation may do to the call's own rows: a delete of a model that keeps its rows updates them. */
const KINDS: Readonly<Record<string, readonly OnKind[]>> = {
  create: ["create"],
  createMany: ["create"],
  update: ["update"],
  updateMany: ["update"],
  upsert: ["create", "update"],
  delete: ["delete", "update"],
  deleteMany: ["delete", "update"],
};

/**
 * Hooks per model and kind, run after a write commits:
 *
 * ```ts
 * const db = client.$extends(on({
 *   user: { update: (rows, { certainty }) => sync(rows) },
 * }));
 * ```
 *
 * Applied inside `$extends(...)`, the receiving client's schema types the
 * model names, the kinds and each hook's rows.
 */
export function on<
  C extends VibORMConfig = VibORMConfig,
  X extends ExtensionState = ExtensionState,
>(
  hooks: OnHooks<NoInfer<C>>,
  options?: OnOptions<keyof ClientSchema<NoInfer<C>> & string>
): string extends keyof ClientSchema<C>
  ? OnExtension
  : (
      base: ClientTypeState<C, X> & NoInfer<VibORMClient<C, X>>
    ) => VibORMClient<C, X>;
export function on(hooks: RuntimeHooks, options?: OnOptions) {
  const own: RuntimeHooks = Object.freeze({ ...hooks });
  const onError = options?.onError;
  if (onError !== undefined && typeof onError !== "function")
    refuse("onError must be a function");
  /** A failing hook's report: never a failure of the write itself. */
  const report = async (error: QueryError, event: OnEvent) => {
    try {
      if (onError) await onError(error, event);
      else console.error(error);
    } catch (thrown) {
      console.error(error, thrown);
    }
  };
  declared += 1;
  const name = declared === 1 ? NAME : `${NAME}.${declared}`;
  return (base: {
    $schema: Record<string, AnyModel>;
    $extends(definition: object): unknown;
  }) => {
    // Refused when applied, never after a write commits: an unknown model or
    // hook name, or a hook that is no function, would otherwise run nothing.
    for (const [model, modelHooks] of Object.entries(own)) {
      if (!Object.hasOwn(base.$schema, model))
        refuse(`names unknown model "${model}"`);
      for (const [kind, hook] of Object.entries(modelHooks ?? {}))
        if (
          !HOOK_KINDS.has(kind) ||
          (hook !== undefined && typeof hook !== "function")
        )
          refuse(
            `${model}.${kind} must be a create, update or delete function`
          );
    }
    return base.$extends(
      defineHooks({
        name,
        written: (call: WrittenCall) =>
          watch(own, report, base.$schema[call.model]!, call),
      })
    );
  };
}

/** What watches one write a hook concerns; nothing for any other write. */
function watch(
  hooks: RuntimeHooks,
  report: (error: QueryError, event: OnEvent) => Promise<void>,
  model: AnyModel,
  call: WrittenCall
): WrittenWatch | undefined {
  const mine = hooks[call.model] ?? {};
  // The call's own rows, where a hook wants what its verb may do to them;
  // and the rows its nested writes reach, where its payload names a relation.
  if (
    !(
      KINDS[call.operation]!.some((kind) => mine[kind] !== undefined) ||
      (writesRelation(call.args, model["~"].state.relations) &&
        [...reachable(model)].some((other) => hooks[other] !== undefined))
    )
  )
    return undefined;
  // The event's own copy: neither the caller nor a hook changes the other's.
  const args = detached(call.args) as Row;
  /** The rows the call wrote, per model and kind, the call's own first. */
  const written: {
    model: string;
    kind: WriteKind;
    rows: Row[];
    nested: boolean;
  }[] = [];
  let certainty: WriteOutcome["certainty"] | undefined;
  let delivered = false;
  return {
    wants: (name, kind) => hooks[name]?.[kind] !== undefined,
    rows(name, kind, rows, nested) {
      const group =
        (nested &&
          written.find(
            (each) => each.nested && each.model === name && each.kind === kind
          )) ||
        written[written.push({ model: name, kind, rows: [], nested }) - 1]!;
      for (const row of rows) group.rows.push(detached(row) as Row);
    },
    async settled(outcome) {
      if (certainty !== "committed") certainty = outcome.certainty;
      if (delivered) return;
      delivered = true;
      const event: OnEvent = Object.freeze({
        model: call.model,
        operation: call.operation as OnOperation,
        args,
        certainty,
      });
      for (const { model: name, kind, rows } of written) {
        const failure = await runHook(
          hooks[name]![kind]!,
          rows,
          event,
          `${name}.${kind}`
        );
        if (failure) await report(failure, event);
      }
    },
  };
}

/** Does a write's payload name a relation of its model: a nested write? */
function writesRelation(args: Row, relations: object): boolean {
  for (const payload of [args.data, args.create, args.update])
    for (const row of Array.isArray(payload) ? payload : [payload])
      if (
        row !== null &&
        typeof row === "object" &&
        Object.keys(row).some((key) => Object.hasOwn(relations, key))
      )
        return true;
  return false;
}

const reached = new WeakMap<AnyModel, ReadonlySet<string>>();

/**
 * The models a nested write from `model` can write, itself included: every
 * model its relations reach, transitively, every variant of a polymorphic
 * one, and a declared junction. A payload that names a relation concerns no
 * hook unless one of them has one.
 */
function reachable(model: AnyModel): ReadonlySet<string> {
  const known = reached.get(model);
  if (known !== undefined) return known;
  const names = new Set<string>();
  const seen = new Set<AnyModel>([model]);
  const pending = [model];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    names.add(next["~"].names.ts!);
    for (const relation of Object.values(
      next["~"].state.relations
    ) as AnyRelation[]) {
      const internal = relation["~"];
      const { target } = internal.state;
      const variants =
        target.kind === "variants" ? Object.keys(target.entries) : [undefined];
      const found = variants.map(
        (variant) => internal.settleTarget(variant) as AnyModel
      );
      if (internal.state.junction?.model)
        found.push(internal.settleJunctionModel!() as AnyModel);
      for (const other of found) {
        if (seen.has(other)) continue;
        seen.add(other);
        pending.push(other);
      }
    }
  }
  reached.set(model, names);
  return names;
}

/**
 * A copy of a value a hook could change under the caller (or the caller
 * under a hook): dates, lists, JSON objects and bytes. A class instance (a
 * `Decimal`) is immutable and shared.
 */
function detached(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(detached);
  if (value instanceof Uint8Array) return value.slice();
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const copy: Row = {};
  for (const key of Object.keys(value))
    copy[key] = detached((value as Row)[key]);
  return copy;
}

function refuse(problem: string): never {
  throw new ClientInitializationError(`Extension "${NAME}" ${problem}.`, {
    meta: { extension: NAME },
  });
}

const AFTER = {
  committed: "committed",
  "may-have-committed": "may have committed",
} as const;

/** Run one hook; its failure, if any, as the error reported for it. */
async function runHook(
  hook: RuntimeHook,
  rows: Row[],
  event: OnEvent,
  label: string
): Promise<QueryError | undefined> {
  try {
    await hook(Object.freeze(rows), event);
    return undefined;
  } catch (thrown) {
    const cause = thrown instanceof Error ? thrown : new Error(String(thrown));
    const error = new QueryError(
      `Extension "${NAME}" hook ${label} failed after the write ${AFTER[event.certainty]}; the write is not undone.`,
      {
        cause,
        meta: {
          method: "on",
          model: event.model,
          operation: event.operation,
          commitCertainty: event.certainty,
        },
      }
    );
    // The hook is the application's own code: its error is handed back as
    // it threw it (serialized diagnostics keep the redacted copy).
    Object.defineProperty(error, "cause", {
      value: cause,
      configurable: true,
      writable: true,
    });
    return error;
  }
}
