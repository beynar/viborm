// viborm/ordering: the order of a list's members, as fractional keys.
//
// One string field per ordered model holds a key (`keys.ts`): reads are
// sorted by the list's fields then the key (the `order` capability), a row
// created without a key is appended to its list (`append.ts`, computed by the
// INSERT itself), and `move` writes one row. `rekey` respaces a list: how an
// existing table adopts the extension, and how a list whose keys have grown
// too long, or tie, is repaired (`move` does it on its own when it must).

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { DatabaseAdapter } from "../adapters/database-adapter";
import type { OperationPayload } from "../client/exports"; // public today
import type { DriverResultParser } from "../drivers/driver-instrumentation";
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
import { Queries } from "../query-engine/raptor3/shared/query";
import { EngineSchema } from "../query-engine/raptor3/shared/schema";
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
    // An integer part of 10^8 or more is refused: appends go past the last
    // key, and 9×10^8 of them stay possible after any written one.
    validate: (value: unknown) =>
      isKey(value) && value[0] !== "9"
        ? { value }
        : {
            issues: [
              {
                message:
                  "must be an ordering key (digits, viborm/ordering) with an integer part below 10^8: leave it out to append, or use move",
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
/** What respacing reads off the client's driver. */
interface Driver {
  readonly dialect: string;
  readonly adapter: DatabaseAdapter;
  readonly result?: DriverResultParser;
  readonly maxBindParametersPerStatement?: number;
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
    // A literal default is how an existing table adopts the extension (its
    // rows take it, then `rekey`); a create of the client appends instead.
    if (
      state.autoGenerate !== undefined ||
      (state.hasDefault && typeof state.default !== "string")
    )
      refuse(
        `${name}.${key} can only default to a literal string: ordering appends the key.`
      );
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
    return Object.freeze({ name, key, within, identity, model });
  });
}

// ---------------------------------------------------------------------------
// move and rekey
// ---------------------------------------------------------------------------

const PLACEMENTS = ["after", "before", "first", "last"] as const;

// Two values of one list field: a Date by its instant, else by text (a
// bigint read back as a number names the same list).
const same = (left: unknown, right: unknown) =>
  left === right ||
  (left instanceof Date && right instanceof Date
    ? left.getTime() === right.getTime()
    : left !== null &&
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

/** The engine's renderer for one client: its namespace, columns and
 * value encodings, so a respace names what a query would. */
interface Engine {
  readonly queries: Queries;
  readonly dialect: string;
  readonly binds: number | undefined;
  /** The official cache's `$invalidate`, where it is applied. */
  readonly invalidate: ((...keys: string[]) => Promise<void>) | undefined;
}

function engineOf(
  schema: Schema,
  driver: Driver,
  invalidate: Engine["invalidate"]
): () => Engine {
  let engine: Engine | undefined;
  return () =>
    (engine ??= {
      invalidate,
      queries: new Queries(
        new EngineSchema(schema),
        driver.adapter,
        driver.result
      ),
      dialect: driver.dialect,
      binds: driver.maxBindParametersPerStatement,
    });
}

/**
 * Respace lists: every member of each list (hidden ones too: the statement
 * reads the table, not the caller's view) gets the key of its rank, `10`,
 * `11`, … in `order` then the list's current order, a member whose key or
 * list changed since the statement's own read keeping what it was given.
 * `lists` names the lists by their fields' values (one statement per as
 * many lists as the driver's bound values allow); `undefined` respaces the
 * whole table, one list. Returns the rows rewritten.
 */
async function respace(
  ordered: Ordered,
  { queries: q, dialect, binds }: Engine,
  scope: Scope,
  lists: readonly Row[] | undefined,
  order: readonly Readonly<Record<string, "asc" | "desc">>[] = []
): Promise<number> {
  const { model, key, within, identity } = ordered;
  const column = (field: string, alias?: string) =>
    q.column(model, field, alias);
  // Selected once each: a list field may be part of the model's key.
  const fields = [...new Set([...identity, ...within, key])];
  const terms = [
    ...order.flatMap((term) =>
      Object.entries(term).map(
        ([field, direction]) =>
          sql`${column(field)} ${sql.raw(direction === "desc" ? "DESC" : "ASC")}`
      )
    ),
    ...[key, ...identity].map((field) => sql`${column(field)} ASC`),
  ];
  const partition =
    within.length === 0
      ? sql.empty
      : sql`PARTITION BY ${sql.join(
          within.map((field) => column(field)),
          ", "
        )} `;
  const n = sql.raw("s.viborm_n");
  const value =
    dialect === "postgresql"
      ? sql`length(${n}::text)::text || ${n}::text`
      : dialect === "mysql"
        ? sql`CONCAT(CHAR_LENGTH(${n}), ${n})`
        : sql`length(${n}) || ${n}`;
  // Matched by key, and only while the row still holds the key and list read.
  const match = sql.join(
    fields.map((field) =>
      within.includes(field)
        ? sql`(${column(field, "t")} = ${column(field, "s")} OR (${column(field, "t")} IS NULL AND ${column(field, "s")} IS NULL))`
        : sql`${column(field, "t")} = ${column(field, "s")}`
    ),
    " AND "
  );
  const statement = (filter: Sql) => {
    const ranked = sql`SELECT ${sql.join(
      fields.map((field) => column(field)),
      ", "
    )}, ROW_NUMBER() OVER (${partition}ORDER BY ${sql.join(terms, ", ")}) - 1 AS viborm_n FROM ${q.table(model)}${filter}`;
    return dialect === "mysql"
      ? sql`UPDATE ${q.table(model, "t")} JOIN (${ranked}) AS s ON ${match} SET ${column(key, "t")} = ${value}`
      : sql`UPDATE ${q.table(model, "t")} SET ${column(key)} = ${value} FROM (${ranked}) AS s WHERE ${match}`;
  };
  if (lists === undefined)
    return Number(await scope.$executeRaw(statement(sql.empty)));
  // Each list by its fields' values, bound as the engine binds them.
  const conditions = lists.map(
    (list) =>
      sql`(${sql.join(
        within.map((field) =>
          list[field] === null
            ? sql`${column(field)} IS NULL`
            : sql`${column(field)} = ${q.fieldValue(model, field, list[field])}`
        ),
        " AND "
      )})`
  );
  let count = 0;
  for (let at = 0; at < conditions.length; ) {
    const chunk: Sql[] = [];
    let bound = 0;
    for (; at < conditions.length; at++) {
      const size = conditions[at]!.values.length;
      if (chunk.length > 0 && binds !== undefined && bound + size > binds)
        break;
      chunk.push(conditions[at]!);
      bound += size;
    }
    count += Number(
      await scope.$executeRaw(statement(sql` WHERE ${sql.join(chunk, " OR ")}`))
    );
  }
  return count;
}

function methods(ordered: Ordered, engine: () => Engine) {
  const { name, key, within, identity, model } = ordered;
  const scalars = model["~"].state.scalars;
  // A nullable list field: the engine's cursor over the default order cannot
  // seek past it, so the anchor's neighbours are read within its list.
  const open = within.some((field) => scalars[field]!["~"].state.nullable);
  const keyOrder = [key, ...identity].map((field) => ({
    [field]: "asc" as const,
  }));
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
          const take = after === undefined ? -3 : 3;
          const at = open
            ? ((await delegate.findUnique!({
                ...controls,
                where: anchor,
                select: selection,
              })) as Row | null)
            : undefined;
          const rows =
            at === null
              ? []
              : ((await delegate.findMany!({
                  ...controls,
                  ...(at && { where: fieldsOf(within, at), orderBy: keyOrder }),
                  cursor: anchor,
                  take,
                  select: selection,
                })) as Row[]);
          const found = after === undefined ? rows.at(-1) : rows[0];
          if (found === undefined) throw new NotFoundError(name, "move anchor");
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
          await respace(
            ordered,
            engine(),
            scope,
            within.length === 0 ? undefined : [group]
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
          // The lists the matched rows are in, each respaced whole: named
          // through the caller's view, so a list it cannot see is never
          // rewritten. Without list fields, the table is the one list.
          const read = { ...controls, ...(where !== undefined && { where }) };
          const lists =
            within.length === 0
              ? (await delegate.findFirst!({ ...read, select: selection }))
                ? undefined
                : []
              : ((await delegate.findMany!({
                  ...read,
                  distinct: within,
                  select: Object.fromEntries(
                    within.map((field) => [field, true])
                  ),
                })) as Row[]);
          if (lists?.length === 0) return { count: 0 };
          const count = await respace(ordered, engine(), scope, lists, order);
          // A raw write: the official cache's entries of the model go.
          await engine().invalidate?.(`${name}:*`);
          return { count };
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
/** A row of model `K` of client `M`, as an `update` returns it. */
type RowOf<M, K> = ExtendedOperationResult<M, K, "update", object>;
type WithinOf<
  Config extends OrderingConfig,
  K extends keyof Config,
> = Config[K]["within"] extends readonly (infer F extends string)[] ? F : never;
/** A list, by the values of its fields. */
type ListOf<M, Config extends OrderingConfig, K extends keyof Config> = {
  readonly [F in WithinOf<Config, K>]: RowOf<M, K>[F & keyof RowOf<M, K>];
};
type None<Keys extends string> = { readonly [P in Keys]?: never };
/** Where `move` puts the row: exactly one of these. */
export type MovePlacement<
  M,
  C extends VibORMConfig,
  Config extends OrderingConfig,
  K extends keyof Config,
> =
  | ({ readonly after: Unique<C, K> } & None<
      "before" | "first" | "last" | "to"
    >)
  | ({ readonly before: Unique<C, K> } & None<
      "after" | "first" | "last" | "to"
    >)
  | ({ readonly first: true; readonly to?: ListOf<M, Config, K> } & None<
      "after" | "before" | "last"
    >)
  | ({ readonly last: true; readonly to?: ListOf<M, Config, K> } & None<
      "after" | "before" | "first"
    >)
  | ({ readonly to: ListOf<M, Config, K> } & None<
      "after" | "before" | "first" | "last"
    >);
type MoveArgs<
  M,
  C extends VibORMConfig,
  Config extends OrderingConfig,
  K extends keyof Config,
> = Projection<C, K> & {
  readonly where: Unique<C, K>;
} & MovePlacement<M, C, Config, K>;
type FindArg<C extends VibORMConfig, K, P extends string> = NonNullable<
  ModelArgs<C, K, "findMany">
>[P & keyof NonNullable<ModelArgs<C, K, "findMany">>];
type RekeyOrder<M, K> = {
  readonly [F in keyof RowOf<M, K>]?: "asc" | "desc";
};
type RekeyArgs<M, C extends VibORMConfig, K> = {
  readonly where?: FindArg<C, K, "where">;
  readonly orderBy?: RekeyOrder<M, K> | readonly RekeyOrder<M, K>[];
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
    move<A extends MoveArgs<M, C, Config, K>>(
      args: A
    ): PromiseLike<ExtendedOperationResult<M, K, "update", A>>;
    // Generic as `move` is, so a call's controls (`deleted`, …) pass along.
    rekey<A extends RekeyArgs<M, C, K>>(
      args?: A
    ): PromiseLike<{ count: number }>;
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
  // The scope a method is given has no driver and no cache: respacing
  // renders with the client's, and invalidates its cache, read here.
  const { $driver, $invalidate } = client as unknown as {
    $driver: Driver;
    $invalidate?: Engine["invalidate"];
  };
  const engine = engineOf(client.$schema, $driver, $invalidate);
  const model = Object.fromEntries(
    admit(client.$schema, config).map((ordered) => [
      ordered.name,
      methods(ordered, engine),
    ])
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
