// viborm/ordering: the order of a list's members, as fractional keys.
//
// One string field per ordered model holds a key (`keys.ts`): reads are
// sorted by the list's fields then the key (the `order` capability), a row
// created without a key is appended to its list (`append.ts`, computed by the
// INSERT itself), and `move` writes one row. `rekey` respaces a list: how an
// existing table adopts the extension, and how a list whose keys have grown
// too long, or tie, is repaired (`move` does it on its own when it must).

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  NoExtraOperationKeys,
  OperationPayload,
  OperationResult,
} from "../client/exports";
import type { SqlDialect } from "../drivers/types";
import {
  ClientInitializationError,
  NotFoundError,
  QueryError,
} from "../errors";
import { ValidationError } from "../errors/validation";
import { defineExtension } from "../extensions/define";
import type {
  ClientSchema,
  ClientTypeState,
  DelegateOperationArgs,
  DelegateOperationResult,
  ExtendedClient,
  ExtensionState,
  ModelSql,
  VibORMClient,
  VibORMConfig,
} from "../index";
import { computed, joined, stored } from "../index";
import { getRowKey } from "../schema/model/keys";
import { type Sql, sql } from "../sql/sql";
import { appendKey } from "./append";
import { between, jitter, spellings } from "./between";
import { isKeyFormat, keyBetween } from "./keys";
import { placed } from "./placed";

export { isKey, isKeyFormat, keyBetween, MAX_KEY_LENGTH } from "./keys";

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
      isKeyFormat(value) && value[0] !== "9"
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
  /** A required string field: the member's key. A literal default only
   * serves rows written without the extension. */
  readonly key: string;
  /** Scalar fields whose values name a list; none: one list. */
  readonly within?: readonly string[];
}
export type OrderingConfig = Readonly<Record<string, OrderingModel>>;

type Schema = VibORMConfig["schema"];
type AnyModel = Schema[string];
type Names<Config extends OrderingConfig> = keyof Config & string;
type Row = Readonly<Record<string, unknown>>;
/** One term of a model's default order, as the `order` capability takes it. */
type OrderTerm = { readonly [field: string]: "asc" | "desc" };
type Delegate = Readonly<
  Record<string, (args: object) => PromiseLike<unknown>>
>;
/** What respacing reads off the client's driver. */
interface Driver {
  readonly dialect: string;
  readonly maxBindParametersPerStatement?: number;
}

const NAME = "viborm.ordering";
/** Passes of a move's read-and-write path, respacing between them. */
const MOVE_ATTEMPTS = 3;
/** A move the one-statement path did not write. */
const MISSED = Symbol("missed");

/** A model's ordering facts, checked against the schema once. */
/** A plain object: what `data` is, as an update's data. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

interface Ordered {
  readonly name: string;
  readonly key: string;
  readonly within: readonly string[];
  /** The row key's fields: how one row is addressed. */
  readonly identity: readonly string[];
  readonly model: AnyModel;
}

/**
 * The model's `updatedAt()` fields, each kept as stored (`stored()`):
 * ordering's own writes (move, respace, rekey) place a row, they do not
 * change it. A field a move's `data` names is written as named.
 */
const storedOf = (model: AnyModel): Row => {
  const scalars = model["~"].state.scalars;
  return Object.fromEntries(
    Object.keys(scalars)
      .filter((field) => {
        const { autoGenerate, array } = scalars[field]!["~"].state;
        return autoGenerate?.kind === "updatedAt" && !array;
      })
      .map((field) => [field, stored()])
  );
};

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
    const identity: readonly string[] | undefined = getRowKey(model)?.fields;
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

const PLACEMENTS = ["after", "before", "first", "last", "key"] as const;

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

/** A delegate's write, as respacing calls it. */
interface Writes {
  readonly updateMany: (args: object) => PromiseLike<unknown>;
}

type Order = readonly Readonly<Record<string, "asc" | "desc">>[];

/**
 * Respacing's keys, read from a derived table the `updateMany` joins (one
 * statement, the table read once before any row changes, on every
 * dialect). Over the lists holding a member the call sees that `where`
 * matches (every list, without it), each member is ranked in the list's
 * current order; the members the call may update by writing the key are
 * movable, the others fixed. A movable member takes a short key between the
 * keys of the fixed ones around the place it takes (its own place, or with
 * `order` the place of the movable member of that rank), `10`, `11`, … where
 * the list has none; a fixed member whose key is not a key bounds nothing.
 * A row is written only while it holds the list and the key it was ranked
 * with, so a member another writer moved meanwhile keeps that writer's
 * place.
 */
/**
 * A column of respacing's joined table: named `0viborm_…`, which no schema
 * identifier can be (they start with a letter or `_`).
 */
const named = (q: ModelSql, name: string): Sql =>
  q.name("r", `0viborm_${name}`);

const respacing = (ordered: Ordered, where: unknown, order: Order): string =>
  joined<string>({
    value: (q) => named(q, "nk"),
    rows: (q, read) => respaceRows(ordered, where, order, q, read),
    join: (q, target) => respaceJoin(ordered, where, order, q, target),
  });

/**
 * Respacing's keys as a list, for a database whose UPDATE joins no derived
 * table (SurrealDB): every member of each list respaced is read, in the
 * call's unit, each list is placed as the joined statement places it
 * (`placed.ts`), and a member is named by its identity, its list and the key
 * it was ranked with, so one another writer moved meanwhile keeps that
 * writer's place.
 */
