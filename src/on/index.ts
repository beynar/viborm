// viborm/on: per-model write hooks that run after commit.
//
// An extension like any other, written with the public words: a `call` on
// every write watches the rows it writes (`watch`) and runs the hooks once
// the write is durable (`settled`): after the write committed, after the
// outermost commit inside a transaction, never after a rollback. It watches
// only a write a hook concerns; of that write it keeps its own copy of the
// rows the engine shows it (the call's own and those its nested writes
// reach).

import type { OperationResult } from "../client/exports"; // public today
// The classes and the words are imported where viborm defines them.
import { ClientInitializationError, QueryError } from "../errors";
import { call } from "../extensions/call";
import { watch } from "../extensions/call-words";
import { extension } from "../extensions/extension";
import { target, writes } from "../extensions/on";
import { settled } from "../extensions/settled";
// Types only from the root: a value imported from it would make this entry
// reach every module the root reaches, and the build would put them all in
// the chunk this entry shares with the root.
import type {
  AnyModel,
  AnyRelation,
  AnyTarget,
  ClientSchema,
  EmptyFacts,
  Extension,
  Model,
  VibORMConfig,
  WriteKind,
  WriteOutcome,
} from "../index";

const NAME = "viborm.on";
/**
 * How many declarations were made: each is an extension of its own name, so
 * two `on()` that hook the same kinds of the same models live on one client.
 */
let declared = 0;

/** What a hook is named after: what happened to the rows it receives. */
export type OnKind = "create" | "update" | "delete";

/**
 * A row as a hook receives it: every scalar field a plain `findMany` returns
 * from the schema alone. `defaultOmit()` does not hide a field from a hook,
 * and the fields `fields(...)` computes are not attached.
 */
export type OnRow<M extends AnyModel> =
  M extends Model<infer State>
    ? 0 extends 1 & State
      ? // Declared apart from any client, a hook's model is unknown: its rows
        // are plain records.
        Record<string, unknown>
      : OperationResult<"findMany", M, Record<never, never>>[number]
    : never;

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
export type OnHooks<C extends VibORMConfig = VibORMConfig> = {
  readonly [M in keyof ClientSchema<C> & string]?: string extends M
    ? { readonly [K in OnKind]?: OnHook }
    : {
        readonly [K in OnKind]?: OnHook<
          HookRow<OnRow<ClientSchema<C>[M]>, GatedFields<C, M>>,
          keyof ClientSchema<C> & string
        >;
      };
};

/**
 * The fields a rule's `gate` hides on a model (`read.fields`): the client omits
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
export function on<T extends AnyTarget>(
  hooks: OnHooks<NoInfer<T["config"]>>,
  options?: OnOptions<keyof ClientSchema<NoInfer<T["config"]>> & string>
): Extension<T, EmptyFacts>;
export function on(hooks: RuntimeHooks, options?: OnOptions): unknown {
  const own: RuntimeHooks = Object.freeze({ ...hooks });
  const onError = options?.onError;
  if (onError !== undefined && typeof onError !== "function")
    refuse("onError must be a function");
  // Refused when made, never after a write commits: a hook name or a hook
  // that is no function would otherwise run nothing.
  for (const [model, modelHooks] of Object.entries(own))
    for (const [kind, hook] of Object.entries(modelHooks ?? {}))
      if (
        !HOOK_KINDS.has(kind) ||
        (hook !== undefined && typeof hook !== "function")
      )
        refuse(`${model}.${kind} must be a create, update or delete function`);
  const hooked = Object.keys(own);
  /** Per model, the models a nested write from it can write. */
  const reached: Reached = new WeakMap();
  declared += 1;
  return extension(
    declared === 1 ? NAME : `${NAME}.${declared}`,
    // The hooked models are checked against the schema where the extension
    // is applied: an unknown one is refused there.
    ...(hooked.length === 0
      ? []
      : [call(() => undefined, target(hooked, "create"))]),
    call((c) => {
      // target(writes) selects model calls only: each names its model.
      const model = c.model!;
      const { operation, schema } = c;
      const mine = own[model] ?? {};
      // The call's own rows, where a hook wants what its verb may do to them;
      // and the rows its nested writes reach, where its payload names a
      // relation. Any other write is not watched.
      if (
        !(
          KINDS[operation]!.some((kind) => mine[kind] !== undefined) ||
          (writesRelation(c.args, schema[model]!["~"].state.relations) &&
            [...reachable(schema[model]!, reached)].some(
              (other) => own[other] !== undefined
            ))
        )
      )
        return;
      // The event's own copy: neither the caller nor a hook changes the other's.
      const args = detached(c.args) as Row;
      /** The rows the call wrote, per model and kind, the call's own first. */
      const written: {
        model: string;
        kind: WriteKind;
        rows: Row[];
        nested: boolean;
      }[] = [];
      watch(c, {
        wants: (name, kind) => own[name]?.[kind] !== undefined,
        rows(name, kind, rows, nested) {
          const group =
            (nested &&
              written.find(
                (each) =>
                  each.nested && each.model === name && each.kind === kind
              )) ||
            written[written.push({ model: name, kind, rows: [], nested }) - 1]!;
          for (const row of rows) group.rows.push(detached(row) as Row);
        },
      });
      // Told once: a call's registration hears the one outcome it reached.
      settled(c, async ({ certainty }) => {
        const event: OnEvent = Object.freeze({
          model,
          operation: operation as OnOperation,
          args,
          certainty,
        });
        for (const { model: name, kind, rows } of written)
          try {
            await own[name]![kind]!(Object.freeze(rows), event);
          } catch (thrown) {
            // Reported, never a failure of the write itself.
            const error = failure(thrown, event, `${name}.${kind}`);
            try {
              if (onError) await onError(error, event);
              else console.error(error);
            } catch (reporting) {
              console.error(error, reporting);
            }
          }
      });
    }, target(writes))
  );
}

/** Does a write's payload name a relation of its model: a nested write? */
function writesRelation(args: Row, relations: object): boolean {
  // `flat` reads a list of rows as its rows.
  return [args.data, args.create, args.update]
    .flat()
    .some(
      (row) =>
        row !== null &&
        typeof row === "object" &&
        Object.keys(row).some((key) => Object.hasOwn(relations, key))
    );
}

/** What `reachable` found, kept by each `on()` for its own calls. */
type Reached = WeakMap<AnyModel, ReadonlySet<string>>;

/**
 * The models a nested write from `model` can write, itself included: every
 * model its relations reach, transitively, every variant of a polymorphic
 * one, and a declared junction. A payload that names a relation concerns no
 * hook unless one of them has one.
 */
function reachable(model: AnyModel, reached: Reached): ReadonlySet<string> {
  const known = reached.get(model);
  if (known !== undefined) return known;
  // A set's walk visits what is added to it while it is walked.
  const seen = new Set<AnyModel>([model]);
  for (const next of seen)
    for (const relation of Object.values(
      next["~"].state.relations
    ) as AnyRelation[]) {
      const internal = relation["~"];
      const { target, junction } = internal.state;
      for (const variant of target.kind === "variants"
        ? Object.keys(target.entries)
        : [undefined])
        seen.add(internal.settleTarget(variant) as AnyModel);
      if (junction?.model)
        seen.add(internal.settleJunctionModel!() as AnyModel);
    }
  const names = new Set([...seen].map((each) => each["~"].names.ts!));
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

/** A hook's failure, as the error reported for it. */
function failure(thrown: unknown, event: OnEvent, label: string): QueryError {
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
