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
import { QueryError } from "../errors";
import type { ResolvedExtensionChain } from "../extensions/chain";
import type { WriteOutcome } from "../extensions/query";
import { registerOfficialWrites, type WritePlan } from "../extensions/writes";
import type {
  AnyModel,
  ClientSchema,
  ClientTypeState,
  ExtensionState,
  VibORMClient,
  VibORMConfig,
} from "../index";
import { writeSinks } from "../query-engine/write-sinks";

const NAME = "viborm.on";

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
            OnRow<ClientSchema<C>[M]>,
            keyof ClientSchema<C> & string
          >;
        };
      };

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
  hooks: OnHooks<NoInfer<C>>
): string extends keyof ClientSchema<C>
  ? OnExtension
  : (
      base: ClientTypeState<C, X> & NoInfer<VibORMClient<C, X>>
    ) => VibORMClient<C, X>;
export function on(hooks: RuntimeHooks) {
  const own: RuntimeHooks = Object.freeze({ ...hooks });
  // The plan is also the definition's `query`, which identifies it: core
  // recognizes it and keeps it out of the chain's handlers.
  const writes = (
    model: AnyModel,
    operation: string,
    args: Row,
    chain: ResolvedExtensionChain
  ) => plan(own, model, operation, args, chain);
  registerOfficialWrites(writes, { plan: writes });
  const definition = Object.freeze({ name: NAME, query: writes });
  return (base: { $extends(definition: object): unknown }) =>
    base.$extends(definition);
}

function plan(
  hooks: RuntimeHooks,
  model: AnyModel,
  operation: string,
  args: Row,
  chain: ResolvedExtensionChain
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
      args,
      certainty: certainty!,
    });
  const hookOf = () => {
    const hookKind =
      kind === "upsert"
        ? created === undefined
          ? undefined
          : created
            ? "create"
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
    let failure: unknown;
    let failed = false;
    if (found && rows.length > 0)
      try {
        await runHook(found[0], rows, event(), found[1]);
      } catch (error) {
        failed = true;
        failure = error;
      }
    if (held === undefined) {
      if (failed) throw failure;
      return;
    }
    if (!failed) throw held.failure;
    throw new AggregateError(
      [held.failure, failure],
      "Cache invalidation and a write hook both failed.",
      { cause: held.failure }
    );
  };

  return {
    args: widened,
    finish(value, then) {
      const written = Array.isArray(value) ? value : [value];
      rows = [];
      for (const row of written)
        if (row !== null && typeof row === "object") {
          const copy: Row = {};
          for (const key of Object.keys(row))
            if (isScalar(key)) copy[key] = (row as Row)[key];
          rows.push(copy);
        }
      let result = then ? then(value) : value;
      if (returnsRows) {
        if (Array.isArray(result)) for (const row of result) narrow(row);
        else narrow(result as Row);
      } else result = { count: written.length };
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

const AFTER = {
  committed: "committed",
  "may-have-committed": "may have committed",
} as const;

async function runHook(
  hook: RuntimeHook,
  rows: Row[],
  event: OnEvent,
  label: string
): Promise<void> {
  try {
    await hook(Object.freeze(rows), event);
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
    throw error;
  }
}