async function respaceRows(
  ordered: Ordered,
  where: unknown,
  order: Order,
  q: ModelSql,
  read: (statement: Sql) => Promise<readonly Row[]>
): Promise<{ where: Row; value: unknown }[]> {
  const { key, within, identity } = ordered;
  const terms = order.flatMap(
    (term) => Object.entries(term) as [string, "asc" | "desc"][]
  );
  const table = q.table();
  const as = (fields: readonly string[], prefix: string) =>
    fields.map(
      (field, at) => sql`${q.column(field)} AS ${sql.raw(`${prefix}${at}`)}`
    );
  // The lists respaced: those holding a member the call sees `where` matches.
  const seen = sql`WHERE ${q.visible("", { where: where as object | undefined })}`;
  let lists: readonly Row[];
  if (within.length > 0)
    lists = await read(
      sql`SELECT ${sql.join(as(within, "w"), ", ")} FROM ${table} ${seen} GROUP BY ${sql.join(
        within.map((_, at) => sql.raw(`w${at}`)),
        ", "
      )}`
    );
  else
    lists =
      where === undefined ||
      (await read(sql`SELECT VALUE { id: id } FROM ${table} ${seen} LIMIT 1`))
        .length > 0
        ? [{}]
        : [];
  const movable = sql`(IF ${q.visible("", { update: [key] })} { true } ELSE { false })`;
  const entries: { where: Row; value: unknown }[] = [];
  for (const list of lists) {
    const held = fieldsOf(
      within,
      Object.fromEntries(within.map((field, at) => [field, list[`w${at}`]]))
    );
    const conditions = within.map((field) =>
      held[field] === null
        ? sql`${q.column(field)} = NONE`
        : sql`${q.column(field)} = ${q.value(field, held[field])}`
    );
    const rows = await read(
      sql`SELECT ${sql.join(
        [
          sql`${q.column(key)} AS k`,
          ...as(identity, "i"),
          ...as(
            terms.map(([field]) => field),
            "o"
          ),
          sql`${movable} AS v`,
        ],
        ", "
      )} FROM ${table}${
        conditions.length > 0
          ? sql` WHERE ${sql.join(conditions, " AND ")}`
          : sql.empty
      }`
    );
    const next = placed(
      rows.map((row) => ({
        key: row.k ?? null,
        identity: identity.map((_, at) => row[`i${at}`]),
        order: terms.map((_, at) => row[`o${at}`] ?? null),
        movable: row.v === true,
      })),
      terms.map(([, way]) => way)
    );
    for (const [index, row] of rows.entries()) {
      const value = next[index];
      if (value === null || value === undefined) continue;
      entries.push({
        where: {
          ...Object.fromEntries(
            identity.map((field, at) => [field, row[`i${at}`]])
          ),
          ...held,
          [key]: row.k ?? null,
        },
        value,
      });
    }
  }
  return entries;
}

