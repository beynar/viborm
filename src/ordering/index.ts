// viborm/ordering: the order of a list's members, as fractional keys.
//
// One string field per ordered model holds a key (`keys.ts`): reads are
// sorted by the list's fields then the key (the `order` capability), a row
// created without a key is appended to its list (`append.ts`, computed by the
// INSERT itself), and `move` writes one row. `rekey` respaces a list: how an
// existing table adopts the extension, and how a list whose keys have grown
// too long, or tie, is repaired (`move` does it on its own when it must).

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { OperationPayload } from "../client/exports"; // public today
import {
  ClientInitializationError,
  NotFoundError,
  QueryError,
} from "../errors";
import { ValidationError } from "../errors/validation";
import type { OrderTerm } from "../extensions/controls";
import type {
  ClientSchema,
  ClientTypeState,
  ExtendedOperationResult,
  ExtensionState,
  VibORMClient,
  VibORMConfig,
} from "../index";
import { getModelKeyCatalog } from "../schema/model/keys";
import { AppendKey } from "./append";
import { isKey, keyBetween, keysBetween } from "./keys";

export { isKey, keyBetween, keysBetween, MAX_KEY_LENGTH } from "./keys";

/**
 * A Standard Schema validator for a key field: `rank:
 * s.string().schema(orderingKey)` refuses, on every write that sets the
 * field (nested ones too), a value that is not an ordering key. A create
 * that leaves the field out is appended, not validated.
 */
export const orderingKey = Object.freeze({
  "~standard": Object.freeze({
    version: 1 as const,
    vendor: "viborm",
    validate: (value: unknown) =>
      isKey(value)
        ? { value }
        : {
            issues: [
              {
                message:
                  "must be an ordering key (digits, viborm/ordering): leave it out to append, or use move",
              },
            ],
          },
  }),
}) as StandardSchemaV1<string>;

/** One ordered model: its key field, and the fields that name its list. */
export interface OrderingModel {
  /** A required string field with no default: the member's key. */
  readonly key: string;
  /** Scalar fields whose values name a list; none: one list. */
  readonly within?: readonly string[];
}
export type OrderingConfig = Readonly<Record<string, OrderingModel>>;

type Schema = VibORMConfig["schema"];
type AnyModel = Schema[string];
type Names<Config extends OrderingConfig> = keyof Config & string;
type Row = Readonly<Record<string, unknown>>;
type Delegate = Readonly<
  Record<string, (args: object) => PromiseLike<unknown>>
>;
interface Scope {
  readonly $schema: Schema;
  readonly $transaction: (
    operations: readonly PromiseLike<unknown>[]
  ) => Promise<readonly unknown[]>;
  readonly [model: string]: unknown;
}

const NAME = "viborm.ordering";
/** Attempts of a move whose row another writer moved meanwhile. */
const MOVE_ATTEMPTS = 3;

/** A model's ordering facts, checked against the schema once. */
interface Ordered {
  readonly name: string;
  readonly key: string;
  readonly within: readonly string[];
  /** The row key's fields: how one row is addressed. */
  readonly identity: readonly string[];
}

function refuse(message: string): never {
  throw new ClientInitializationError(`ordering: ${message}`, {
    meta: { extension: NAME },
  });
}

function admit(schema: Schema, config: OrderingConfig): readonly Ordered[] {
  return Object.entries(config).map(([name, entry]) => {
    if (!Object.hasOwn(schema, name)) refuse(`unknown model "${name}".`);
    const model = schema[name] as AnyModel;
    const scalars = model["~"].state.scalars;
    const identity: readonly string[] | undefined =
      getModelKeyCatalog(model).rowKey?.fields;
    if (identity === undefined)
      refuse(`${name} needs a primary or unique key.`);
    const key = entry.key;
    const state = Object.hasOwn(scalars, key)
      ? scalars[key]!["~"].state
      : refuse(`${name}.${key} is not a scalar field.`);
    if (state.type !== "string" || state.array || state.nullable)
      refuse(`${name}.${key} must be a required string field.`);
    if (state.hasDefault || state.autoGenerate !== undefined)
      refuse(`${name}.${key} must have no default: ordering appends the key.`);
    if (identity.includes(key))
      refuse(`${name}.${key} cannot be part of the model's key.`);
    const within = [...(entry.within ?? [])];
    for (const field of within) {
      if (!Object.hasOwn(scalars, field))
        refuse(`${name}.within names "${field}", not a scalar field.`);
      if (scalars[field]!["~"].state.array)
        refuse(`${name}.within names "${field}", a list field.`);
    }
    if (new Set(within).size !== within.length)
      refuse(`${name}.within names a field twice.`);
    if (within.includes(key))
      refuse(`${name}.within cannot name the key field "${key}".`);
    return Object.freeze({ name, key, within, identity });
  });
}

