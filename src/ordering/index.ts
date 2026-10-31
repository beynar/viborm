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
import { type Sql, sql } from "../sql/sql";
import { AppendKey } from "./append";
import { isKey, keyBetween } from "./keys";

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
  readonly $executeRaw: (query: Sql) => PromiseLike<number>;
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
  readonly model: AnyModel;
  /** The client's dialect: respacing writes its own SQL. */
  readonly dialect: string;
}

function refuse(message: string): never {
  throw new ClientInitializationError(`ordering: ${message}`, {
    meta: { extension: NAME },
  });
}

function admit(
  schema: Schema,
  config: OrderingConfig,
  dialect = "sqlite"
): readonly Ordered[] {
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
    return Object.freeze({ name, key, within, identity, model, dialect });
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

/**
 * Respace lists in one statement: every member of each list (hidden ones
 * too: the statement reads the table, not the caller's view) gets the key
 * of its rank, `10`, `11`, … in `order` (else the list's current order), a
 * member whose key or list changed since the statement's own read keeping
 * what it was given. `lists` names the lists by their fields' values;
 * `undefined` respaces every list. Returns the rows rewritten.
 */
async function respace(
  ordered: Ordered,
  scope: Scope,
  lists: readonly Row[] | undefined,
  order: readonly Readonly<Record<string, "asc" | "desc">>[] = []
): Promise<number> {
  if (lists?.length === 0) return 0;
  const { model, key, within, identity, dialect } = ordered;
  const quote = (name: string) =>
    sql.raw(
      dialect === "mysql"
        ? `\`${name.replaceAll("`", "``")}\``
        : `"${name.replaceAll('"', '""')}"`
    );
  const column = (field: string) => {
    const scalar = model["~"].state.scalars[field]!;
    return quote(
      scalar["~"].names?.sql ?? scalar["~"].state.columnName ?? field
    );
  };
  const table = quote(model["~"].names.sql!);
  const at = (alias: string, field: string) =>
    sql`${sql.raw(alias)}.${column(field)}`;
  // A model with no list fields is one list: the whole table.
  const filter =
    lists === undefined || within.length === 0
      ? sql.empty
      : sql` WHERE ${sql.join(
          lists.map(
            (list) =>
              sql`(${sql.join(
                within.map((field) =>
                  list[field] === null
                    ? sql`${column(field)} IS NULL`
                    : sql`${column(field)} = ${list[field]}`
                ),
                " AND "
              )})`
          ),
          " OR "
        )}`;
  const terms = [
    ...order.flatMap((term) =>
      Object.entries(term).map(
        ([field, direction]) =>
          sql`${column(field)} ${sql.raw(direction === "desc" ? "DESC" : "ASC")}`
      )
    ),
    ...(order.length === 0 ? [sql`${column(key)} ASC`] : []),
    ...identity.map((field) => sql`${column(field)} ASC`),
  ];
  const partition =
    within.length === 0
      ? sql.empty
      : sql`PARTITION BY ${sql.join(within.map(column), ", ")} `;
  const ranked = sql`SELECT ${sql.join(
    [...identity, ...within, key].map(column),
    ", "
  )}, ROW_NUMBER() OVER (${partition}ORDER BY ${sql.join(terms, ", ")}) - 1 AS ${sql.raw(
    "viborm_n"
  )} FROM ${table}${filter}`;
  const n = sql.raw("s.viborm_n");
  const value =
    dialect === "postgresql"
      ? sql`length(${n}::text)::text || ${n}::text`
      : dialect === "mysql"
        ? sql`CONCAT(CHAR_LENGTH(${n}), ${n})`
        : sql`length(${n}) || ${n}`;
  // Matched by key, and only while the row still holds the key and list read.
  const match = sql.join(
    [...identity, ...within, key].map((field) =>
      within.includes(field)
        ? sql`(${at("t", field)} = ${at("s", field)} OR (${at("t", field)} IS NULL AND ${at("s", field)} IS NULL))`
        : sql`${at("t", field)} = ${at("s", field)}`
    ),
    " AND "
  );
  const statement =
    dialect === "mysql"
      ? sql`UPDATE ${table} AS t JOIN (${ranked}) AS s ON ${match} SET ${at("t", key)} = ${value}`
      : dialect === "postgresql"
        ? sql`UPDATE ${table} AS t SET ${column(key)} = ${value} FROM (${ranked}) AS s WHERE ${match}`
        : sql`UPDATE ${table} AS t SET ${column(key)} = ${value} FROM (${ranked}) AS s WHERE ${match}`;
  return Number(await scope.$executeRaw(statement));
}

function methods(ordered: Ordered) {
  const { name, key, within, identity } = ordered;
  const selection = Object.fromEntries(
    [...identity, ...within, key].map((field) => [field, true])
  );
  const sameRow = (left: Row, right: Row) =>
    identity.every((field) => same(left[field], right[field]));
  return (delegate: Delegate, scope: Scope) => {
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
      const projection = {
        ...(select === undefined ? {} : { select }),
        ...(include === undefined ? {} : { include }),
        ...(omit === undefined ? {} : { omit }),
      };
      for (let attempt = 1; ; attempt++) {
        if (attempt > MOVE_ATTEMPTS)
          throw new QueryError(
            `${name}.move: the list kept changing under concurrent writes; try again.`
          );
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
          // The anchor and the rows after (or before) it in the list's order
          // (the `order` capability): the anchor first (or last), the moved
          // row skipped where it is the neighbour.
          const rows = (await delegate.findMany!({
            ...controls,
            cursor: anchor,
            take: after === undefined ? -3 : 3,
            select: selection,
          })) as Row[];
          const found = after === undefined ? rows.at(-1) : rows[0];
          if (found === undefined) throw new NotFoundError(name, "move");
          if (sameRow(found, moved))
            invalid(name, "a row cannot be placed next to itself.");
          group = fieldsOf(within, found);
          const others = (
            after === undefined ? rows.slice(0, -1).reverse() : rows.slice(1)
          ).filter((row) => !sameRow(row, moved));
          const other = others[0];
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
            where: { AND: [group, { NOT: fieldsOf(identity, moved) }] },
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
        let next: string | undefined;
        try {
          if (
            (low === null || isKey(low)) &&
            (high === null || isKey(high)) &&
            (low === null || high === null || low < high)
          )
            next = keyBetween(low, high);
        } catch {
          // An integer past 10^9: the list is respaced below.
        }
        if (next === undefined || !isKey(next)) {
          // Tied or malformed neighbours, or a gap split too often: the
          // list is respaced, then read again.
          await respace(ordered, scope, [group]);
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
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
    }

    /** A lazy result: nothing runs until it is awaited, so an array
     * transaction refuses it before any statement is sent. */
    const lazily = <T>(run: () => Promise<T>) => {
      let started: Promise<T> | undefined;
      const result = () => (started ??= run());
      return {
        then: <A = T, B = never>(
          onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
          onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
        ) => result().then(onFulfilled, onRejected),
        catch: <B = never>(
          onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
        ) => result().catch(onRejected),
        finally: (onFinally?: (() => void) | null) =>
          result().finally(onFinally),
      };
    };

    return {
      move: (args: Readonly<Record<string, unknown>>) =>
        lazily(() => place(args)),
      rekey: (args: Readonly<Record<string, unknown>> = {}) =>
        lazily(async () => {
          const { where, orderBy, ...controls } = args;
          const order = (
            orderBy === undefined
              ? []
              : Array.isArray(orderBy)
                ? orderBy
                : [orderBy]
          ) as Readonly<Record<string, "asc" | "desc">>[];
          for (const term of order)
            for (const [field, direction] of Object.entries(term))
              if (
                !Object.hasOwn(ordered.model["~"].state.scalars, field) ||
                (direction !== "asc" && direction !== "desc")
              )
                throw new ValidationError("update", [
                  {
                    path: "orderBy",
                    message: `${name}.rekey: orderBy takes { field: "asc" | "desc" } over the model's scalar fields.`,
                  },
                ]);
          // The lists the matched rows are in, each respaced whole.
          const lists =
            where === undefined || within.length === 0
              ? where === undefined
                ? undefined
                : (await delegate.findFirst!({
                      ...controls,
                      where,
                      select: selection,
                    }))
                  ? undefined
                  : []
              : ((await delegate.findMany!({
                  ...controls,
                  where,
                  distinct: within,
                  select: Object.fromEntries(
                    within.map((field) => [field, true])
                  ),
                })) as Row[]);
          return { count: await respace(ordered, scope, lists, order) };
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
  const admitted = admit(
    client.$schema,
    config,
    (client as { $driver?: { dialect?: string } }).$driver?.dialect
  );
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