function respaceJoin(
  ordered: Ordered,
  where: unknown,
  order: Order,
  q: ModelSql,
  target: string
): { source: Sql; on: Sql } {
  {
    const { key, within, identity } = ordered;
    const s = spellings[q.dialect as SqlDialect];
    const terms = order.flatMap((term) => Object.entries(term));
    const column = (field: string, alias?: string) => q.column(field, alias);
    const at = (alias: string, prefix: string, count: number) =>
      Array.from({ length: count }, (_, n) =>
        sql.raw(`${alias}.${prefix}${n}`)
      );
    const ids = (alias: string) => at(alias, "i", identity.length);
    const lists = (alias: string) => at(alias, "w", within.length);
    const byList = (alias: string, ...more: Sql[]) =>
      within.length + more.length === 0
        ? sql.empty
        : sql`PARTITION BY ${sql.join([...lists(alias), ...more], ", ")} `;
    const current = (alias: string) =>
      sql.join([sql.raw(`${alias}.k`), ...ids(alias)], ", ");
    // The lists respaced: those holding a member the call sees `where` matches.
    const seen = q.visible("w", { where: where as object | undefined });
    const listed =
      within.length > 0
        ? sql`EXISTS (SELECT 1 FROM ${q.table("w")} WHERE ${sql.join(
            within.map((field) =>
              s.same(column(field, "w"), column(field, "s"))
            ),
            " AND "
          )} AND ${seen})`
        : where === undefined
          ? sql`1 = 1`
          : sql`EXISTS (SELECT 1 FROM ${q.table("w")} WHERE ${seen})`;
    const members = sql`SELECT ${sql.join(
      [
        ...identity.map(
          (field, n) => sql`${column(field, "s")} AS ${sql.raw(`i${n}`)}`
        ),
        ...within.map(
          (field, n) => sql`${column(field, "s")} AS ${sql.raw(`w${n}`)}`
        ),
        sql`${column(key, "s")} AS k`,
        ...terms.map(
          ([field], n) => sql`${column(field, "s")} AS ${sql.raw(`o${n}`)}`
        ),
        sql`(CASE WHEN ${q.visible("s", { update: [key] })} THEN 1 ELSE 0 END) AS v`,
      ],
      ", "
    )} FROM ${q.table("s")} WHERE ${listed}`;
    const bound = sql`(p.v = 0 AND ${s.digits(sql.raw("p.k"))})`;
    const picked = [
      ...terms.map(
        ([, direction], n) =>
          sql`${sql.raw(`p.o${n}`)} ${sql.raw(direction === "desc" ? "DESC" : "ASC")}`
      ),
      current("p"),
    ];
    const v = sql.raw("p.v");
    // The members after each, as a growing frame: MySQL rescans a frame that
    // ends at UNBOUNDED FOLLOWING for each row.
    const backwards = sql.join(
      [sql.raw("p.k DESC"), ...ids("p").map((id) => sql`${id} DESC`)],
      ", "
    );
    const ranked = sql`SELECT p.*, SUM(CASE WHEN ${bound} THEN 1 ELSE 0 END) OVER (${byList("p")}ORDER BY ${current("p")} ROWS UNBOUNDED PRECEDING) AS seg, MAX(CASE WHEN ${bound} THEN p.k END) OVER (${byList("p")}ORDER BY ${current("p")} ROWS UNBOUNDED PRECEDING) AS lo, MIN(CASE WHEN ${bound} THEN p.k END) OVER (${byList("p")}ORDER BY ${backwards} ROWS UNBOUNDED PRECEDING) AS hi, ROW_NUMBER() OVER (${byList("p", v)}ORDER BY ${current("p")}) AS slot, ROW_NUMBER() OVER (${byList("p", v)}ORDER BY ${sql.join(picked, ", ")}) AS pick FROM (${members}) AS p`;
    const segment = sql.join([...lists("q"), sql.raw("q.seg")], ", ");
    const movables = sql`SELECT q.*, ROW_NUMBER() OVER (PARTITION BY ${segment} ORDER BY ${current("q")}) AS r, COUNT(*) OVER (PARTITION BY ${segment}) AS cnt FROM (${ranked}) AS q WHERE q.v = 1`;
    // A place's key: its rank among the movable members between two fixed
    // keys, fixed width, the last digit not zero.
    const keyOf = (alias: string) => {
      const g = (name: string) => sql.raw(`${alias}.${name}`);
      const n = sql`(${g("slot")} - 1)`;
      return sql`CASE WHEN ${g("lo")} IS NULL AND ${g("hi")} IS NULL THEN ${s.concat(
        s.text(s.length(s.text(n))),
        s.text(n)
      )} ELSE ${between(
        s,
        g("lo"),
        g("hi"),
        s.concat(s.pad(s.text(g("r")), s.length(s.text(g("cnt")))), sql`'1'`)
      )} END`;
    };
    const keyed =
      terms.length === 0
        ? sql`SELECT ${sql.join([...ids("g"), ...lists("g")], ", ")}, g.k, ${keyOf("g")} AS nk FROM (${movables}) AS g`
        : s.selfJoin(
            movables,
            sql`${sql.join([...ids("m"), ...lists("m")], ", ")}, m.k, ${keyOf("t")} AS nk`,
            sql.join(
              [
                ...within.map((_, n) =>
                  s.same(sql.raw(`t.w${n}`), sql.raw(`m.w${n}`))
                ),
                sql`t.slot = m.pick`,
              ],
              " AND "
            )
          );
    // Its columns, named as no column of the model can be (`joined`): the
    // UPDATE's own columns stay unambiguous beside them.
    const names = [
      ...identity.map((_, n) => `i${n}`),
      ...within.map((_, n) => `w${n}`),
      "k",
      "nk",
    ];
    const source = sql`SELECT ${sql.join(
      names.map(
        (name) => sql`${sql.raw(`x.${name}`)} AS ${q.name(`0viborm_${name}`)}`
      ),
      ", "
    )} FROM (${keyed}) AS x`;
    const r = (name: string) => named(q, name);
    return {
      source: sql`(${source}) AS r`,
      on: sql.join(
        [
          ...identity.map(
            (field, n) => sql`${r(`i${n}`)} = ${column(field, target)}`
          ),
          // Still in the list and at the key it was ranked with.
          ...within.map((field, n) =>
            s.same(r(`w${n}`), column(field, target))
          ),
          sql`${column(key, target)} = ${r("k")}`,
          sql`${r("nk")} IS NOT NULL`,
        ],
        " AND "
      ),
    };
  }
}

/**
 * Respace through the client: one `updateMany` of the lists' members the
 * call may update, its keys read from a joined table, so every extension applies
 * (rows, permissions, hooks, the cache); `updatedAt` stays as stored.
 * Returns the rows rewritten.
 */
async function respace(
  ordered: Ordered,
  writes: Writes,
  controls: Row,
  where: unknown,
  order: Order = []
): Promise<number> {
  const written = (await writes.updateMany({
    ...controls,
    data: {
      ...storedOf(ordered.model),
      [ordered.key]: respacing(ordered, where, order),
    },
  })) as { count: number };
  return written.count;
}