// ---------------------------------------------------------------------------
// move and rekey
// ---------------------------------------------------------------------------

const PLACEMENTS = ["after", "before", "first", "last"] as const;

const same = (left: unknown, right: unknown) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left !== undefined &&
    right !== undefined &&
    String(left) === String(right));

const fieldsOf = (fields: readonly string[], row: Row): Row =>
  Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));

function invalid(model: string, message: string): never {
  throw new ValidationError("update", [
    { message: `${model}.move: ${message}`, path: "" },
  ]);
}

/** Respace every list `rows` hold: fresh keys, in their current order. */
async function respace(
  ordered: Ordered,
  scope: Scope,
  delegate: Delegate,
  rows: readonly Row[]
): Promise<number> {
  const lists = new Map<string, Row[]>();
  for (const row of rows) {
    const list = JSON.stringify(
      ordered.within.map((field) => String(row[field]))
    );
    const members = lists.get(list) ?? [];
    members.push(row);
    lists.set(list, members);
  }
  const updates: PromiseLike<unknown>[] = [];
  for (const members of lists.values()) {
    const keys = keysBetween(null, null, members.length);
    for (const [index, row] of members.entries())
      updates.push(
        delegate.update!({
          where: fieldsOf(ordered.identity, row),
          data: { [ordered.key]: keys[index] },
          select: Object.fromEntries(ordered.identity.map((f) => [f, true])),
        })
      );
  }
  if (updates.length > 0) await scope.$transaction(updates);
  return updates.length;
}

