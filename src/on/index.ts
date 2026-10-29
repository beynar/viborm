// viborm/on: per-model write hooks that run after commit.
//
// The official `on` extension. Core carries it by identity (like the cache):
// a chain that holds it asks it to plan each write (`src/extensions/writes.ts`),
// and only a write a hook concerns is changed. Everything else is here, so an
// application that never imports `viborm/on` loads none of it.
//
// A write a hook concerns runs with its projection widened to whole rows: the
// engine returns them through its own `RETURNING` (or, on MySQL, its own
// capture and re-read), the hook's rows are copied out, and the caller's value
// is cut back to exactly what the call asked for. Delivery rides the write
// outcome rail: after the write committed, after the outermost commit inside
// a transaction, never after a rollback.

import type { OperationResult } from "../client/exports"; // public today
import { ClientInitializationError, QueryError } from "../errors";
import type { ResolvedExtensionChain } from "../extensions/chain";
import type { WriteOutcome } from "../extensions/query";
import {
  OFFICIAL_ON_NAME,
  registerOfficialWrites,
  type WritePlan,
} from "../extensions/writes";
import type {
  AnyModel,
  ClientSchema,
  ClientTypeState,
  ExtensionState,
  VibORMClient,
  VibORMConfig,
} from "../index";
import { writeSinks } from "../query-engine/write-sinks";

const NAME = OFFICIAL_ON_NAME;

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

/** The kind each root operation reports; `upsert` is decided by its arm. */
const KINDS: Readonly<Record<string, OnKind | "upsert">> = {
  create: "create",
  createMany: "create",
  update: "update",
  updateMany: "update",
  upsert: "upsert",
  delete: "delete",
  deleteMany: "delete",
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
  // The plan is also the definition's `query`, which identifies it: core
  // recognizes it and keeps it out of the chain's handlers.
  const writes = (
    model: AnyModel,
    operation: string,
    args: Row,
    chain: ResolvedExtensionChain,
    callArgs: Row
  ) => plan(own, report, model, operation, args, chain, callArgs);
  registerOfficialWrites(writes, { plan: writes });
  const definition = Object.freeze({ name: NAME, query: writes });
  return (base: { $schema: object; $extends(definition: object): unknown }) => {
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
    return base.$extends(definition);
  };
}

function plan(
  hooks: RuntimeHooks,
  report: (error: QueryError, event: OnEvent) => Promise<void>,
  model: AnyModel,
  operation: string,
  args: Row,
  chain: ResolvedExtensionChain,
  callArgs: Row
): WritePlan | undefined {
  const name = model["~"].names.ts!;
  const modelHooks = hooks[name];
  if (modelHooks === undefined) return undefined;
  // Core plans only writes, and every write has a kind.
  let kind = KINDS[operation]!;
  // A delete of a model `deletion` manages leaves a tombstone, an update,
  // unless the call's controls match its `removeWhen` (read when the write
  // registers): until then, either hook concerns it.
  const deletion = kind === "delete" ? chain.deletion?.[name] : undefined;
  const removeWhen = deletion?.removeWhen;
  if (deletion !== undefined && removeWhen === undefined) kind = "update";
  const either =
    kind === "upsert"
      ? (["create", "update"] as const)
      : removeWhen === undefined
        ? ([kind] as const)
        : (["delete", "update"] as const);
  if (either.every((candidate) => modelHooks[candidate] === undefined))
    return undefined;
  // The event's own copy: neither the caller nor a hook changes the other's.
  const eventArgs = detached(callArgs) as Row;
  // An upsert whose update writes nothing (a `data` stamp included) leaves a
  // found row as it was: no hook.
  const keeps =
    kind === "upsert" && Object.keys(args.update as Row).length === 0;

  const { scalars, relations } = model["~"].state;
  const isScalar = (key: string) => Object.hasOwn(scalars, key);
  const bulk = operation.endsWith("Many");
  const { select, omit, ...rest } = args as {
    select?: Row;
    omit?: Row;
  } & Row;
  // The default projection is every scalar the call may read, and every
  // computed field; a caller's relations, counts and projection keys move to
  // `include`.
  const widened: Row = { ...rest };
  if (select !== undefined) {
    const include: Row = {};
    for (const [key, value] of Object.entries(select))
      if (
        value &&
        (Object.hasOwn(relations, key) || key === "_count" || key[0] === "$")
      )
        include[key] = value;
    if (Object.keys(include).length > 0) widened.include = include;
  }
  // A bulk write returns rows only with a projection: `omit: {}` is all.
  if (bulk) widened.omit = {};
  /** Cut one row back to what the call asked for. */
  const narrow = (row: Row) => {
    for (const key of Object.keys(row))
      if ((select !== undefined && !select[key]) || omit?.[key] === true)
        delete row[key];
  };
  const returnsRows = !bulk || select !== undefined || omit !== undefined;

  let rows: Row[] | undefined;
  let created: boolean | undefined;
  let certainty: WriteOutcome["certainty"] | undefined;
  let delivered = false;
  // The cache's invalidation failure, held until the hooks have run.
  let invalidation: { readonly failure: unknown } | undefined;
  const event = (): OnEvent =>
    Object.freeze({
      model: name,
      operation: operation as OnOperation,
      args: eventArgs,
      certainty: certainty!,
    });
  const hookOf = () => {
    const hookKind =
      kind === "upsert"
        ? created
          ? "create"
          : created === undefined || keeps
            ? undefined
            : "update"
        : kind;
    const hook = hookKind && modelHooks[hookKind];
    return hook && ([hook, `${name}.${hookKind}`] as const);
  };
  /**
   * Run the hook once both are known: the rows (from the write's value) and
   * the commit (from the outcome rail). Whichever comes second runs it: the
   * rail after the value inside a transaction, before it on a direct write.
   */
  const deliver = async (): Promise<void> => {
    if (delivered || rows === undefined || certainty === undefined) return;
    delivered = true;
    const held = invalidation;
    invalidation = undefined;
    const found = hookOf();
    if (found && rows.length > 0) {
      const happened = event();
      const failure = await runHook(found[0], rows, happened, found[1]);
      if (failure) await report(failure, happened);
    }
    // The cache's own failure keeps its own boundary, as without `on`.
    if (held !== undefined) throw held.failure;
  };

  return {
    args: widened,
    take(value, settle) {
      const written = Array.isArray(value) ? value : [value];
      rows = [];
      for (const row of written) {
        const copy: Row = {};
        for (const key of Object.keys(row as Row))
          if (isScalar(key)) copy[key] = detached((row as Row)[key]);
        rows.push(copy);
      }
      const result = returnsRows ? value : { count: written.length };
      if (returnsRows) for (const row of written) narrow(row as Row);
      return settle && certainty !== undefined
        ? deliver().then(() => result)
        : result;
    },
    finish(value, then) {
      const result = then ? then(value) : value;
      return certainty === undefined ? result : deliver().then(() => result);
    },
    register(context, controls, cached) {
      if (
        removeWhen !== undefined &&
        !Object.entries(removeWhen).every(
          ([control, value]) => controls?.[control] === value
        )
      )
        kind = "update";
      if (kind === "upsert")
        writeSinks.set(context, {
          upserted: (arm) => {
            created = arm;
          },
        });
      return Object.freeze({
        extension: NAME,
        failurePolicy: "boundary-owned",
        listener: async (outcome: WriteOutcome) => {
          if (cached)
            try {
              await cached.listener(outcome);
            } catch (failure) {
              invalidation ??= { failure };
            }
          if (certainty !== "committed") certainty = outcome.certainty;
          await deliver();
        },
      });
    },
  };
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