function methods(ordered: Ordered, dialect: string) {
  const { name, key, within, identity, model } = ordered;
  const scalars = model["~"].state.scalars;
  const stored = storedOf(model);
  /** A row read with its key: the unique selector naming it, a cursor. */
  const rowKey = getRowKey(model)!;
  const selectorOf = (row: Row): Row =>
    rowKey.name === undefined
      ? { [rowKey.fields[0]!]: row[rowKey.fields[0]!] }
      : { [rowKey.name]: fieldsOf(rowKey.fields, row) };
  // A nullable list field: the engine's cursor over the default order cannot
  // seek past it, so the anchor's neighbours are read within its list.
  const open = within.some((field) => scalars[field]!["~"].state.nullable);
  const keyOrder = [key, ...identity].map((field) => ({
    [field]: "asc" as const,
  }));
  const selection = Object.fromEntries(
    [...identity, ...within, key].map((field) => [field, true])
  );
  // What a move's `data` writes: the model's own fields, never the key nor
  // the list's, and no relation (a nested write may change the list, or a
  // related key a foreign key cascades into it).
  const placing = [key, ...within];
  const places = (data: Readonly<Record<string, unknown>>) =>
    Object.entries(data).some(
      ([field, value]) =>
        value !== undefined &&
        (!Object.hasOwn(scalars, field) || placing.includes(field))
    );
  /** The fields `where` names with a value (a compound selector's too): how
   * the moved row is recognised among rows read, without reading it. */
  const named = (where: Row): Row => {
    const fields: Record<string, unknown> = {};
    const take = (field: string, value: unknown) => {
      if (
        Object.hasOwn(scalars, field) &&
        (value === null || value instanceof Date || typeof value !== "object")
      )
        fields[field] = value;
    };
    for (const [field, value] of Object.entries(where))
      if (Object.hasOwn(scalars, field)) take(field, value);
      // A compound selector's fields; never a logical operator's.
      else if (
        value !== null &&
        typeof value === "object" &&
        !["AND", "OR", "NOT"].includes(field)
      )
        for (const [inner, part] of Object.entries(value)) take(inner, part);
    return fields;
  };
  /**
   * The move as one UPDATE (two where the row changes list), its key computed
   * by the statement from the keys around its place (`between.ts`), the row
   * written only while it is where the key was computed for: PostgreSQL and
   * SQLite. MISSED where no write matched (a missing or tied neighbour, a
   * gap used up, a missing row): the move then reads and respaces.
   */
  async function inStatement(
    place: {
      readonly where: Row;
      readonly anchor: Row | undefined;
      readonly after: boolean;
      readonly first: boolean;
    },
    to: Row | undefined,
    recognised: Row,
    q: ModelSql,
    write: (guard: Sql, data: Row) => PromiseLike<unknown>
  ): Promise<unknown> {
    // MySQL locks every row a statement's subqueries read (the locating
    // SELECT … FOR UPDATE and the UPDATE alike): concurrent moves into one
    // list deadlocked 37 times in 240 there (measured), none on the read
    // path, which reads the neighbours by a consistent read.
    if (dialect !== "postgresql" && dialect !== "sqlite") return MISSED;
    const anchored =
      place.anchor === undefined ? undefined : named(place.anchor);
    if (
      Object.keys(recognised).length === 0 ||
      (anchored !== undefined && Object.keys(anchored).length === 0)
    )
      return MISSED;
    const s = spellings[dialect];
    const table = q.table();
    const column = (field: string, alias?: string) => q.column(field, alias);
    const matches = (alias: string, fields: Row) =>
      sql.join(
        Object.entries(fields).map(([field, value]) =>
          value === null
            ? sql`${column(field, alias)} IS NULL`
            : sql`${column(field, alias)} = ${q.value(field, value)}`
        ),
        " AND "
      );
    // Not that row: where a field it names is NULL in another row, the
    // match is unknown there, and that row is still another one.
    const other = (alias: string, fields: Row) =>
      sql`NOT COALESCE((${matches(alias, fields)}), 1 = 0)`;
    // The anchor and the neighbours are read as the caller sees them: each
    // read takes the call's row domain (`RowsOf`), as every read of the
    // engine does, so a hidden anchor is a missing one and a hidden member
    // is no neighbour. The moved row is the UPDATE's own target, which the
    // UPDATE reads under that domain already.
    const seen = (alias: string) => q.visible(alias);
    const of = (alias: string, fields: Row, field: string) =>
      sql`(SELECT ${column(field, alias)} FROM ${table} AS ${sql.raw(alias)} WHERE ${matches(alias, fields)}${
        alias === "a" ? sql` AND ${seen("a")}` : sql.empty
      })`;
    // The list's fields: the anchor's, `to`'s, else the row's own.
    const listed = (field: string) =>
      anchored !== undefined
        ? of("a", anchored, field)
        : to !== undefined
          ? to[field] === null
            ? sql`NULL`
            : q.value(field, to[field])
          : of("m", recognised, field);
    // A required list field compares with `=`; a nullable one NULL-safely.
    const inList = (alias?: string) =>
      within.length === 0
        ? sql`1 = 1`
        : sql.join(
            within.map((field) =>
              // `to` names the list by value: no NULL to compare safely.
              to !== undefined && anchored === undefined && to[field] === null
                ? sql`${column(field, alias)} IS NULL`
                : scalars[field]!["~"].state.nullable && to === undefined
                  ? s.same(column(field, alias), listed(field))
                  : sql`${column(field, alias)} = ${listed(field)}`
            ),
            " AND "
          );
    const anchorKey =
      anchored &&
      sql`SELECT ${column(key, "a")} FROM ${table} AS a WHERE ${matches("a", anchored)} AND ${other("a", recognised)} AND ${s.digits(column(key, "a"))} AND ${seen("a")}`;
    // The nearest key on one side, in the list, the moved row aside.
    const nearest = (aggregate: "MIN" | "MAX") =>
      sql`SELECT ${sql.raw(aggregate)}(${column(key, "n")}) FROM ${table} AS n WHERE ${inList("n")} AND ${other("n", recognised)} AND ${s.digits(column(key, "n"))} AND ${seen("n")}${
        anchored && anchorKey
          ? sql` AND ${column(key, "n")} ${sql.raw(aggregate === "MIN" ? ">=" : "<=")} (${anchorKey}) AND ${other("n", anchored)}`
          : sql.empty
      }`;
    const none = sql`NULL`;
    // The keys around the row's place.
    const [lower, upper] =
      anchorKey === undefined
        ? place.first
          ? [none, nearest("MIN")]
          : [nearest("MAX"), none]
        : place.after
          ? [anchorKey, nearest("MIN")]
          : [nearest("MAX"), anchorKey];
    const placed = between(
      s,
      lower,
      upper,
      jitter(),
      anchorKey === undefined ? undefined : place.after ? "lower" : "upper"
    );
    // A row of the list already there: written by no statement here, so the
    // read path answers it unchanged.
    const away = sql`NOT ((${lower}) IS NULL OR ${column(key)} > (${lower})) OR NOT ((${upper}) IS NULL OR ${column(key)} < (${upper}))`;
    const guard = (condition?: Sql) =>
      sql`CASE WHEN ${placed} IS NOT NULL${
        condition === undefined ? sql.empty : sql` AND (${condition})`
      } THEN ${column(key)} END`;
    const keyed = { [key]: computed(() => [placed]) };
    const attempt = async (condition: Sql | undefined, data: Row) => {
      try {
        return await write(guard(condition), data);
      } catch (error) {
        if (error instanceof NotFoundError) return MISSED;
        throw error;
      }
    };
    // Its own list, or a model of one list: the key alone.
    if (within.length === 0 || (anchored === undefined && to === undefined))
      return attempt(away, keyed);
    const joined = {
      ...keyed,
      ...Object.fromEntries(
        within.map((field) => [
          field,
          anchored === undefined ? to![field] : computed(() => [listed(field)]),
        ])
      ),
    };
    // The key alone while the row stays in the list (no permission on the
    // list fields needed), else the key and the list; `to` tries the move
    // first.
    const outside = sql`NOT (${inList()})`;
    const inside = sql`${inList()} AND (${away})`;
    if (to !== undefined) {
      const moved = await attempt(outside, joined);
      return moved === MISSED ? attempt(inside, keyed) : moved;
    }
    const stayed = await attempt(inside, keyed);
    // A list field in the row key is written by the read path, by value.
    return stayed === MISSED &&
      !within.some((field) => identity.includes(field))
      ? attempt(outside, joined)
      : stayed;
  }
  return (delegate: Delegate) => {
    async function place(args: Readonly<Record<string, unknown>>) {
      const {
        where,
        after,
        before,
        first,
        last,
        key: given,
        to,
        data,
        select,
        include,
        omit,
        ...controls
      } = args as Record<string, unknown> & { where: Row };
      const chosen = PLACEMENTS.filter((option) => args[option] !== undefined);
      if (chosen.length > 1 || (chosen.length === 0 && to === undefined))
        invalid(
          name,
          "give exactly one of after, before, first, last, key, or to."
        );
      if (to !== undefined && (after !== undefined || before !== undefined))
        invalid(
          name,
          "to goes with first, last or key, not with after or before."
        );
      if (given !== undefined && !isKeyFormat(given))
        invalid(name, "key takes an ordering key (isKeyFormat, keyBetween).");
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
      // Read once: the copy is what is checked and written.
      // A field given `undefined` is left out, as in any update.
      const extra: Row = isRecord(data)
        ? Object.fromEntries(
            Object.entries(data).filter(([, value]) => value !== undefined)
          )
        : {};
      if (data !== undefined && (!isRecord(data) || places(extra)))
        invalid(
          name,
          `data writes the model's own fields beside the key: not ${placing.join(", ")}${within.length === 0 ? "" : " (to moves the row between lists)"}, nor a relation.`
        );
      // What every write of the move writes beside its key and list.
      const writing: Row = { ...stored, ...extra };
      const anchor = (after ?? before) as Row | undefined;
      const projection = {
        ...(select === undefined ? {} : { select }),
        ...(include === undefined ? {} : { include }),
        ...(omit === undefined ? {} : { omit }),
      };
      // A key the caller computed (`keyBetween` over the neighbours it
      // shows): written as given, in one update, nothing read first.
      if (given !== undefined)
        try {
          return await delegate.update!({
            ...controls,
            where,
            data: {
              ...writing,
              [key]: given,
              ...((to as Row | undefined) ?? {}),
            },
            ...projection,
          });
        } catch (error) {
          throw error instanceof NotFoundError
            ? new NotFoundError(name, "move")
            : error;
        }
      const recognised = named(where);
      const fields = Object.keys(recognised);
      const isMoved = (row: Row) =>
        fields.length > 0 &&
        fields.every((field) => same(row[field], recognised[field]));
      const reading = {
        ...selection,
        ...Object.fromEntries(fields.map((field) => [field, true])),
      };
      // Already in place: its key stays; what `data` writes is written.
      const inPlace = async () => {
        if (Object.keys(extra).length > 0)
          try {
            return await delegate.update!({
              ...controls,
              where,
              data: writing,
              ...projection,
            });
          } catch (error) {
            throw error instanceof NotFoundError
              ? new NotFoundError(name, "move")
              : error;
          }
        const row = await delegate.findUnique!({
          ...controls,
          where,
          ...projection,
        });
        if (row === null) throw new NotFoundError(name, "move");
        return row;
      };
      const moved = await inStatement(
        { where, anchor, after: after !== undefined, first: first === true },
        to as Row | undefined,
        recognised,
        (delegate as unknown as { $sql: ModelSql }).$sql,
        (guard, data) =>
          delegate.update!({
            ...controls,
            where: { ...where, [key]: { equals: () => guard } },
            data: { ...writing, ...data },
            ...projection,
          })
      );
      if (moved !== MISSED) return moved;
      for (let attempt = 1; ; attempt++) {
        if (attempt > MOVE_ATTEMPTS)
          throw new QueryError(
            `${name}.move: the list kept changing under concurrent writes; try again.`
          );
        let group: Row;
        let low: string | null;
        let high: string | null;
        // Whether the row is known to be in `group` already.
        let home = within.length === 0;
        if (anchor !== undefined) {
          // The anchor and the rows after (or before) it in the list's order
          // (the `order` capability), the moved row recognised among them.
          // The moved row itself is not read.
          // The anchor itself, by all it states, where the cursor cannot
          // carry it: a nullable list field, or a condition beside its key.
          const at =
            open || Object.keys(anchor).length > 1
              ? ((await delegate.findUnique!({
                  ...controls,
                  where: anchor,
                  select: reading,
                })) as Row | null)
              : undefined;
          const rows =
            at === null
              ? []
              : ((await delegate.findMany!({
                  ...controls,
                  ...(at && { where: fieldsOf(within, at), orderBy: keyOrder }),
                  cursor: at ? selectorOf(at) : anchor,
                  take: after === undefined ? -3 : 3,
                  select: reading,
                })) as Row[]);
          const found = after === undefined ? rows.at(-1) : rows[0];
          if (found === undefined) throw new NotFoundError(name, "move anchor");
          // The anchor left the list it was read in before its neighbours
          // were: the cursor's row is outside them, and the row read in its
          // place is another one. Read again.
          if (
            at &&
            !rowKey.fields.every((field) => same(found[field], at[field]))
          )
            continue;
          if (isMoved(found))
            invalid(name, "a row cannot be placed next to itself.");
          group = fieldsOf(within, found);
          const others = (
            after === undefined ? rows.slice(0, -1).reverse() : rows.slice(1)
          ).filter((row) =>
            within.every((field) => same(row[field], found[field]))
          );
          // Already the anchor's neighbour on that side: nothing to write.
          if (others[0] !== undefined && isMoved(others[0])) return inPlace();
          const neighbour =
            (others.find((row) => !isMoved(row))?.[key] as
              | string
              | undefined) ?? null;
          [low, high] =
            after === undefined
              ? [neighbour, found[key] as string]
              : [found[key] as string, neighbour];
        } else {
          if (to === undefined && within.length > 0) {
            // First or last of its own list: the one read of the row.
            const moved = (await delegate.findUnique!({
              ...controls,
              where,
              select: selection,
            })) as Row | null;
            if (moved === null) throw new NotFoundError(name, "move");
            group = fieldsOf(within, moved);
            home = true;
          } else group = (to as Row | undefined) ?? {};
          // The list's two rows at that end, the moved row recognised.
          const rows = (await delegate.findMany!({
            ...controls,
            where: group,
            take: first === true ? 2 : -2,
            select: reading,
          })) as Row[];
          const ends = first === true ? rows : [...rows].reverse();
          if (ends[0] !== undefined && isMoved(ends[0])) return inPlace();
          const bound =
            (ends.find((row) => !isMoved(row))?.[key] as string | undefined) ??
            null;
          [low, high] = first === true ? [null, bound] : [bound, null];
        }
        let next: string | undefined;
        try {
          if (
            (low === null || isKeyFormat(low)) &&
            (high === null || isKeyFormat(high)) &&
            (low === null || high === null || low < high)
          )
            next = keyBetween(low, high);
        } catch {
          // An integer past 10^9: the list is respaced below.
        }
        if (next === undefined || !isKeyFormat(next)) {
          // Tied or malformed neighbours, or a gap split too often: the
          // list is respaced, then read again.
          await respace(
            ordered,
            delegate as unknown as Writes,
            controls,
            within.length === 0 ? undefined : group
          );
          continue;
        }
        // The row's list is not read: its key alone is written where the row
        // is in `group` already (so a reorder needs no permission on the list
        // fields), else the key and the list. `to` tries the move first.
        const stay = {
          where: { ...where, ...group },
          data: { ...writing, [key]: next },
        };
        const join = (guarded: boolean) => ({
          where: guarded
            ? {
                ...where,
                NOT:
                  where.NOT === undefined ? group : [where.NOT, group].flat(),
              }
            : where,
          data: { ...writing, [key]: next, ...group },
        });
        const writes = home
          ? [{ where, data: { ...writing, [key]: next } }]
          : to === undefined
            ? [stay, join(false)]
            : [join(true), stay];
        for (const write of writes)
          try {
            return await delegate.update!({
              ...controls,
              ...write,
              ...projection,
            });
          } catch (error) {
            if (!(error instanceof NotFoundError)) throw error;
          }
        throw new NotFoundError(name, "move");
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
          // The lists the matched rows are in, each respaced: named by the
          // UPDATE itself, through the caller's view (`Respace`).
          const count = await respace(
            ordered,
            delegate as unknown as Writes,
            controls,
            where,
            order
          );
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
// The schema's own: a list's fields and the order's are inputs, whatever a
// `defaultOmit` presents.
type RowOf<C extends VibORMConfig, K> = OperationResult<
  "update",
  ClientSchema<C>[K & keyof ClientSchema<C>],
  object
>;
type WithinOf<
  Config extends OrderingConfig,
  K extends keyof Config,
> = Config[K]["within"] extends readonly (infer F extends string)[] ? F : never;
/** A list, by the values of its fields. */
type ListOf<
  C extends VibORMConfig,
  Config extends OrderingConfig,
  K extends keyof Config,
> = {
  readonly [F in WithinOf<Config, K>]: RowOf<C, K>[F & keyof RowOf<C, K>];
};
type None<Keys extends string> = { readonly [P in Keys]?: never };
/** Where `move` puts the row: exactly one of these. (The client type, the
 * first parameter, is no longer read: kept so 1.7.0 spellings compile.) */
export type MovePlacement<
  _M,
  C extends VibORMConfig,
  Config extends OrderingConfig,
  K extends keyof Config,
> =
  | ({ readonly after: Unique<C, K> } & None<
      "before" | "first" | "last" | "key" | "to"
    >)
  | ({ readonly before: Unique<C, K> } & None<
      "after" | "first" | "last" | "key" | "to"
    >)
  | ({ readonly first: true; readonly to?: ListOf<C, Config, K> } & None<
      "after" | "before" | "last" | "key"
    >)
  | ({ readonly last: true; readonly to?: ListOf<C, Config, K> } & None<
      "after" | "before" | "first" | "key"
    >)
  | ({ readonly key: string; readonly to?: ListOf<C, Config, K> } & None<
      "after" | "before" | "first" | "last"
    >)
  | ({ readonly to: ListOf<C, Config, K> } & None<
      "after" | "before" | "first" | "last" | "key"
    >);
/** The model's own scalar fields, as declared (an omitted one included). */
type ScalarsOf<C extends VibORMConfig, K> = ClientSchema<C>[K &
  keyof ClientSchema<C>] extends {
  readonly "~": { readonly state: { readonly scalars: infer S } };
}
  ? keyof S
  : never;
type UpdateData<C extends VibORMConfig, K> = NonNullable<
  NonNullable<ModelArgs<C, K, "update">>["data"]
>;
/** What a move writes beside the key, in the same UPDATE: an update's data
 * of the model's own fields, but the key and the list's (`to` moves a row
 * between lists), and no relation. */
type MoveData<
  C extends VibORMConfig,
  Config extends OrderingConfig,
  K extends keyof Config,
> = {
  readonly [F in Exclude<
    ScalarsOf<C, K> & keyof UpdateData<C, K>,
    Config[K]["key"] | WithinOf<Config, K>
  >]?: UpdateData<C, K>[F];
} & None<Config[K]["key"] | WithinOf<Config, K>>;
type MoveArgs<
  M,
  C extends VibORMConfig,
  Config extends OrderingConfig,
  K extends keyof Config,
> = Projection<C, K> & {
  readonly where: Unique<C, K>;
  readonly data?: MoveData<C, Config, K>;
} & MovePlacement<M, C, Config, K>;
/** A unique selector a move spells, its keys refused as an update's `where`. */
type SealedUnique<C extends VibORMConfig, K, Given> = NoExtraOperationKeys<
  "update",
  { readonly where: Given },
  NonNullable<ModelArgs<C, K, "update">>,
  ClientSchema<C>[K & keyof ClientSchema<C>]
>["where"];
/** The key `Spelled` names that `Allowed` has not. */
type Sealed<Spelled, Allowed> = Record<
  Exclude<keyof NonNullable<Spelled>, keyof Allowed>,
  never
>;
/**
 * A move's own keys, refused where they name nothing: `where` and the
 * anchors as an update's `where` is, `data` and `to` against the fields they
 * may write. `A` is inferred from the call, so every key it spells is known
 * to `MoveArgs`; demanding `never` for the others refuses them however the
 * argument was written. Three mapped types, not one with a conditional per
 * key: comparing two ordered clients' `move` (two `ordering()` calls) then
 * cost 2.5M instantiations instead of 0.1M.
 */
type SealedMove<
  A,
  C extends VibORMConfig,
  Config extends OrderingConfig,
  K extends keyof Config,
> = {
  readonly [P in keyof A & ("where" | "after" | "before")]?: SealedUnique<
    C,
    K,
    A[P]
  >;
} & {
  readonly [P in keyof A & "data"]?: Sealed<A[P], MoveData<C, Config, K>>;
} & { readonly [P in keyof A & "to"]?: Sealed<A[P], ListOf<C, Config, K>> };
type FindArg<C extends VibORMConfig, K, P extends string> = NonNullable<
  ModelArgs<C, K, "findMany">
>[P & keyof NonNullable<ModelArgs<C, K, "findMany">>];
type RekeyOrder<C extends VibORMConfig, K> = {
  readonly [F in keyof RowOf<C, K>]?: "asc" | "desc";
};
type RekeyArgs<C extends VibORMConfig, K> = {
  readonly where?: FindArg<C, K, "where">;
  readonly orderBy?: RekeyOrder<C, K> | readonly RekeyOrder<C, K>[];
};

/** One ordered model's methods. Exported so an exported client's
 * declaration names it instead of spelling its arguments out. */
export type OrderingMethods<
  M,
  C extends VibORMConfig,
  Config extends OrderingConfig,
  K extends keyof Config,
> = {
  // The row is typed from the delegate `move` is called on (`Self`), so it
  // follows every extension applied after this one.
  move<
    Self,
    const A extends DelegateOperationArgs<Self, MoveArgs<M, C, Config, K>>,
  >(
    this: Self,
    args: A & SealedMove<A, C, Config, K>
  ): PromiseLike<DelegateOperationResult<Self, "update", A>>;
  // Generic as `move` is, so a call's controls (`deleted`, …) pass along.
  rekey<A extends RekeyArgs<C, K>>(args?: A): PromiseLike<{ count: number }>;
};
type OrderingModels<
  M,
  C extends VibORMConfig,
  Config extends OrderingConfig,
> = {
  readonly [K in Names<Config>]: (
    delegate: never,
    scope: never
  ) => OrderingMethods<M, C, Config, K>;
};

type Governed<Config extends OrderingConfig> = VibORMConfig & {
  readonly schema: Record<Names<Config>, AnyModel>;
};

// One definition: the default order, the appended key, and `move` and
// `rekey`. A factory takes its delegate and scope as `never` (it reads
// nothing typed at this step), so later steps may add `rows` or
// `defaultOmit` freely.
function definitionOf<
  Config extends OrderingConfig,
  C extends Governed<Config>,
  X extends ExtensionState,
>(config: Config, client: VibORMClient<C, X>) {
  // `defineExtension` brings what reads the declarations made here.
  defineExtension();
  const admitted = admit(client.$schema, config);
  // Respacing renders with the client's driver: the scope a method is given
  // has none.
  const { $driver } = client as unknown as { $driver: Driver };
  return {
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
          { create: { [key]: appendKey(within) } },
        ])
      ) as {
        readonly [K in Names<Config> & keyof C["schema"]]: {
          readonly create: Record<Config[K]["key"], string>;
        };
      },
    },
    model: Object.fromEntries(
      admitted.map((ordered) => [
        ordered.name,
        methods(ordered, $driver.dialect),
      ])
    ) as unknown as OrderingModels<VibORMClient<C, X>, C, Config>,
  };
}