function methods(ordered: Ordered) {
  const { name, key, within, identity } = ordered;
  const selection = Object.fromEntries(
    [...identity, ...within, key].map((field) => [field, true])
  );
  return (delegate: Delegate, scope: Scope) => {
    /** Every member of the list `group` names, in order. */
    const members = (group: Row, controls: object) =>
      delegate.findMany!({
        ...controls,
        where: group,
        select: selection,
      }) as Promise<Row[]>;

    async function place(args: Readonly<Record<string, unknown>>) {
      const {
        where,
        after,
        before,
        first,
        last,
        to,
        select,
        include,
        omit,
        ...controls
      } = args as Record<string, unknown> & { where: Row };
      const chosen = PLACEMENTS.filter((option) => args[option] !== undefined);
      if (chosen.length > 1 || (chosen.length === 0 && to === undefined))
        invalid(name, "give exactly one of after, before, first, last, or to.");
      if (to !== undefined && (after !== undefined || before !== undefined))
        invalid(name, "to goes with first or last, not with after or before.");
      if (
        (first !== undefined && first !== true) ||
        (last !== undefined && last !== true)
      )
        invalid(name, "first and last take true.");
      if (to !== undefined) {
        const fields = Object.keys(to as Row);
        if (
          fields.length !== within.length ||
          !within.every((field) => fields.includes(field))
        )
          invalid(name, `to names the list's fields: ${within.join(", ")}.`);
      }
      const anchor = (after ?? before) as Row | undefined;
      if (
        anchor !== undefined &&
        JSON.stringify(anchor) === JSON.stringify(where)
      )
        invalid(name, "a row cannot be placed next to itself.");
      const projection = {
        ...(select === undefined ? {} : { select }),
        ...(include === undefined ? {} : { include }),
        ...(omit === undefined ? {} : { omit }),
      };
      for (let attempt = 1; ; attempt++) {
        const moved = (await delegate.findUnique!({
          ...controls,
          where,
          select: selection,
        })) as Row | null;
        if (moved === null) throw new NotFoundError(name, "move");
        let group: Row;
        let low: string | null;
        let high: string | null;
        if (anchor !== undefined) {
          // The anchor and its neighbour on the moving side, in the list's
          // order (the `order` capability), the moved row left out.
          const rows = (await delegate.findMany!({
            ...controls,
            cursor: anchor,
            take: after === undefined ? -2 : 2,
            where: { NOT: where },
            select: selection,
          })) as Row[];
          const found = rows.find((row) =>
            Object.entries(anchor).every(([field, value]) =>
              same(row[field], value)
            )
          );
          if (found === undefined) throw new NotFoundError(name, "move");
          group = fieldsOf(within, found);
          const other = rows.find((row) => row !== found);
          const neighbour =
            other !== undefined &&
            within.every((field) => same(other[field], found[field]))
              ? (other[key] as string)
              : null;
          [low, high] =
            after === undefined
              ? [neighbour, found[key] as string]
              : [found[key] as string, neighbour];
        } else {
          group = (to as Row | undefined) ?? fieldsOf(within, moved);
          const end = (await delegate.findFirst!({
            ...controls,
            where: { AND: [group, { NOT: where }] },
            ...(first === true ? {} : { take: -1 }),
            select: selection,
          })) as Row | null;
          const bound = (end?.[key] as string | undefined) ?? null;
          [low, high] = first === true ? [null, bound] : [bound, null];
        }
        const current = moved[key] as string;
        const stays = within.every((field) => same(moved[field], group[field]));
        if (
          stays &&
          (low === null || low < current) &&
          (high === null || current < high)
        )
          return delegate.findUnique!({ ...controls, where, ...projection });
        if (
          (low !== null && !isKey(low)) ||
          (high !== null && !isKey(high)) ||
          (low !== null && high !== null && !(low < high))
        ) {
          // Tied or malformed neighbours: the list is respaced, then read again.
          await respace(
            ordered,
            scope,
            delegate,
            await members(group, controls)
          );
          continue;
        }
        const next = keyBetween(low, high);
        if (!isKey(next)) {
          // The gap has been split too often: its list is respaced.
          await respace(
            ordered,
            scope,
            delegate,
            await members(group, controls)
          );
          continue;
        }
        try {
          return await delegate.update!({
            ...controls,
            // Guarded on the row as read: a row another writer moved since
            // is read again.
            where: { ...where, [key]: current, ...fieldsOf(within, moved) },
            data: { [key]: next, ...(stays ? {} : group) },
            ...projection,
          });
        } catch (error) {
          if (!(error instanceof NotFoundError) || attempt >= MOVE_ATTEMPTS)
            throw error instanceof NotFoundError
              ? new QueryError(
                  `${name}.move: the row kept moving under concurrent writes; try again.`
                )
              : error;
        }
      }
    }

    /** A lazy result: nothing runs until it is awaited, so an array
     * transaction refuses it before any statement is sent. */
    const lazily = <T>(run: () => Promise<T>): PromiseLike<T> => {
      let started: Promise<T> | undefined;
      return {
        then: (onFulfilled, onRejected) =>
          (started ??= run()).then(onFulfilled, onRejected),
      };
    };

    return {
      move: (args: Readonly<Record<string, unknown>>) =>
        lazily(() => place(args)),
      rekey: (args: Readonly<Record<string, unknown>> = {}) =>
        lazily(async () => {
          const { where, orderBy, ...controls } = args;
          const rows = (await delegate.findMany!({
            ...controls,
            ...(where === undefined ? {} : { where }),
            ...(orderBy === undefined
              ? {}
              : {
                  orderBy: [
                    ...within.map((field) => ({ [field]: "asc" })),
                    ...(Array.isArray(orderBy) ? orderBy : [orderBy]),
                  ],
                }),
            select: selection,
          })) as Row[];
          return { count: await respace(ordered, scope, delegate, rows) };
        }),
    };
  };
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

type ModelArgs<
  C extends VibORMConfig,
  K,
  O extends "update" | "findMany",
> = OperationPayload<O, ClientSchema<C>[K & keyof ClientSchema<C>]>;
type Unique<C extends VibORMConfig, K> = ModelArgs<C, K, "update">["where"];
type Projection<C extends VibORMConfig, K> = Omit<
  ModelArgs<C, K, "update">,
  "where" | "data"
>;
/** Where `move` puts the row: exactly one of these. */
export type MovePlacement<C extends VibORMConfig, K> =
  | { readonly after: Unique<C, K> }
  | { readonly before: Unique<C, K> }
  | { readonly first: true; readonly to?: Readonly<Record<string, unknown>> }
  | { readonly last: true; readonly to?: Readonly<Record<string, unknown>> }
  | { readonly to: Readonly<Record<string, unknown>> };
type MoveArgs<C extends VibORMConfig, K> = Projection<C, K> & {
  readonly where: Unique<C, K>;
} & MovePlacement<C, K>;
type FindArg<C extends VibORMConfig, K, P extends string> = NonNullable<
  ModelArgs<C, K, "findMany">
>[P & keyof NonNullable<ModelArgs<C, K, "findMany">>];
type RekeyArgs<C extends VibORMConfig, K> = {
  readonly where?: FindArg<C, K, "where">;
  readonly orderBy?: FindArg<C, K, "orderBy">;
};

type OrderingModels<
  M,
  C extends VibORMConfig,
  Config extends OrderingConfig,
> = {
  readonly [K in Names<Config>]: (
    delegate: never,
    scope: never
  ) => {
    move<A extends MoveArgs<C, K>>(
      args: A
    ): PromiseLike<ExtendedOperationResult<M, K, "update", A>>;
    rekey(args?: RekeyArgs<C, K>): PromiseLike<{ count: number }>;
  };
};

type Governed<Config extends OrderingConfig> = VibORMConfig & {
  readonly schema: Record<Names<Config>, AnyModel>;
};

// Step A: the default order and the appended key, before every
// result-consuming step.
function keysStep<
  Config extends OrderingConfig,
  C extends Governed<Config>,
  X extends ExtensionState,
>(config: Config, base: VibORMClient<C, X>) {
  const admitted = admit(base.$schema, config);
  return base.$extends({
    name: NAME,
    order: {
      models: Object.fromEntries(
        admitted.map(({ name, key, within }) => [
          name,
          [...within, key].map((field) => ({ [field]: "asc" as const })),
        ])
      ) as unknown as {
        readonly [K in Names<Config> & keyof C["schema"]]: readonly OrderTerm[];
      },
    },
    data: {
      models: Object.fromEntries(
        admitted.map(({ name, key, within }) => [
          name,
          { create: { [key]: new AppendKey(within) as unknown as string } },
        ])
      ) as {
        readonly [K in Names<Config> & keyof C["schema"]]: {
          readonly create: Record<Config[K]["key"], string>;
        };
      },
    },
  });
}

// Step B: move and rekey, typed against the client that carries step A.
function methodsStep<
  Config extends OrderingConfig,
  C extends Governed<Config>,
  X extends ExtensionState,
>(config: Config, client: VibORMClient<C, X>) {
  const admitted = admit(client.$schema, config);
  const model = Object.fromEntries(
    admitted.map((ordered) => [ordered.name, methods(ordered)])
  ) as unknown as OrderingModels<VibORMClient<C, X>, C, Config>;
  return client.$extends({ name: `${NAME}.methods`, model });
}

type Receiver<Config extends OrderingConfig> = ClientTypeState<
  VibORMConfig,
  ExtensionState
> & {
  readonly $schema: Record<Names<Config>, AnyModel>;
  readonly $extends: (...args: never[]) => unknown;
};
type Keyed<Config extends OrderingConfig, Base> = Base extends ClientTypeState<
  infer C extends Governed<Config>,
  infer X extends ExtensionState
>
  ? Base extends VibORMClient<C, X>
    ? ReturnType<typeof keysStep<Config, C, X>>
    : never
  : never;
type Movable<
  Config extends OrderingConfig,
  Base,
> = Base extends ClientTypeState<
  infer C extends Governed<Config>,
  infer X extends ExtensionState
>
  ? Base extends VibORMClient<C, X>
    ? ReturnType<typeof methodsStep<Config, C, X>>
    : never
  : never;
type OrderingExtension<Config extends OrderingConfig> = {
  <Base extends Receiver<Config>>(
    base: Base
  ): NoInfer<Movable<Config, Keyed<Config, Base>>>;
  readonly keys: <Base extends Receiver<Config>>(
    base: Base
  ) => Keyed<Config, Base>;
  readonly methods: <Base extends Receiver<Config>>(
    client: Base
  ) => Movable<Config, Base>;
};

/**
 * Order the members of lists: `client.$extends(ordering({ card: { key:
 * "rank", within: ["columnId"] } }))`. The entry is both steps; `keys` (the
 * default order and appended keys) and `methods` (`move`, `rekey`) apply
 * alone around another entry's steps, every `keys`-like step first.
 */
export function ordering<const Config extends OrderingConfig>(
  config: Config
): OrderingExtension<Config> {
  function keys<Base extends Receiver<Config>>(base: Base): Keyed<Config, Base>;
  function keys<C extends Governed<Config>, X extends ExtensionState>(
    base: VibORMClient<C, X>
  ) {
    return keysStep(config, base);
  }
  function methodsOf<Base extends Receiver<Config>>(
    client: Base
  ): Movable<Config, Base>;
  function methodsOf<C extends Governed<Config>, X extends ExtensionState>(
    client: VibORMClient<C, X>
  ) {
    return methodsStep(config, client);
  }
  function extend<Base extends Receiver<Config>>(
    base: Base
  ): NoInfer<Movable<Config, Keyed<Config, Base>>>;
  function extend<C extends Governed<Config>, X extends ExtensionState>(
    base: VibORMClient<C, X>
  ) {
    return methodsStep(config, keysStep(config, base));
  }
  return Object.assign(extend, { keys, methods: methodsOf });
}