function apply<
  Config extends OrderingConfig,
  C extends Governed<Config>,
  X extends ExtensionState,
>(
  config: Config,
  base: VibORMClient<C, X>
): ExtendedClient<
  VibORMClient<C, X>,
  readonly [ReturnType<typeof definitionOf<Config, C, X>>]
> {
  return base.$extends(definitionOf(config, base)) as never;
}

/**
 * A model an entry orders, with the scalar fields the entry names (its key
 * and its list's): a misspelled one is refused at application, as a
 * misspelled model is. Read off the model's own scalars, one level deep.
 */
type OrderedModel<Fields extends string> = AnyModel & {
  readonly "~": {
    readonly state: { readonly scalars: Record<Fields, unknown> };
  };
};
type Receiver<Config extends OrderingConfig> = ClientTypeState<
  VibORMConfig,
  ExtensionState
> & {
  readonly $schema: {
    readonly [M in Names<Config>]: OrderedModel<
      Config[M]["key"] | WithinOf<Config, M>
    >;
  };
  readonly $extends: (...args: never[]) => unknown;
};
type Applied<
  Config extends OrderingConfig,
  Base,
> = Base extends ClientTypeState<
  infer C extends Governed<Config>,
  infer X extends ExtensionState
>
  ? Base extends VibORMClient<C, X>
    ? ReturnType<typeof apply<Config, C, X>>
    : never
  : never;
type OrderingExtension<Config extends OrderingConfig> = <
  Base extends Receiver<Config>,
>(
  base: Base
) => NoInfer<Applied<Config, Base>>;

/**
 * `{ models }`, or before 1.9.1 the models themselves: a model's entry holds
 * strings (`key`), never only entries, so a model named `models` is one.
 */
function isEnvelope<Config extends OrderingConfig>(
  given: Config | { readonly models: Config }
): given is { readonly models: Config } {
  return (
    Object.keys(given).length === 1 &&
    "models" in given &&
    isRecord(given.models) &&
    Object.values(given.models).every(isRecord)
  );
}

/**
 * Order the members of lists: `client.$extends(ordering({ models: { card: {
 * key: "rank", within: ["columnId"] } } }))`. One step, applied in any order
 * with the other extensions.
 */
// biome-ignore lint/style/useUnifiedTypeSignatures: one signature over both forms would infer Config from each.
export function ordering<const Config extends OrderingConfig>(config: {
  readonly models: Config;
}): OrderingExtension<Config>;
/** The models as the whole argument, the form before 1.9.1, still accepted: write `ordering({ models: { … } })`, as `softDelete` and `permissions` take theirs. */
export function ordering<const Config extends OrderingConfig>(
  config: Config
): OrderingExtension<Config>;
export function ordering<const Config extends OrderingConfig>(
  given: Config | { readonly models: Config }
): OrderingExtension<Config> {
  const config = isEnvelope(given) ? given.models : given;
  function extend<Base extends Receiver<Config>>(
    base: Base
  ): NoInfer<Applied<Config, Base>>;
  function extend<C extends Governed<Config>, X extends ExtensionState>(
    base: VibORMClient<C, X>
  ) {
    return apply(config, base);
  }
  return extend;
}
