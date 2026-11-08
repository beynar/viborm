/**
 * `docs/architecture/query-backend-frontier.md` step 4.
 *
 * Writes idiomatic SurrealQL from the engine's `Prepared*` descriptions, from
 * the relation and not from a translation of the SQL: a to-many is a reference
 * traversal holding its own query, `<~(SELECT * FROM post FIELD author …)`, a
 * to-one follows its link, and a junction is an edge table walked as a graph,
 * `->tagged->(SELECT * FROM tag …)`. No alias exists: each lowering knows the row
 * it writes for. What it does not cover refuses by name rather than read wrongly.
 */

import { UnsupportedOperationError } from "@errors";
import type {
  FieldGate,
  PreparedPredicate,
  PreparedProjection,
  PreparedProjectionField,
  Queries,
  Query,
  Read,
  ReadBackend,
} from "@query-engine/raptor3/shared/query";
import {
  approximateOrder,
  firstRow,
  rowSet,
} from "@query-engine/raptor3/shared/query";
import type {
  Arguments,
  Input,
  ReadOperation,
} from "@query-engine/raptor3/shared/schema";
import {
  linkMembers,
  type Membership,
} from "@query-engine/raptor3/shared/storage";
import { jsonNullKindOf } from "@schema/json-null";
import { Sql, sql } from "@sql";
import { Decimal, GeometryPoint, RecordId } from "surrealdb";
import type { SurrealQueries } from "./queries";

type AnyModel = PreparedProjection["model"];
type Relation = Extract<PreparedProjectionField, { kind: "relation" }>;
type Reference = Extract<Membership, { kind: "reference" }>;
type Junction = Extract<Membership, { kind: "junction" }>;
type Member = Junction["sourceSide"]["members"][number];
type VariantJunctionMember = Extract<
  Membership["scope"]["edge"],
  { kind: "variantJunctionCarrier" }
>["members"][number];

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** What a path reads as an array index, as PostgreSQL's `#>` does: `01` and `-1` too. */
const INDEX = /^-?\d{1,9}$/;
const QUOTABLE = /^[^`]+$/;
/**
 * How many rows a filter's body reads ahead of a page before it stops: past this,
 * walking the page's own rows finds what it needs sooner than listing every holder.
 */
const HOLDERS_AHEAD = 1000;
/** How deep an exhaustive walk goes: as deep as a SurrealDB recursion may. */
const MAX_WALK = 256;
const ARMS = 16;

function refuse(what: string): never {
  throw new UnsupportedOperationError(
    `The SurrealDB read backend does not support ${what} yet.`
  );
}

function name(identifier: string): Sql {
  if (IDENTIFIER.test(identifier)) return sql.raw(identifier);
  if (QUOTABLE.test(identifier)) return sql.raw(`\`${identifier}\``);
  return refuse(`the name '${identifier}'`);
}

function tableOf(model: AnyModel): string {
  return model["~"].names.sql!;
}

function isSingleKey(queries: Queries, model: AnyModel, field: string) {
  const keys = queries.keyOrder(model);
  return keys.length === 1 && keys[0] === field;
}

function reference(edge: Membership): Reference {
  if (edge.kind !== "reference") refuse("a junction here");
  return edge;
}

const BOOLEAN_LEAF = {
  kind: "scalar",
  type: "boolean",
  nullable: false,
} as const;
const COUNT_LEAF = { kind: "scalar", type: "int", nullable: false } as const;
const AGGREGATE_NAMES: readonly string[] = [
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
];
const AGGREGATE_FUNCTIONS: Readonly<Record<string, string>> = {
  _avg: "math::mean",
  _sum: "math::sum",
  _min: "array::min",
  _max: "array::max",
};

type OrderTerm = {
  readonly expression: Sql;
  /** A plain column: `ORDER BY` can read it without selecting it. */
  readonly named: boolean;
  /** The model's own field it orders by, when it is one. */
  readonly field?: string;
  readonly descending: boolean;
  readonly nullable: boolean;
  readonly nulls?: "first" | "last";
};

const HOLDS_SUBQUERY = /\bSELECT\b/;
/** Past this many, seeking one group after another costs more than reading them all. */
const GROUPS_SOUGHT = 20;
const PARENTS_READ_APART = 20;
const READS_A_ROW_ABOVE = /\$(?:parent|this|owner|row)\b/;
const COMPARISONS: Readonly<Record<string, string>> = {
  equals: "=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

const FUNCTIONS: Readonly<Record<string, string>> = {
  contains: "string::contains",
  startsWith: "string::starts_with",
  endsWith: "string::ends_with",
};

type ScalarFacts = {
  readonly type?: string;
  readonly array?: boolean;
};

type GeoPointValue = { readonly latitude: number; readonly longitude: number };

function geometry(point: GeoPointValue): GeometryPoint {
  return new GeometryPoint([point.longitude, point.latitude]);
}

/** A value as the database stores it: admission hands dates and decimals over as text. */
function stored(state: ScalarFacts | undefined, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (state?.array === true && Array.isArray(value))
    return value.map((member) => stored({ ...state, array: false }, member));
  switch (state?.type) {
    case "datetime":
      return new Date(value as string);
    case "decimal":
      return new Decimal(String(value));
    case "point":
      return geometry(value as GeoPointValue);
    default:
      return value;
  }
}

function isIntegerKey(model: AnyModel, field: string): boolean {
  const type = model["~"].state.scalars[field]?.["~"].state.type;
  return type === "int" || type === "bigint";
}

/** A key read back from text: an integer key's record names a number. */
function keyCast(model: AnyModel, field: string, value: Sql): Sql {
  return isIntegerKey(model, field) ? sql`<int>${value}` : value;
}

/** An exact decimal lands back on its scale, ties to even as `numeric` does here. */
export function quantized(
  state: { readonly decimal?: { readonly scale: number } } | undefined,
  value: Sql
): Sql {
  const scale = state?.decimal?.scale;
  if (scale === undefined) return value;
  const factor = sql.raw(`1${"0".repeat(scale)}dec`);
  return sql`(math::round(${value} * ${factor}) / ${factor})`;
}

/** One step of a JSON path: a key, bound, or both of what a number can name. */
function jsonStep(at: Sql, step: string): Sql {
  return INDEX.test(step)
    ? sql`(IF type::is_array(${at}) { array::at(${at}, ${sql.raw(String(Number(step)))}) } ELSE { ${at}[${step}] })`
    : sql`${at}[${step}]`;
}

const sameValue = (_key: string, value: unknown) =>
  typeof value === "bigint" ? `${value}n` : value;

/** Whether this is a value bound as it stands, with nothing stated around it. */
export function isOneValue(member: Sql): boolean {
  return (
    member.values.length === 1 && member.strings.every((text) => text === "")
  );
}

/**
 * A list as one parameter where each member is one value: a statement holds about
 * 65,000 values at most ("IR table full"), and a parser reads each it is given.
 */
export function boundList(members: readonly Sql[]): Sql {
  return members.every(isOneValue)
    ? sql`${members.map((member) => member.values[0])}`
    : sql`[${sql.join([...members], ", ")}]`;
}

/** A record's key cannot be an instant or a decimal, so a key that is one is its text. */
function keyPart(model: AnyModel, field: string, value: unknown): unknown {
  const type = model["~"].state.scalars[field]?.["~"].state.type;
  if (type === "datetime") return new Date(value as string).toISOString();
  if (type === "decimal") return new Decimal(String(value)).toString();
  return value;
}

/** Whether a predicate is only rows being among lists, which nothing unset is. */
function onlyLists(predicate: PreparedPredicate): boolean {
  switch (predicate.kind) {
    case "and":
      return predicate.predicates.some(onlyLists);
    case "or":
      return predicate.predicates.every(onlyLists);
    case "layer":
      return onlyLists(predicate.predicate);
    case "relation":
      return (
        !predicate.closure &&
        (predicate.quantifier === "some" || predicate.quantifier === "is") &&
        predicate.predicate !== undefined
      );
    default:
      return false;
  }
}

/** Whether a predicate reads a row a filter stepped away from, at any depth. */
function readsAbove(predicate: PreparedPredicate): boolean {
  switch (predicate.kind) {
    case "and":
    case "or":
      return predicate.predicates.some(readsAbove);
    case "not":
    case "layer":
      return readsAbove(predicate.predicate);
    case "relation":
      return (
        (predicate.predicate !== undefined &&
          readsAbove(predicate.predicate)) ||
        (predicate.link !== undefined && readsAbove(predicate.link))
      );
    case "operation":
      return [predicate.operand, ...(predicate.operands ?? [])].some(
        (operand) => operand?.kind === "field" && Boolean(operand.up)
      );
    default:
      return false;
  }
}

/**
 * Each condition once. It asks nothing more, and the server fails a statement stating
 * one equality twice with the same value ("Internal database error: stale IR id").
 */
export function onceEach(conditions: readonly Sql[]): Sql[] {
  const seen = new Set<string>();
  return conditions.filter((condition) => {
    const key = `${condition.toStatement()} ${JSON.stringify(condition.values, sameValue)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Arms joined in parentheses of at most `ARMS` each: a parser counts each `OR` as a level. */
function joined(arms: readonly Sql[], word: string): Sql {
  if (arms.length <= ARMS) return sql.join([...arms], word);
  const groups: Sql[] = [];
  for (let at = 0; at < arms.length; at += ARMS)
    groups.push(sql`(${sql.join(arms.slice(at, at + ARMS), word)})`);
  return joined(groups, word);
}

/** Whether a predicate reads other rows, through a relation or a whole table. */
export function walksFurther(predicate: PreparedPredicate): boolean {
  switch (predicate.kind) {
    case "and":
    case "or":
      return predicate.predicates.some(walksFurther);
    case "not":
      return walksFurther(predicate.predicate);
    case "layer":
      return walksFurther(predicate.predicate);
    case "relation":
    case "exists":
      return true;
    default:
      return false;
  }
}

/** What a statement's text says outside its comments and string literals. */
const NOT_STATED =
  /\/\*[\s\S]*?\*\/|--[^\n]*|\/\/[^\n]*|#[^\n]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;
/** The one field an index is on, written as its placeholder. */
const ON_ONE_FIELD =
  /\b(?:FIELDS|COLUMNS)\s+\{([^{}]+)\}(?=\s+[A-Za-z]|\s*;?\s*$)/i;
const HNSW = /\bHNSW\b/i;
const DIST = /\bDIST\s+([A-Za-z_]+)/i;
const DIMENSION = /\bDIMENSION\s+(\d+)/i;
const DISTANCES: Readonly<Record<string, string>> = {
  l2: "EUCLIDEAN",
  cosine: "COSINE",
};
/** The least candidates a nearest-neighbour search keeps: pgvector's own default. */
const EF_SEARCH = 40;

/** A declared HNSW index on one field: its distance and dimension. */
interface NearestIndex {
  readonly field: string;
  readonly distance: string;
  readonly dimension: number | undefined;
}
const nearestIndexes = new WeakMap<AnyModel, readonly NearestIndex[]>();

/** The HNSW indexes a model's raw `surrealdb` texts declare, read once per model. */
function nearestIndexesOf(model: AnyModel): readonly NearestIndex[] {
  const known = nearestIndexes.get(model);
  if (known) return known;
  const found = model["~"].rawIndexes.flatMap((index): NearestIndex[] => {
    const text = index.templates.surrealdb?.replace(NOT_STATED, " ");
    const field = text && ON_ONE_FIELD.exec(text)?.[1];
    if (!(field && HNSW.test(text))) return [];
    const dimension = DIMENSION.exec(text)?.[1];
    return [
      {
        field,
        // SurrealDB's own default.
        distance: (DIST.exec(text)?.[1] ?? "EUCLIDEAN").toUpperCase(),
        dimension: dimension === undefined ? undefined : Number(dimension),
      },
    ];
  });
  nearestIndexes.set(model, found);
  return found;
}

export class SurrealReadBackend implements ReadBackend {
  readonly #queries: SurrealQueries;

  constructor(queries: SurrealQueries) {
    this.#queries = queries;
  }

  /** The subqueries a statement computes once, ahead of itself, while it is built. */
  #lets: Sql[] | undefined;
  #hoists = 0;
  readonly #hoisted = new Map<string, Sql>();
  /** How many relation reads are being written around this point of a statement. */
  #inRelation = 0;
  #guardsCursor = false;
  #cursorGuard: Sql | undefined;
  /** The relation filter a page reads by walking, with its list already too long. */
  #walking: PreparedPredicate | undefined;
  /** The rows a root page reads, when they are few enough to give each its own read. */
  #parents:
    | { readonly read: Sql; readonly count: number; ids?: Sql }
    | undefined;
  /** Whether what is being lowered reads rows a write would leave. */
  #judging = false;
  /** What holds each row a relation filter stepped away from, innermost last. */
  readonly #above: string[] = [];

  /**
   * A statement that may compute what reads no row ahead of itself. A list held
   * in a variable reads each of its records by key, where the same subquery in a
   * `WHERE` is probed row by row, and it stays one statement, so one transaction.
   */
  hoisted(build: () => Sql): Sql {
    if (this.#lets) return build();
    this.#lets = [];
    this.#hoists = 0;
    this.#hoisted.clear();
    try {
      const body = build();
      // Each at the top level: a server compiles a statement in the square of the
      // subqueries it holds, and keeps each statement it has compiled.
      return this.#lets.length
        ? sql`${sql.join(this.#lets, " ")} ${body}`
        : body;
    } finally {
      this.#lets = undefined;
    }
  }

  /**
   * `build` reading rows a write would leave: a to-one link is the row's own value,
   * not the stored one, so a list of what holds reads targets, not who stores them.
   */
  judging(build: () => Sql): Sql {
    return this.judgingAll(build);
  }

  #hoist(expression: Sql): Sql | undefined {
    if (!this.#lets) return undefined;
    // A policy states one subquery for every action it answers: it runs once.
    const key = `${expression.toStatement()} ${JSON.stringify(expression.values, sameValue)}`;
    const known = this.#hoisted.get(key);
    if (known) return known;
    this.#hoists += 1;
    const variable = sql.raw(`$h${this.#hoists}`);
    this.#lets.push(sql`LET ${variable} = ${expression};`);
    this.#hoisted.set(key, variable);
    return variable;
  }

  read(model: AnyModel, operation: ReadOperation, args: Arguments): Read {
    let read: Read | undefined;
    const statement = this.hoisted(() => {
      read = this.#read(model, operation, args);
      return read.query.sql;
    });
    return { ...read!, query: { ...read!.query, sql: statement } };
  }

  #read(model: AnyModel, operation: ReadOperation, args: Arguments): Read {
    const q = this.#queries;
    const projected = () => q.prepareProjection(model, args);
    switch (operation) {
      case "findUnique": {
        const prepared = projected();
        const selector =
          args.where === undefined
            ? undefined
            : q.prepareSelector(model, args.where, true, false);
        const query = {
          // One row at most: an order would only sort it.
          sql: this.statement(
            model,
            prepared,
            { ...args, unordered: true },
            q.scoped(model, selector?.predicate, "root")
          ),
          shape: prepared.shape,
        };
        return {
          query,
          single: true,
          value: query.shape,
          result: firstRow,
        };
      }
      case "findFirst": {
        const prepared = projected();
        // A negative take reads from the end: the flipped order still gives one row.
        const take = args.take === undefined ? 1 : Math.sign(args.take);
        const query = {
          sql: this.statement(
            model,
            prepared,
            { ...args, take, nearest: approximateOrder(operation, args) },
            this.#filter(model, args)
          ),
          shape: prepared.shape,
        };
        return {
          query,
          single: true,
          value: query.shape,
          result: firstRow,
        };
      }
      case "findMany": {
        const prepared = projected();
        const query = {
          sql: this.statement(
            model,
            prepared,
            { ...args, nearest: approximateOrder(operation, args) },
            this.#filter(model, args)
          ),
          shape: prepared.shape,
        };
        return {
          query,
          single: false,
          value: rowSet(query),
          result:
            (args.take ?? 0) < 0
              ? (rows) => [...rows].reverse()
              : (rows) => rows,
        };
      }
      case "exist": {
        const table = name(tableOf(model));
        const predicate = this.#filter(model, args);
        const where = predicate
          ? sql`WHERE ${this.predicate(predicate, true)} `
          : sql.raw("");
        return {
          query: {
            sql: sql`RETURN [{ _count: array::len(SELECT VALUE id FROM ${table} ${where}LIMIT 1) > 0 }]`,
            shape: { kind: "object", fields: { _count: BOOLEAN_LEAF } },
          },
          single: false,
          value: BOOLEAN_LEAF,
          result: (rows) => rows[0]?._count ?? false,
        };
      }
      case "count": {
        const selected = args.select as Input | undefined;
        const outputs: readonly (readonly [string, string | undefined])[] =
          selected
            ? [
                ...(selected._all ? [["_all", undefined] as const] : []),
                ...Object.keys(selected)
                  .filter((field) => field !== "_all" && selected[field])
                  .map((field) => [field, field] as const),
              ]
            : [["_count", undefined] as const];
        const counted = sql.join(
          outputs.map(([alias, field]) =>
            field === undefined
              ? sql`count() AS ${name(alias)}`
              : sql`count(${this.#operand(model, field)} != NONE) AS ${name(alias)}`
          ),
          ", "
        );
        const query = {
          sql: sql`SELECT ${counted} FROM ${this.#rows(model, args)} GROUP ALL`,
          shape: {
            kind: "object" as const,
            fields: Object.fromEntries(
              outputs.map(([alias]) => [alias, COUNT_LEAF])
            ),
          },
        };
        return {
          query,
          single: selected !== undefined,
          value: selected ? query.shape : COUNT_LEAF,
          result: (rows) =>
            selected ? (rows[0] ?? {}) : ((rows[0]?._count as number) ?? 0),
        };
      }
      case "aggregate": {
        const query = this.#aggregation(model, args, []);
        return {
          query,
          single: true,
          value: query.shape,
          result: firstRow,
        };
      }
      case "groupBy": {
        const query = this.#aggregation(model, args, args.by as string[]);
        return {
          query,
          single: false,
          value: rowSet(query),
          result: (rows) => rows,
        };
      }
      default:
        return refuse(`'${operation}'`);
    }
  }

  /**
   * Where a field is stored. A record's key is its id: a single key is `id`
   * whatever the field is called, and a compound key is an array id, read by
   * position.
   */
  physical(model: AnyModel, field: string): Sql {
    const keys = this.#queries.keyOrder(model);
    const position = keys.indexOf(field);
    if (position < 0) return name(this.#queries.columnName(model, field));
    return sql.raw(keys.length === 1 ? "id" : `id[${position}]`);
  }

  /**
   * Whether a predicate of one row can be answered by following its links, each a
   * read by key, and by lists of who holds what lies at their ends.
   */
  #walksForward(predicate: PreparedPredicate): boolean {
    switch (predicate.kind) {
      case "and":
      case "or":
        return predicate.predicates.every((arm) => this.#walksForward(arm));
      case "not":
      case "layer":
        return this.#walksForward(predicate.predicate);
      case "always":
      case "operation":
        return true;
      case "relation": {
        const { edge, closure, link, predicate: inner } = predicate;
        if (closure || link) return false;
        const asked = this.#queries.scoped(edge.target, inner, "related");
        if (
          edge.kind === "reference" &&
          !edge.many &&
          edge.owner === "source" &&
          this.#linked(edge)
        )
          return (
            !(asked && readsAbove(asked)) &&
            (asked === undefined || this.#walksForward(asked))
          );
        return (
          asked !== undefined &&
          predicate.quantifier !== "every" &&
          !readsAbove(asked) &&
          this.#holders(predicate, asked) !== undefined
        );
      }
      default:
        return false;
    }
  }

  /** Whether a predicate names one row by its whole key. */
  #namesOneRow(model: AnyModel, predicate: PreparedPredicate): boolean {
    const named = new Set<string>();
    const collect = (node: PreparedPredicate) => {
      if (node.kind === "and") node.predicates.forEach(collect);
      else if (
        node.kind === "operation" &&
        node.operator === "equals" &&
        node.target.kind === "column" &&
        node.target.scalar.model === model
      )
        named.add(node.target.scalar.field);
    };
    collect(predicate);
    return this.#queries.keyOrder(model).every((key) => named.has(key));
  }

  /** A filter's conditions: one that names a row follows its links from that row. */
  located(
    model: AnyModel,
    predicate: PreparedPredicate,
    named = this.#namesOneRow(model, predicate)
  ): Sql[] {
    return named
      ? this.judgingAll(() => this.conjuncts(predicate))
      : this.conjuncts(predicate);
  }

  /** What an operation compares with, where the call states it. */
  #statedValue(arm: PreparedPredicate): unknown {
    if (arm.kind !== "operation") return undefined;
    const { operand } = arm;
    if (operand === undefined) return arm.value;
    if (operand.kind === "value") return operand.value;
    if (operand.kind === "parameter")
      return this.#queries.callValue(operand.parameter);
    return undefined;
  }

  /**
   * The record a filter names by its whole key, and what else it asks of that row.
   * A statement over the record itself costs about half one that filters the table
   * on `id`, though both fetch the one record.
   */
  namedRecord(
    model: AnyModel,
    predicate: PreparedPredicate
  ):
    | { readonly record: Sql; readonly rest: PreparedPredicate | undefined }
    | undefined {
    const q = this.#queries;
    const keys = q.keyOrder(model);
    const flat = (node: PreparedPredicate): PreparedPredicate[] =>
      node.kind === "and" ? node.predicates.flatMap(flat) : [node];
    const named = new Map<string, unknown>();
    const others: PreparedPredicate[] = [];
    for (const arm of flat(predicate)) {
      const value = this.#statedValue(arm);
      const field =
        arm.kind === "operation" &&
        arm.operator === "equals" &&
        !arm.insensitive &&
        value !== null &&
        value !== undefined &&
        !(value instanceof Sql) &&
        arm.target.kind === "column" &&
        arm.target.path === undefined &&
        arm.target.scalar.model === model
          ? arm.target.scalar.field
          : undefined;
      if (
        field !== undefined &&
        keys.includes(field) &&
        !named.has(field) &&
        !this.#gatedHere(model, field)
      )
        named.set(field, value);
      else others.push(arm);
    }
    if (!keys.every((key) => named.has(key))) return undefined;
    const [only] = keys;
    let record: Sql | undefined;
    if (keys.length > 1)
      record = sql`${this.recordOf(model, Object.fromEntries(named) as Input)}`;
    else if (isSingleKey(q, model, only!))
      record = this.value(model, only!, named.get(only!));
    if (!record) return undefined;
    let rest: PreparedPredicate | undefined;
    if (others.length > 1) rest = { kind: "and", predicates: others };
    else rest = others[0];
    return { record, rest };
  }

  judgingAll<T>(build: () => T): T {
    const outer = this.#judging;
    this.#judging = true;
    try {
      return build();
    } finally {
      this.#judging = outer;
    }
  }

  /** A predicate's conditions, to state beside others, each once ({@link onceEach}). */
  conjuncts(predicate: PreparedPredicate): Sql[] {
    return predicate.kind === "and"
      ? predicate.predicates.flatMap((inner) => this.conjuncts(inner))
      : [this.predicate(predicate, true)];
  }

  /** Whether a relation's link is a record, which a graph read can follow. */
  isLinked(edge: Reference): boolean {
    return this.#linked(edge);
  }

  /**
   * What a row reaches along a to-one link, as a write would leave it. The walk is
   * physical: a cycle through a hidden row is still one.
   */
  walkFrom(edge: Membership, row: Sql): Sql {
    return this.#walk(edge, {} as never, false, row);
  }

  #linked(edge: Reference): boolean {
    if (edge.pairs.length !== 1 || edge.discriminator) return false;
    const q = this.#queries;
    const { source, target } = edge.pairs[0]!;
    return edge.owner === "source"
      ? isSingleKey(q, edge.target, target) &&
          !q.keyOrder(edge.source).includes(source)
      : isSingleKey(q, edge.source, source) &&
          !q.keyOrder(edge.target).includes(target);
  }

  /** Whether a private carrier column holds keys as text: its arms' keys differ. */
  #carriesText(model: AnyModel, field: string): boolean {
    const { scalar } = this.#queries.schema.physicalField(model, field);
    return scalar["~"].state.type === "string";
  }

  #carried(model: AnyModel, field: string, key: Sql): Sql {
    return this.#carriesText(model, field) ? sql`<string>${key}` : key;
  }

  /**
   * A relation by its fields alone, from a row that is `$parent` here. A variant
   * relation's id column holds the key as text, whichever model it names.
   */
  #correlated(edge: Reference, row: string): Sql {
    const q = this.#queries;
    const pairs = edge.pairs.map(({ source, target }) => {
      const parent = sql`${sql.raw(row)}.${this.physical(edge.source, source)}`;
      const column = this.physical(edge.target, target);
      if (
        isSingleKey(q, edge.target, target) &&
        !this.holdsRecord(edge.source, source)
      )
        return sql`id = type::record(${tableOf(edge.target)}, ${keyCast(edge.target, target, parent)})`;
      if (
        isSingleKey(q, edge.source, source) &&
        !this.holdsRecord(edge.target, target)
      ) {
        const key = sql`record::id(${parent})`;
        return sql`${column} = ${edge.discriminator ? this.#carried(edge.target, target, key) : key}`;
      }
      return sql`${column} = ${parent}`;
    });
    const { discriminator } = edge;
    if (discriminator) {
      const owner = discriminator.side === "source" ? edge.source : edge.target;
      const column = this.physical(owner, discriminator.field);
      pairs.push(
        discriminator.side === "source"
          ? sql`${sql.raw(row)}.${column} = ${discriminator.value}`
          : sql`${column} = ${discriminator.value}`
      );
    }
    return sql.join(pairs, " AND ");
  }

  /** The rows an aggregate reads: the filtered table, or its page. */
  #rows(model: AnyModel, args: Arguments, within?: Sql): Sql {
    const { from, rest } = this.#driven(model, this.#filter(model, args));
    if (within)
      return sql`${from} WHERE ${sql.join(
        [...(rest ? [this.predicate(rest, true)] : []), within],
        " AND "
      )}`;
    const paged =
      args.take !== undefined ||
      args.skip !== undefined ||
      args.cursor !== undefined;
    if (paged) {
      const { extras, clauses } = this.#clauses(model, args, rest);
      return sql`(SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${from} ${sql.join(clauses, " ")})`;
    }
    return rest ? sql`${from} WHERE ${this.predicate(rest, true)}` : from;
  }

  /**
   * `aggregate` and `groupBy`: flat aggregates inside, the public shape outside,
   * where a `having` and an order read them by name. `math::sum` of nothing is 0,
   * and SQL's is NULL, so each aggregate carries how many values it saw.
   */
  #aggregation(model: AnyModel, args: Arguments, by: readonly string[]): Query {
    const extremes = this.#extremes(model, args, by);
    if (extremes) return extremes;
    const inner = new Map<string, Sql>();
    const flat = (alias: string, expression: Sql) => {
      inner.set(alias, sql`${expression} AS ${name(alias)}`);
      return name(alias);
    };
    // A field that is always there has as many values as rows.
    const seen = (field: string) =>
      model["~"].state.scalars[field]?.["~"].state.nullable ||
      this.#gatedHere(model, field)
        ? flat(
            `__n_${field}`,
            sql`count(${this.#operand(model, field)} != NONE)`
          )
        : flat("__count__all", sql`count()`);
    const of = (aggregate: string, field: string) => {
      if (aggregate === "_count" && field === "_all")
        return flat("__count__all", sql`count()`);
      const column = this.#operand(model, field);
      if (aggregate === "_count")
        return flat(`__count_${field}`, sql`count(${column} != NONE)`);
      const value = sql`${sql.raw(AGGREGATE_FUNCTIONS[aggregate]!)}(${column})`;
      return flat(
        `_${aggregate}_${field}`,
        aggregate === "_avg"
          ? quantized(model["~"].state.scalars[field]?.["~"].state, value)
          : value
      );
    };
    const fields: Record<string, unknown> = {};
    const outer: Sql[] = [];
    for (const field of by) {
      const column = flat(field, this.#operand(model, field));
      outer.push(sql`(${column} ?? NULL) AS ${name(field)}`);
      fields[field] = this.#gatedHere(model, field)
        ? { ...(this.#leaf(model, field) as object), nullable: true }
        : this.#leaf(model, field);
    }
    for (const aggregate of AGGREGATE_NAMES) {
      const selection = args[aggregate as keyof Arguments];
      if (!selection) continue;
      if (aggregate === "_count" && selection === true) {
        outer.push(sql`${of("_count", "_all")} AS _count`);
        fields._count = COUNT_LEAF;
        continue;
      }
      const selected = Object.entries(selection as Input).filter(
        ([, include]) => include
      );
      if (selected.length === 0) continue;
      const leaves: Record<string, unknown> = {};
      const members = selected.map(([field]) => {
        leaves[field] = this.#aggregateLeaf(model, aggregate, field);
        const value = of(aggregate, field);
        return aggregate === "_count"
          ? sql`${name(field)}: ${value}`
          : sql`${name(field)}: (IF ${seen(field)} = 0 { NULL } ELSE { ${value} })`;
      });
      outer.push(sql`{ ${sql.join(members, ", ")} } AS ${name(aggregate)}`);
      fields[aggregate] = { kind: "object", fields: leaves };
    }
    const having = args.having
      ? this.#having(model, args.having as Input, of, seen, true)
      : undefined;
    const { order, flags } = this.#groupOrder(
      model,
      args.orderBy,
      of,
      seen,
      by
    );
    if (by.length === 0 && inner.size === 0) flat("__count__all", sql`count()`);
    const grouping = by.length
      ? sql`GROUP BY ${sql.join(
          by.map((field) => name(field)),
          ", "
        )}`
      : sql.raw("GROUP ALL");
    const clauses = [
      ...(having ? [sql`WHERE ${having}`] : []),
      ...(order.length ? [sql`ORDER BY ${sql.join(order, ", ")}`] : []),
      ...(by.length && args.take !== undefined
        ? [sql.raw(`LIMIT ${Number(args.take)}`)]
        : []),
      ...(by.length && args.skip !== undefined
        ? [sql.raw(`START ${Number(args.skip)}`)]
        : []),
    ];
    const rows = by.length
      ? this.#rows(
          model,
          {
            ...args,
            take: undefined,
            skip: undefined,
            cursor: undefined,
          },
          this.#firstGroups(model, args, by)
        )
      : this.#rows(model, args);
    return {
      sql: sql.join(
        [
          sql`SELECT ${sql.join(outer.length || flags.length ? [...outer, ...flags] : [sql.raw("true AS __row")], ", ")} FROM (SELECT ${sql.join([...inner.values()], ", ")} FROM ${rows} ${grouping})`,
          ...clauses,
        ],
        " "
      ),
      shape: { kind: "object", fields } as Query["shape"],
    };
  }

  /**
   * A `groupBy` reads every row before it can take any group, so a page of few groups
   * first seeks them on the index of the field it orders by, one value after the last,
   * each a statement of its own as a closure's variable never seeks, and reads only
   * their rows. Only a filter of its own columns goes along: each seek
   * states it again.
   */
  #firstGroups(
    model: AnyModel,
    args: Arguments,
    by: readonly string[]
  ): Sql | undefined {
    const groups = Number(args.take ?? 0) + Number(args.skip ?? 0);
    const orders = args.orderBy ? [args.orderBy as Input].flat() : [];
    const [field, spec] = Object.entries((orders[0] ?? {}) as Input)[0] ?? [
      by[0],
      "asc",
    ];
    if (
      !this.#lets ||
      Number(args.take ?? 0) <= 0 ||
      groups > GROUPS_SOUGHT ||
      args.having ||
      !by.includes(field as string) ||
      (spec !== "asc" && spec !== "desc") ||
      model["~"].state.scalars[field as string]?.["~"].state.nullable ||
      this.#gatedHere(model, field as string) ||
      !this.#indexed(model, field as string)
    )
      return undefined;
    const filter = this.#filter(model, args);
    const where = filter ? [this.predicate(filter, true)] : [];
    if (where.some((part) => HOLDS_SUBQUERY.test(part.toStatement())))
      return undefined;
    const column = this.physical(model, field as string);
    const direction = sql.raw(spec === "desc" ? "DESC" : "ASC");
    const beyond = sql.raw(spec === "desc" ? "<" : ">");
    const seek = (past: readonly Sql[]) => {
      const conditions = [...where, ...past];
      return sql`(SELECT VALUE ${column} FROM ${name(tableOf(model))}${conditions.length ? sql` WHERE ${sql.join(conditions, " AND ")}` : sql.raw("")} ORDER BY ${column} ${direction} LIMIT 1)[0]`;
    };
    // Past the last group a seek finds nothing, and the next finds a group again:
    // one already listed, which changes nothing.
    const found: Sql[] = [];
    for (let at = 0; at < groups; at++) {
      const last = found.at(-1);
      const next = this.#hoist(
        seek(last ? [sql`${column} ${beyond} ${last}`] : [])
      );
      if (!next) return undefined;
      found.push(next);
    }
    return sql`${column} IN [${sql.join(found, ", ")}]`;
  }

  /** Whether an index holds the field: one declared, or a foreign key's. */
  #indexed(model: AnyModel, field: string): boolean {
    const { indexes, relations } = model["~"].state;
    return (
      indexes.some((index) =>
        (index.fields as readonly string[]).includes(field)
      ) ||
      Object.values(
        relations as Record<
          string,
          { "~": { state: { foreignKey?: { fields: readonly string[] } } } }
        >
      ).some((relation) =>
        relation["~"].state.foreignKey?.fields.includes(field)
      )
    );
  }

  /**
   * `_min` and `_max` alone, over every row a filter leaves: each is the one row an
   * index finds walking no further, where an aggregate reads them all.
   */
  #extremes(
    model: AnyModel,
    args: Arguments,
    by: readonly string[]
  ): Query | undefined {
    const selected = (["_min", "_max"] as const).flatMap((aggregate) => {
      const fields = Object.entries((args[aggregate] ?? {}) as Input)
        .filter(([, include]) => include)
        .map(([field]) => field);
      return fields.length > 0 ? [{ aggregate, fields }] : [];
    });
    const physical = selected.every(({ fields }) =>
      fields.every(
        (field) =>
          !this.#gatedHere(model, field) &&
          this.#operand(model, field).toStatement() ===
            this.physical(model, field).toStatement()
      )
    );
    if (
      selected.length === 0 ||
      !physical ||
      by.length > 0 ||
      args.take !== undefined ||
      args.skip !== undefined ||
      args.cursor !== undefined ||
      args.having ||
      args._count ||
      args._avg ||
      args._sum
    )
      return undefined;
    const { from, rest } = this.#driven(model, this.#filter(model, args));
    const filter = rest ? [this.predicate(rest, true)] : [];
    const fields: Record<string, unknown> = {};
    const members = selected.map(({ aggregate, fields: chosen }) => {
      const leaves: Record<string, unknown> = {};
      const values = chosen.map((field) => {
        leaves[field] = this.#aggregateLeaf(model, aggregate, field);
        const column = this.physical(model, field);
        const where = model["~"].state.scalars[field]?.["~"].state.nullable
          ? [...filter, sql`${column} != NONE`]
          : filter;
        return sql`${name(field)}: ((SELECT VALUE ${column} FROM ${from}${where.length ? sql` WHERE ${sql.join(where, " AND ")}` : sql.raw("")} ORDER BY ${column} ${sql.raw(aggregate === "_max" ? "DESC" : "ASC")} LIMIT 1)[0] ?? NULL)`;
      });
      fields[aggregate] = { kind: "object", fields: leaves };
      return sql`${name(aggregate)}: { ${sql.join(values, ", ")} }`;
    });
    return {
      sql: sql`RETURN [{ ${sql.join(members, ", ")} }]`,
      shape: { kind: "object", fields } as Query["shape"],
    };
  }

  #leaf(model: AnyModel, field: string): unknown {
    return (
      this.#queries.prepareProjection(
        model,
        { select: { [field]: true } },
        true
      ).shape as { fields: Record<string, unknown> }
    ).fields[field];
  }

  #aggregateLeaf(model: AnyModel, aggregate: string, field: string): unknown {
    if (aggregate === "_count") return COUNT_LEAF;
    const leaf = this.#leaf(model, field) as { type: string };
    if (aggregate === "_avg" && leaf.type !== "decimal")
      return { kind: "scalar", type: "number", nullable: true };
    return {
      ...leaf,
      nullable: true,
      // A decimal's sum may pass the field's precision; the others read as they are.
      widened:
        aggregate === "_sum" && leaf.type === "decimal" ? true : undefined,
    };
  }

  /**
   * `positive` carries a negation down to each comparison, as a filter's does: an
   * aggregate of no values is NULL, whose comparison holds neither way.
   */
  #having(
    model: AnyModel,
    having: Input,
    of: (aggregate: string, field: string) => Sql,
    seen: (field: string) => Sql,
    positive: boolean
  ): Sql {
    const clauses: Sql[] = [];
    const all = positive ? " AND " : " OR ";
    const any = positive ? " OR " : " AND ";
    for (const [key, value] of Object.entries(having)) {
      if (value === undefined) continue;
      if (key === "AND" || key === "OR" || key === "NOT") {
        const arms = [value]
          .flat()
          .map((arm) =>
            this.#having(
              model,
              arm as Input,
              of,
              seen,
              positive === (key !== "NOT")
            )
          );
        if (arms.length === 0) {
          // An empty OR holds of nothing; an empty AND or NOT asks nothing.
          if (key === "OR") clauses.push(sql.raw(positive ? "false" : "true"));
          continue;
        }
        clauses.push(sql`(${sql.join(arms, key === "OR" ? any : all)})`);
        continue;
      }
      const filter = value as Input;
      const aggregated = AGGREGATE_NAMES.filter(
        (aggregate) => filter[aggregate] !== undefined
      );
      if (aggregated.length === 0) {
        clauses.push(
          this.predicate(
            this.#queries.prepareSelector(model, { [key]: value }).predicate!,
            positive
          )
        );
        continue;
      }
      for (const aggregate of aggregated) {
        const counted = aggregate === "_count";
        clauses.push(
          this.#compare(
            model,
            key,
            counted,
            of(aggregate, key),
            filter[aggregate] as Input,
            positive,
            counted ? undefined : seen(key)
          )
        );
      }
    }
    return clauses.length
      ? sql`(${sql.join(clauses, all)})`
      : sql.raw(positive ? "true" : "false");
  }

  /** `seen`, where one is given, counts the values: none is an aggregate's NULL. */
  #compare(
    model: AnyModel,
    field: string,
    counted: boolean,
    expression: Sql,
    filter: Input,
    positive: boolean,
    seen?: Sql
  ): Sql {
    const bind = (value: unknown) =>
      counted ? sql`${value}` : this.value(model, field, value);
    const given = Object.entries(filter).filter(
      ([, operand]) => operand !== undefined
    );
    if (given.length === 0) return sql.raw(positive ? "true" : "false");
    const known = (test: Sql) => {
      const asked = positive ? test : sql`!(${test})`;
      return seen ? sql`(${seen} > 0 AND ${asked})` : asked;
    };
    const tests = given.map(([operator, operand]) => {
      const nested = (inner: Input, sign: boolean) =>
        this.#compare(model, field, counted, expression, inner, sign, seen);
      if (operator === "not") return nested({ equals: operand }, !positive);
      if (operator === "equals" && operand === null) {
        if (!seen) return sql.raw(positive ? "false" : "true");
        return sql`${seen} ${sql.raw(positive ? "=" : ">")} 0`;
      }
      if (COMPARISONS[operator])
        return known(
          sql`${expression} ${sql.raw(COMPARISONS[operator])} ${bind(operand)}`
        );
      if (operator === "in" || operator === "notIn") {
        const members = operand as unknown[];
        // An empty list asks nothing of the group, so a missing value does not matter.
        if (members.length === 0)
          return sql.raw(
            (operator === "notIn") === positive ? "true" : "false"
          );
        return known(
          sql`${expression} ${sql.raw(operator === "in" ? "IN" : "NOT IN")} [${sql.join(members.map(bind), ", ")}]`
        );
      }
      return refuse(`the '${operator}' operator in a having`);
    });
    return sql`(${sql.join(tests, positive ? " AND " : " OR ")})`;
  }

  /** A group's order, with a flag for what is NULL: as PostgreSQL, the largest. */
  #groupOrder(
    model: AnyModel,
    input: unknown,
    of: (aggregate: string, field: string) => Sql,
    seen: (field: string) => Sql,
    by: readonly string[]
  ): { readonly order: Sql[]; readonly flags: Sql[] } {
    const order: Sql[] = [];
    const flags: Sql[] = [];
    const nullable = (field: string) =>
      model["~"].state.scalars[field]?.["~"].state.nullable === true ||
      this.#gatedHere(model, field);
    const term = (
      value: Sql,
      missing: Sql | undefined,
      sort: unknown,
      nulls?: unknown
    ) => {
      if (missing) {
        const flag = name(`__m${flags.length}`);
        flags.push(sql`(${missing}) AS ${flag}`);
        const first =
          (nulls ?? (sort === "desc" ? "first" : "last")) === "first";
        order.push(sql`${flag} ${sql.raw(first ? "DESC" : "ASC")}`);
      }
      order.push(sql`${value} ${sql.raw(sort === "desc" ? "DESC" : "ASC")}`);
    };
    for (const entry of input === undefined ? [] : [input].flat()) {
      for (const [key, spec] of Object.entries(entry as Input)) {
        if (spec === undefined) continue;
        if (AGGREGATE_NAMES.includes(key)) {
          for (const [field, direction] of Object.entries(spec as Input))
            term(
              of(key, field),
              key !== "_count" && field !== "_all" && nullable(field)
                ? sql`${seen(field)} = 0`
                : undefined,
              direction
            );
          continue;
        }
        const { sort, nulls } = (
          typeof spec === "string" ? { sort: spec } : spec
        ) as Input;
        term(
          name(key),
          nullable(key) ? sql`${name(key)} = NONE` : undefined,
          sort,
          nulls
        );
      }
    }
    if (order.length === 0)
      for (const field of by)
        term(
          name(field),
          nullable(field) ? sql`${name(field)} = NONE` : undefined,
          "asc"
        );
    return { order, flags };
  }

  /** The key order, as a mutation limit reads it. */
  order(model: AnyModel, input: Arguments["orderBy"]): Sql {
    return sql.join(
      this.#orderTerms(model, input).map(
        (term) =>
          sql`${term.expression} ${sql.raw(term.descending ? "DESC" : "ASC")}`
      ),
      ", "
    );
  }

  #filter(model: AnyModel, args: Arguments): PreparedPredicate | undefined {
    const q = this.#queries;
    return q.scoped(
      model,
      args.where === undefined
        ? undefined
        : q.prepareSelector(model, args.where).predicate,
      "root"
    );
  }

  statement(
    model: AnyModel,
    prepared: PreparedProjection,
    args: Partial<Arguments> & {
      readonly unordered?: boolean;
      /** The order an index may serve: {@link approximateOrder}. */
      readonly nearest?: ReturnType<typeof approximateOrder>;
    },
    predicate: PreparedPredicate | undefined,
    conditions: readonly Sql[] = [],
    path?: Sql
  ): Sql {
    if (path || args.distinct?.length)
      return this.#page(
        model,
        prepared,
        args,
        path ?? name(tableOf(model)),
        predicate,
        conditions
      );
    const { from, rest, ahead, named } = this.#driven(
      model,
      predicate,
      args.take !== undefined
    );
    const listed = this.#page(
      model,
      prepared,
      named ? { ...args, named, unordered: true } : args,
      from,
      rest,
      conditions
    );
    if (!ahead)
      return this.#nearest(
        model,
        prepared,
        args,
        from,
        rest,
        conditions,
        listed
      );
    // The list is complete or it is not, and only a read can tell. What the walk
    // computes for itself waits in its own branch, where it may never run.
    const lets = this.#lets;
    const own: Sql[] = [];
    this.#lets = own;
    this.#walking = ahead.arm;
    // Too many hold for a list: the page reads in order, following each row's links.
    const walked = this.judgingAll(() =>
      this.#page(
        model,
        prepared,
        args,
        name(tableOf(model)),
        predicate,
        conditions
      )
    );
    this.#walking = undefined;
    this.#lets = lets;
    return sql`IF array::len(${ahead.rows}) < ${sql.raw(String(HOLDERS_AHEAD))} { ${listed} } ELSE { ${sql.join([...own, walked], " ")} }`;
  }

  /**
   * A page an HNSW index may answer: its nearest `k` among the rows the filter
   * keeps, in the exact order. `<|k,ef|>` reads an HNSW index on the field, and
   * the first one when there are several, whatever its distance: so only a
   * table's one declared index of this distance, on a field no gate masks,
   * read from the table itself (a named record or a list of ids holds no
   * index: it answers nothing). With no such index built, it answers nothing,
   * so then — or with nothing left beside it — the exact page answers.
   */
  #nearest(
    model: AnyModel,
    prepared: PreparedProjection,
    args: Parameters<SurrealReadBackend["statement"]>[2],
    from: Sql,
    rest: PreparedPredicate | undefined,
    conditions: readonly Sql[],
    exact: Sql
  ): Sql {
    const nearest = args.nearest;
    if (
      !nearest ||
      from.toStatement() !== name(tableOf(model)).toStatement() ||
      this.#gatedHere(model, nearest.field)
    )
      return exact;
    const to = nearest.distance.to as number[];
    const indexes = nearestIndexesOf(model).filter(
      (index) => index.field === nearest.field
    );
    const index = indexes.length === 1 ? indexes[0] : undefined;
    if (
      !index ||
      index.distance !== DISTANCES[nearest.distance.metric as string] ||
      (index.dimension !== undefined && index.dimension !== to.length)
    )
      return exact;
    const searched = sql`${this.physical(model, nearest.field)} ${sql.raw(
      `<|${nearest.take},${Math.max(EF_SEARCH, nearest.take)}|>`
    )} ${to}`;
    const found = this.#hoist(
      this.#page(model, prepared, args, from, rest, [...conditions, searched])
    );
    return found
      ? sql`IF array::len(${found}) > 0 { ${found} } ELSE { ${exact} }`
      : exact;
  }

  /** One page of rows, from wherever a statement reads them. */
  #page(
    model: AnyModel,
    prepared: PreparedProjection,
    args: Partial<Arguments> & {
      readonly named?: boolean;
      readonly unordered?: boolean;
    },
    from: Sql,
    rest: PreparedPredicate | undefined,
    conditions: readonly Sql[]
  ): Sql {
    this.#cursorGuard = undefined;
    this.#guardsCursor = true;
    const fromTable =
      this.#inRelation === 0 &&
      !this.#walking &&
      (args.named === true ||
        from.toStatement() === name(tableOf(model)).toStatement());
    const { extras, clauses } = this.#clauses(
      model,
      { ...args, fromTable },
      rest,
      conditions
    );
    this.#guardsCursor = false;
    let count = Number(args.take ?? 0);
    if (count <= 0)
      count = Number(
        args.named === true ||
          (rest !== undefined && this.#namesOneRow(model, rest))
      );
    const statedOnce = sql.join(clauses, " ");
    this.#parents =
      fromTable &&
      args.cursor === undefined &&
      !args.distinct &&
      extras.length === 0 &&
      count > 0 &&
      count <= PARENTS_READ_APART &&
      !HOLDS_SUBQUERY.test(statedOnce.toStatement())
        ? { read: sql`(SELECT VALUE id FROM ${from} ${statedOnce})`, count }
        : undefined;
    const guard = this.#cursorGuard as Sql | undefined;
    const guarded = (body: Sql) =>
      guard ? sql`IF ${guard} { ${body} } ELSE { [] }` : body;
    // An alias that names another column would answer an `ORDER BY` of it, so
    // the rows are chosen under their own names and named after.
    const columns = this.#queries.schema.storedFields(model);
    const shadowed = prepared.fields.some((field) =>
      columns.some(
        (other) =>
          other !== field.name &&
          this.#queries.columnName(model, other) === field.name
      )
    );
    const stated = this.columns(prepared);
    this.#parents = undefined;
    if (shadowed)
      return guarded(
        sql`SELECT ${stated} FROM (${sql.join(
          [
            sql`SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${from}`,
            ...clauses,
          ],
          " "
        )})`
      );
    return guarded(
      sql.join(
        [
          sql`SELECT ${sql.join([stated, ...extras], ", ")} FROM ${from}`,
          ...clauses,
        ],
        " "
      )
    );
  }

  /**
   * A correlated read never walks an index in order: `<~` reads every reference and
   * sorts them, whatever the page takes, where a read of a statement's own variable
   * seeks. So a page of few rows reads ahead which they are, and each one's children
   * in a read of its own. Each read is stated once per row, which only a filter
   * without a subquery of its own, or a row above it, can afford.
   */
  #pagesOfParents(
    edge: Reference,
    predicate: PreparedPredicate | undefined,
    args: Relation["arguments"]
  ): Sql | undefined {
    const parents = this.#parents;
    if (
      !parents ||
      this.#inRelation !== 1 ||
      !this.#linked(edge) ||
      Number(args.take ?? 0) <= 0 ||
      args.cursor !== undefined ||
      args.distinct
    )
      return undefined;
    parents.ids ??= this.#hoist(parents.read);
    if (!parents.ids) return undefined;
    const { target } = edge;
    const link = name(this.#queries.columnName(target, edge.pairs[0]!.target));
    const pages: Sql[] = [];
    for (let at = 0; at < parents.count; at++) {
      const { extras, clauses } = this.#clauses(
        target,
        { ...args, fromTable: true },
        predicate,
        [sql`${link} = ${parents.ids}[${sql.raw(String(at))}]`]
      );
      const page = sql`(SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${name(tableOf(target))} ${sql.join(clauses, " ")})`;
      if (
        at === 0 &&
        (HOLDS_SUBQUERY.test(sql.join(clauses, " ").toStatement()) ||
          READS_A_ROW_ABOVE.test(sql.join(clauses, " ").toStatement()))
      )
        return undefined;
      pages.push(page);
    }
    const read = this.#hoist(sql`[${sql.join(pages, ", ")}]`);
    return read && sql`${read}[array::find_index(${parents.ids}, $this.id)]`;
  }

  /** The row `identity` names, every key field equal. */
  identity(model: AnyModel, identity: Input): Sql {
    const keys = this.#queries.keyOrder(model);
    const named = Object.keys(identity);
    if (keys.length > 1 && keys.every((key) => named.includes(key)))
      return sql`id = ${this.recordOf(model, identity)}`;
    return sql.join(
      Object.entries(identity).map(
        ([field, value]) =>
          sql`${this.physical(model, field)} = ${this.value(model, field, value)}`
      ),
      " AND "
    );
  }

  /** The record a row's key fields name, however many there are. */
  recordOfRow(model: AnyModel, row: Input): Sql {
    const keys = this.#queries.keyOrder(model);
    return keys.length === 1
      ? this.value(model, keys[0]!, row[keys[0]!])
      : sql`${this.recordOf(model, row)}`;
  }

  /** A compound key's record. */
  recordOf(model: AnyModel, row: Input): RecordId {
    return new RecordId(
      tableOf(model),
      this.#queries
        .keyOrder(model)
        .map((key) => this.#part(model, key, row[key])) as never
    );
  }

  /** One stated part of an array id, as a value. */
  keyPart(model: AnyModel, field: string, value: unknown): Sql {
    return sql`${this.#part(model, field, value)}`;
  }

  /** One part of an array id: a link stays a record, as its field holds it. */
  #part(model: AnyModel, field: string, value: unknown): unknown {
    for (const slot of Object.keys(model["~"].state.relations)) {
      const { edges } = this.#queries.countedMemberships(model, slot);
      const edge = edges[0];
      if (
        edges.length === 1 &&
        edge?.kind === "reference" &&
        edge.owner === "source" &&
        edge.pairs.length === 1 &&
        edge.pairs[0]!.source === field &&
        isSingleKey(this.#queries, edge.target, edge.pairs[0]!.target)
      )
        return new RecordId(tableOf(edge.target), value as string);
    }
    return stored(model["~"].state.scalars[field]?.["~"].state, value);
  }

  /** The target rows of `edge` for this parent, or those outside them. */
  member(edge: Membership, parent: Input, outside = false): Sql {
    if (edge.kind === "junction") {
      const list = edge.declared
        ? this.#declaredOf(edge, parent)
        : this.membersOf(edge, parent);
      return sql`id ${sql.raw(outside ? "NOT IN" : "IN")} ${list}`;
    }
    const reached = reference(edge);
    const held = reached.pairs.map(({ source }) => parent[source]);
    const { discriminator } = reached;
    if (
      held.some((value) => value === null || value === undefined) ||
      (discriminator?.side === "source" &&
        parent[discriminator.field] !== discriminator.value)
    )
      return sql.raw(outside ? "true" : "false");
    const test = sql.join(
      [
        ...reached.pairs.map(
          ({ target }, index) =>
            sql`${this.physical(reached.target, target)} = ${this.value(reached.target, target, held[index])}`
        ),
        ...(discriminator?.side === "target"
          ? [
              sql`${this.physical(reached.target, discriminator.field)} = ${discriminator.value}`,
            ]
          : []),
      ],
      " AND "
    );
    return outside ? sql`!(${test})` : test;
  }

  /**
   * A generated junction as an edge table. `in` is its canonical first side, so
   * the direction does not depend on which model declared the relation, and a
   * self relation tells its two directions apart by it.
   */
  edgeOf(edge: Junction) {
    const resolved = edge.scope.edge;
    if (edge.declared) refuse("a declared junction as an edge");
    const topology =
      resolved.kind === "junction"
        ? resolved.topology
        : resolved.kind === "variantJunctionCarrier"
          ? (edge.scope.member as VariantJunctionMember).topology
          : refuse("this junction");
    for (const side of [edge.sourceSide, edge.targetSide]) {
      const keys = this.#queries.keyOrder(side.model);
      if (
        side.members.length !== keys.length ||
        !side.members.every((pair) => keys.includes(pair.referencedField))
      )
        refuse("a junction over anything but a record's own key");
    }
    const first = topology.sourceIsFirst ? topology.source : topology.target;
    const outward = edge.sourceSide === first;
    const arrow = outward ? "->" : "<-";
    return {
      table: name(edge.table),
      near: name(outward ? "in" : "out"),
      far: name(outward ? "out" : "in"),
      hop: sql.raw(`${arrow}${name(edge.table).toStatement()}${arrow}`),
      back: sql.raw(
        `${outward ? "<-" : "->"}${name(edge.table).toStatement()}${outward ? "<-" : "->"}`
      ),
      out: sql.raw(`${arrow}${name(edge.table).toStatement()}`),
    };
  }

  /** The field of a declared junction's model that holds this column. */
  #linkField(edge: Junction, column: string): string {
    const model = edge.declared!.model;
    const field = this.#queries.schema
      .storedFields(model)
      .find((name) => this.#queries.columnName(model, name) === column);
    return field ?? refuse(`the link column '${column}'`);
  }

  /** Whether a field reads as a record: a key, or a link to one. */
  #isRecord(model: AnyModel, field: string): boolean {
    return (
      isSingleKey(this.#queries, model, field) || this.holdsRecord(model, field)
    );
  }

  /** Whether a model's field holds a record rather than the key's own value. */
  holdsRecord(model: AnyModel, field: string): boolean {
    const q = this.#queries;
    return Object.keys(model["~"].state.relations).some((slot) => {
      const { edges } = q.countedMemberships(model, slot);
      const edge = edges[0];
      return (
        edges.length === 1 &&
        edge?.kind === "reference" &&
        edge.owner === "source" &&
        edge.pairs.length === 1 &&
        edge.pairs[0]!.source === field &&
        isSingleKey(q, edge.target, edge.pairs[0]!.target)
      );
    });
  }

  /** This link's columns against the row a variable holds, one side of it. */
  #linkMatch(edge: Junction, side: Junction["sourceSide"], row: string): Sql[] {
    const link = edge.declared!.model;
    return side.members.map((pair) => {
      const field = this.#linkField(edge, pair.junctionField);
      const held = sql`${sql.raw(row)}.${this.physical(side.model, pair.referencedField)}`;
      const plainKey =
        isSingleKey(this.#queries, side.model, pair.referencedField) &&
        !this.holdsRecord(link, field);
      return sql`${this.physical(link, field)} = ${plainKey ? sql`record::id(${held})` : held}`;
    });
  }

  /** The record of a side, read from a link row a variable or the row itself holds. */
  linkTarget(edge: Junction, side: Junction["sourceSide"], row: string): Sql {
    const link = edge.declared!.model;
    const keys = this.#queries.keyOrder(side.model);
    // A link over fields other than the key names its record by looking it up.
    if (
      !keys.every((key) => side.members.some((m) => m.referencedField === key))
    ) {
      const named = side.members.map((pair) => {
        const column = this.physical(
          link,
          this.#linkField(edge, pair.junctionField)
        );
        return sql`${this.physical(side.model, pair.referencedField)} = ${sql.raw(row || "$parent")}.${column}`;
      });
      return sql`(SELECT VALUE id FROM ${name(tableOf(side.model))} WHERE ${sql.join(named, " AND ")} LIMIT 1)[0]`;
    }
    const parts = keys.map((key) => {
      const pair = side.members.find(
        (member) => member.referencedField === key
      )!;
      const field = this.#linkField(edge, pair.junctionField);
      const column = this.physical(link, field);
      return {
        read: row ? sql`${sql.raw(row)}.${column}` : column,
        record: this.holdsRecord(link, field),
      };
    });
    if (parts.length === 1 && parts[0]!.record) return parts[0]!.read;
    const key =
      parts.length === 1
        ? parts[0]!.read
        : sql`[${sql.join(
            parts.map((part) => part.read),
            ", "
          )}]`;
    return sql`type::record(${tableOf(side.model)}, ${key})`;
  }

  /** A row's links through a declared junction, narrowed by the link's own filter. */
  #links(edge: Junction, row: string, where?: PreparedPredicate): Sql {
    const conditions = [
      ...this.#linkMatch(edge, edge.sourceSide, row),
      ...(where ? [this.predicate(where, true)] : []),
    ];
    return sql`(SELECT * FROM ${name(tableOf(edge.declared!.model))} WHERE ${sql.join(conditions, " AND ")})`;
  }

  /** The record one side of a junction holds, however its key is spelled in `read`. */
  end(side: Junction["sourceSide"], read: (pair: Member) => unknown): Sql {
    if (side.members.length === 1) {
      const pair = side.members[0]!;
      return this.value(side.model, pair.referencedField, read(pair));
    }
    const row = Object.fromEntries(
      side.members.map((pair) => [pair.referencedField, read(pair)])
    );
    return sql`${this.recordOf(side.model, row)}`;
  }

  /** The link between two rows, named by each side's junction field. */
  linkRowQuery(edge: Junction, values: Input): Query {
    const link = edge.declared!.model;
    const columns = linkMembers(edge).filter(({ pair }) =>
      Object.hasOwn(values, pair.junctionField)
    );
    const fields: Record<string, unknown> = {};
    const named = linkMembers(edge).map(({ pair }) => {
      const field = this.#linkField(edge, pair.junctionField);
      fields[pair.junctionField] = this.#leaf(link, field);
      return sql`${this.physical(link, field)} AS ${sql.raw(pair.junctionField)}`;
    });
    const where = columns.map(({ pair }) => {
      const field = this.#linkField(edge, pair.junctionField);
      return sql`${this.physical(link, field)} = ${this.value(link, field, values[pair.junctionField])}`;
    });
    return {
      sql: sql`SELECT ${sql.join(named, ", ")} FROM ${name(tableOf(link))} WHERE ${sql.join(where, " AND ")}`,
      shape: { kind: "object", fields } as Query["shape"],
    };
  }

  /** The field of a declared junction's model that a column names, for its writes. */
  linkFieldOf(edge: Junction, column: string): string {
    return this.#linkField(edge, column);
  }

  /** The target records of a declared junction for a parent's known values. */
  #declaredOf(edge: Junction, parent: Input): Sql {
    const link = edge.declared!.model;
    const conditions = edge.sourceSide.members.map((pair) => {
      const field = this.#linkField(edge, pair.junctionField);
      return sql`${this.physical(link, field)} = ${this.value(link, field, parent[pair.referencedField])}`;
    });
    return sql`(SELECT VALUE ${this.linkTarget(edge, edge.targetSide, "")} FROM ${name(tableOf(link))} WHERE ${sql.join(conditions, " AND ")})`;
  }

  /** The path from one record to its members through an edge table. */
  membersOf(edge: Junction, parent: Input): Sql {
    const { hop } = this.edgeOf(edge);
    const start = this.end(
      edge.sourceSide,
      (pair) => parent[pair.referencedField]
    );
    return sql`${start}${hop}${name(tableOf(edge.target))}`;
  }

  #clauses(
    model: AnyModel,
    args: Pick<
      Partial<Arguments>,
      "orderBy" | "take" | "skip" | "cursor" | "distinct"
    > & {
      readonly unordered?: boolean;
      readonly fromTable?: boolean;
      readonly named?: boolean;
    },
    predicate: PreparedPredicate | undefined,
    conditions: readonly Sql[] = []
  ): { readonly extras: Sql[]; readonly clauses: Sql[] } {
    const { terms, forward } = this.#ordering(model, args);
    const { extras, order } = this.#ordered(terms);
    const located = [
      ...(predicate
        ? args.named
          ? this.located(model, predicate, true)
          : this.located(model, predicate)
        : []),
      ...conditions,
    ];
    const cursor =
      args.cursor === undefined
        ? []
        : [this.#cursor(model, args.cursor as Input, terms)];
    const clauses: Sql[] = [];
    const distinct = args.distinct as string[] | undefined;
    if (this.#distinctly(model, distinct)) {
      // Each tuple's row is chosen in the caller's order, whichever way this page reads.
      const chosen = this.#ordered(forward);
      // The cursor is among what a tuple's row is chosen from, as `DISTINCT ON`
      // reads only what its `WHERE` leaves.
      clauses.push(
        sql`WHERE ${this.#distinct(
          model,
          distinct!,
          [...located, ...cursor],
          chosen.order,
          chosen.extras
        )}`
      );
    } else {
      const where = onceEach([...located, ...cursor]);
      const bound = args.fromTable
        ? this.#pageBound(model, args, terms, where)
        : undefined;
      const all = bound ? [...where, bound] : where;
      if (all.length > 0) clauses.push(sql`WHERE ${sql.join(all, " AND ")}`);
    }
    if (!args.unordered) clauses.push(sql`ORDER BY ${sql.join(order, ", ")}`);
    // A bound LIMIT is what a nested read's index needs written, so both inline
    // an integer admission has already checked.
    if (args.take !== undefined)
      clauses.push(sql.raw(`LIMIT ${Math.abs(Number(args.take))}`));
    if (args.skip !== undefined)
      clauses.push(sql.raw(`START ${Number(args.skip)}`));
    return { extras, clauses };
  }

  /**
   * A descending page over an ascending key has an order no index holds, so it sorts
   * every row. The first term's value at the page's last row bounds what it sorts,
   * and an index finds that value walking no further than the page. Short of that
   * many rows there is no value, and every row is at least NONE.
   */
  #pageBound(
    model: AnyModel,
    args: Pick<Partial<Arguments>, "take" | "skip">,
    terms: readonly OrderTerm[],
    where: readonly Sql[]
  ): Sql | undefined {
    const [first, ...rest] = terms;
    const take = Math.abs(Number(args.take ?? 0));
    if (
      take === 0 ||
      first?.field === undefined ||
      !first.descending ||
      first.nullable ||
      rest.every((term) => term.descending) ||
      !this.#indexed(model, first.field)
    )
      return undefined;
    const filter = where.length
      ? sql`WHERE ${sql.join(where, " AND ")} `
      : sql.raw("");
    // Stating subqueries twice costs more to compile than the sort does to run.
    if (HOLDS_SUBQUERY.test(filter.toStatement())) return undefined;
    const value = this.#hoist(
      sql`(SELECT VALUE ${first.expression} FROM ${name(tableOf(model))} ${filter}ORDER BY ${first.expression} DESC LIMIT 1 START ${sql.raw(String(take + Number(args.skip ?? 0) - 1))})[0]`
    );
    return value && sql`${first.expression} >= ${value}`;
  }

  /** The terms a read walks, and those of the caller's own order. */
  #ordering(
    model: AnyModel,
    args: Pick<Partial<Arguments>, "orderBy" | "take">
  ): { readonly terms: OrderTerm[]; readonly forward: OrderTerm[] } {
    const forward = this.#orderTerms(model, args.orderBy);
    return {
      forward,
      terms:
        (args.take ?? 0) < 0
          ? forward.map((term) => ({
              ...term,
              descending: !term.descending,
              nulls:
                term.nulls &&
                (term.nulls === "first"
                  ? ("last" as const)
                  : ("first" as const)),
            }))
          : forward,
    };
  }

  /** Terms as `ORDER BY` reads them. A missing value sorts by its own flag. */
  #ordered(terms: readonly OrderTerm[]): {
    readonly extras: Sql[];
    readonly order: Sql[];
  } {
    const extras: Sql[] = [];
    const order = terms.flatMap((term, index) => {
      const direction = sql.raw(term.descending ? "DESC" : "ASC");
      let reads = term.expression;
      if (!term.named) {
        reads = name(`__o${index}`);
        extras.push(sql`${term.expression} AS ${reads}`);
      }
      if (!term.nullable) return [sql`${reads} ${direction}`];
      const missing = name(`__m${index}`);
      extras.push(sql`(${term.expression} = NONE) AS ${missing}`);
      return [
        sql`${missing} ${sql.raw(term.nulls === "first" ? "DESC" : "ASC")}`,
        sql`${reads} ${direction}`,
      ];
    });
    return { extras, order };
  }

  /** The first row of each tuple, in this read's own order: `GROUP BY` keeps it. */
  #distinct(
    model: AnyModel,
    fields: readonly string[],
    where: readonly Sql[],
    order: readonly Sql[],
    extras: readonly Sql[]
  ): Sql {
    const table = name(tableOf(model));
    // A gated field groups by its alias: `GROUP BY` takes no expression.
    const columns = fields.map((field, index) =>
      this.#gatedHere(model, field)
        ? {
            read: sql`${this.#operand(model, field)} AS ${sql.raw(`__d${index}`)}`,
            group: sql.raw(`__d${index}`),
          }
        : {
            read: this.physical(model, field),
            group: this.physical(model, field),
          }
    );
    const filter = where.length
      ? sql`WHERE ${sql.join(where, " AND ")} `
      : sql.raw("");
    const ordered = sql`SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${table} ${filter}ORDER BY ${sql.join(order, ", ")}`;
    const tuple = sql.join(
      columns.map(({ read }) => read),
      ", "
    );
    const grouped = sql.join(
      columns.map(({ group }) => group),
      ", "
    );
    return sql`id IN (SELECT VALUE array::first(id) FROM (SELECT ${tuple}, id FROM (${ordered}) GROUP BY ${grouped}))`;
  }

  /** The rows from the cursor's on, in the order this read walks them. */
  #cursor(model: AnyModel, cursor: Input, terms: readonly OrderTerm[]): Sql {
    const table = name(tableOf(model));
    // The anchor is a candidate like any other: a hidden one is a missing one.
    const q = this.#queries;
    const stated = q.scoped(
      model,
      q.prepareSelector(model, cursor, true, false).predicate,
      this.#inRelation > 0 ? "related" : "root"
    )!;
    // A cursor that states its key is the record itself, read without a filter.
    const named = this.namedRecord(model, stated);
    const source = named?.record ?? table;
    const asked = named ? named.rest : stated;
    const located = asked
      ? sql` WHERE ${this.predicate(asked, true)}`
      : sql.raw("");
    const walked = terms.flatMap((term): OrderTerm[] =>
      term.nullable
        ? [
            {
              ...term,
              expression: sql`(${term.expression} = NONE)`,
              descending: term.nulls === "first",
            },
            term,
          ]
        : [term]
    );
    // The anchor's values in one read, ahead of the statement where a statement can:
    // in a `WHERE` it would run for each row the scan passes.
    const read = sql`(SELECT ${sql.join(
      walked.map(
        (term, index) => sql`${term.expression} AS ${sql.raw(`c${index}`)}`
      ),
      ", "
    )} FROM ${source}${located} LIMIT 1)[0]`;
    const anchor = this.#hoist(read) ?? read;
    const found = sql`${anchor} != NONE`;
    // `a >= x AND (a > x OR …)`: the same rows as `a > x OR (a = x AND …)`, which
    // reads two ranges of an index and sorts them, where this walks one in order.
    const after = walked.reduceRight<Sql | undefined>((rest, term, index) => {
      const value = sql`${anchor}.${sql.raw(`c${index}`)}`;
      const reached = sql`${term.expression} ${sql.raw(term.descending ? "<=" : ">=")} ${value}`;
      if (!rest) return reached;
      return sql`${reached} AND (${term.expression} ${sql.raw(term.descending ? "<" : ">")} ${value} OR (${rest}))`;
    }, undefined)!;
    // Beside a bare condition, a seek on the key becomes a scan, so where a whole
    // statement can answer "no such cursor", it answers ahead of its `WHERE`.
    if (this.#guardsCursor && this.#lets) {
      this.#cursorGuard = found;
      return after;
    }
    return sql`(${found} AND ${after})`;
  }

  /** The caller's order, completed by the key: every page has one total order. */
  #orderTerms(model: AnyModel, input: Arguments["orderBy"]): OrderTerm[] {
    const q = this.#queries;
    const terms: OrderTerm[] = [];
    const ordered = new Set<string>();
    const stated = input ?? q.orderOf(model);
    const orders = stated === undefined ? [] : [stated].flat();
    for (const order of orders) {
      for (const [field, spec] of Object.entries(order)) {
        if (spec === undefined) continue;
        if (model["~"].state.relations[field]) {
          terms.push(this.#relationOrder(model, field, spec as Input));
          continue;
        }
        ordered.add(field);
        terms.push(this.#scalarOrder(model, field, spec, ""));
      }
    }
    for (const field of q.keyOrder(model)) {
      if (ordered.has(field)) continue;
      terms.push({
        expression: this.#operand(model, field),
        named: true,
        descending: false,
        nullable: false,
      });
    }
    return terms;
  }

  #scalarOrder(
    model: AnyModel,
    field: string,
    spec: unknown,
    path: string
  ): OrderTerm {
    const state0 = model["~"].state.scalars[field]?.["~"].state;
    const distance = (spec as Input | undefined)?._distance as
      | Input
      | undefined;
    if (distance && state0) {
      if (path) refuse("ordering by a distance through a relation");
      return {
        expression: this.#distance(
          this.#operand(model, field),
          state0,
          field,
          distance,
          "orderBy"
        ),
        named: false,
        descending: distance.sort === "desc",
        nullable: true,
        nulls: "last",
      };
    }
    const { sort, nulls } = (
      typeof spec === "string" ? { sort: spec } : spec
    ) as { sort?: string; nulls?: "first" | "last" };
    if (sort !== "asc" && sort !== "desc")
      refuse(`ordering by '${field}' with this specification`);
    const state = model["~"].state.scalars[field]?.["~"].state;
    if (!state) refuse(`ordering by '${field}'`);
    return {
      expression: this.#gated(
        model,
        field,
        sql.raw(`${path}${this.physical(model, field).toStatement()}`),
        path
      ),
      named: path === "" && !this.#gatedHere(model, field),
      field: path === "" ? field : undefined,
      descending: sort === "desc",
      nullable:
        path !== "" || state.nullable === true || this.#gatedHere(model, field),
      // As PostgreSQL: a missing value counts as the largest.
      nulls: nulls ?? (sort === "desc" ? "first" : "last"),
    };
  }

  #relationOrder(
    model: AnyModel,
    field: string,
    spec: Input,
    path = ""
  ): OrderTerm {
    const { edges } = this.#queries.countedMemberships(model, field);
    const edge = edges[0]!;
    if (spec._count !== undefined) {
      if (path) refuse(`ordering by a count through '${field}'`);
      return {
        expression: sql.join(
          edges.map(
            (member) =>
              sql`array::len(${this.#members(member, this.#queries.scoped(member.target, undefined, "related"))})`
          ),
          " + "
        ),
        named: false,
        descending: spec._count === "desc",
        nullable: false,
      };
    }
    const [nested, inner] = Object.entries(spec)[0]!;
    if (edge.many) refuse(`ordering by the relation '${field}'`);
    const linked = edge.kind === "reference" && this.#linked(edge);
    if (path && !linked)
      refuse(`ordering by the relation '${field}' through another relation`);
    // A link is the row's own field; the other side is a lookup of the records
    // referencing the row the path has reached, which a path's last record leads.
    const prefix =
      linked && edge.owner === "source"
        ? `${path}${this.physical(edge.source, edge.pairs[0]!.source).toStatement()}.`
        : `(${path.slice(0, -1)}${this.#members(edge).toStatement()})[0].`;
    const term = edge.target["~"].state.relations[nested]
      ? this.#relationOrder(edge.target, nested, inner as Input, prefix)
      : this.#scalarOrder(edge.target, nested, inner, prefix);
    if (this.#queries.domainOf(edge.target, "related") === undefined)
      return term;
    return {
      ...term,
      expression: sql`(IF ${this.#related(edge, "some", undefined, path)} { ${term.expression} } ELSE { NONE })`,
      named: false,
      nullable: true,
    };
  }

  /** Every member of a to-many, unfiltered, as a value. */
  #members(edge: Membership, predicate?: PreparedPredicate): Sql {
    if (edge.kind === "junction" && edge.declared) {
      const where = predicate
        ? sql` WHERE id IN $linked AND ${this.predicate(predicate, true)}`
        : sql` WHERE id IN $linked`;
      return sql`({ LET $owner = $this; LET $linked = (SELECT VALUE ${this.linkTarget(edge, edge.targetSide, "")} FROM ${this.#links(edge, "$owner")}); (SELECT VALUE id FROM ${name(tableOf(edge.target))}${where}) })`;
    }
    if (edge.kind === "junction") {
      const { hop } = this.edgeOf(edge);
      const target = name(tableOf(edge.target));
      return predicate
        ? sql`${hop}(${target} WHERE ${this.predicate(predicate, true)})`
        : sql`${hop}${target}`;
    }
    return this.#traversal(reference(edge), predicate, { unordered: true });
  }

  columns(prepared: PreparedProjection): Sql {
    return sql.join(
      prepared.fields.map((field) => this.column(prepared.model, field)),
      ", "
    );
  }

  /** One projected field, as a `SELECT` or a `RETURN` lists it. */
  column(model: AnyModel, field: PreparedProjectionField): Sql {
    const { value, alias } = this.#field(model, field);
    const named = name(alias);
    // A column under its own name needs no alias, which costs a little per row.
    return value.toStatement() === named.toStatement()
      ? value
      : sql`${value} AS ${named}`;
  }

  #destructure(prepared: PreparedProjection): Sql {
    return sql`.{ ${sql.join(
      prepared.fields.map((field) => {
        const { value, alias } = this.#field(prepared.model, field);
        return sql`${name(alias)}: ${value}`;
      }),
      ", "
    )} }`;
  }

  #field(
    model: AnyModel,
    field: PreparedProjectionField
  ): { readonly value: Sql; readonly alias: string } {
    switch (field.kind) {
      case "scalar": {
        const column = this.physical(model, field.name);
        const state = model["~"].state.scalars[field.name]?.["~"].state;
        const nullable = state?.nullable;
        // A point is GeoJSON to the database and a latitude and longitude here.
        if (state?.type === "point" && !state.array) {
          const point = sql`{ latitude: ${column}.coordinates[1], longitude: ${column}.coordinates[0] }`;
          return {
            value: nullable
              ? sql`(IF ${column} != NONE { ${point} } ELSE { NULL })`
              : point,
            alias: field.name,
          };
        }
        // An absent field is NONE, which the client reads as `undefined` under its
        // key, and the driver as null: `?? NULL` would cost each row for nothing.
        return { value: column, alias: field.name };
      }
      case "relation":
        return { value: this.#relation(field), alias: field.name };
      case "gate":
        return {
          value: this.#truth(this.#gateHolds(model, field.gate)),
          alias: field.name,
        };
      case "evidence":
        return { value: this.#evidence(model, field), alias: field.name };
      case "sentinel":
        return { value: sql.raw("true"), alias: field.name };
      case "distance": {
        const state = model["~"].state.scalars[field.field]!["~"].state;
        const distance = this.#distance(
          this.physical(model, field.field),
          state,
          field.field,
          field.specification,
          "select"
        );
        return { value: sql`(${distance} ?? NULL)`, alias: field.name };
      }
      case "variants":
        return {
          value: sql`{ ${sql.join(
            field.arms.map((arm) => {
              const row = this.#relation({
                kind: "relation",
                name: arm.variant,
                ...arm,
              });
              const edge = arm.edge;
              if (field.many || edge.kind !== "reference")
                return sql`${name(arm.variant)}: ${row}`;
              // A claimed arm whose row is gone is an empty document, which
              // the decoder refuses; an unclaimed one is an empty slot.
              const claim = this.physical(
                edge.source,
                edge.discriminator!.field
              );
              return sql`${name(arm.variant)}: (IF ${claim} = ${edge.discriminator!.value} { ${row} ?? ${this.#absentArm(edge)} } ELSE { NULL })`;
            }),
            ", "
          )} }`,
          alias: field.name,
        };
      case "counts":
        return {
          value: sql`{ ${sql.join(
            field.counts.map((count) => {
              const predicate = count.selector?.predicate;
              const counted =
                predicate && count.negated
                  ? ({ kind: "not", predicate } as const)
                  : predicate;
              const lengths = count.edges.map(
                (edge) =>
                  sql`array::len(${this.#members(edge, this.#queries.scoped(edge.target, counted, "related"))})`
              );
              return sql`${name(count.relation)}: ${sql.join(lengths, " + ")}`;
            }),
            ", "
          )} }`,
          alias: field.name,
        };
      default:
        return refuse(`a '${(field as { kind: string }).kind}' projection`);
    }
  }

  /** Whether a layer's `input` holds of this row; `undefined` where it always does. */
  #layerHolds(
    model: AnyModel,
    layer: number,
    input: Input,
    path = ""
  ): Sql | undefined {
    const { predicate } = this.#queries.domain!.layered(model, layer, input);
    return predicate && this.predicate(predicate, true, path);
  }

  /**
   * A column as an operand the caller wrote: a read-gated field is absent on a row
   * that does not carry it, wherever it is read. Every such row is one the domain
   * takes, so `read` holds there and the field's own predicate decides. A layer's
   * predicates read the column itself.
   */
  #gated(model: AnyModel, field: string, column: Sql, path = ""): Sql {
    const q = this.#queries;
    if (q.lowersLayer) return column;
    const gate = q.domain?.projected(model)?.gates.get(field);
    if (!gate) return column;
    const held = gate.flatMap(([layer, read, input]) => {
      if (input === read) return [];
      const lowered = this.#layerHolds(model, layer, input);
      return lowered ? [lowered] : [];
    });
    if (held.length === 0) return column;
    const holds = sql.join(held, " AND ");
    return path
      ? sql`(IF array::len(SELECT VALUE id FROM $this.${sql.raw(path.slice(0, -1))} WHERE ${holds}) > 0 { ${column} } ELSE { NONE })`
      : sql`(IF ${holds} { ${column} } ELSE { NONE })`;
  }

  /** Whether an operand over this field can read absent because of its gate. */
  #gatedHere(model: AnyModel, field: string): boolean {
    const q = this.#queries;
    return (
      !q.lowersLayer && q.domain?.projected(model)?.gates.has(field) === true
    );
  }

  #operand(model: AnyModel, field: string): Sql {
    return this.#gated(model, field, this.physical(model, field));
  }

  /** Where a read-gated field's row carries it: every gating layer's `read` and predicate. */
  #gateHolds(model: AnyModel, gate: FieldGate): Sql | undefined {
    const held = gate.flatMap(([layer, read, input]) =>
      (input === read ? [read] : [read, input]).flatMap((where) => {
        const lowered = this.#layerHolds(model, layer, where);
        return lowered ? [lowered] : [];
      })
    );
    return held.length ? sql`(${sql.join(held, " AND ")})` : undefined;
  }

  /** A condition as a value: true or false, never unset. */
  #truth(condition: Sql | undefined): Sql {
    return condition
      ? sql`(IF ${condition} { true } ELSE { false })`
      : sql.raw("true");
  }

  /**
   * A declared projection key on this row: the layer's `read` around one test per
   * name. Ordered, the last name that holds; else one boolean per name.
   */
  #evidence(
    model: AnyModel,
    field: Extract<PreparedProjectionField, { kind: "evidence" }>
  ): Sql {
    const { layer, read, ordered } = field.evidence;
    const visible = this.#layerHolds(model, layer, read);
    const test = (input: Input) =>
      input === read ? undefined : this.#layerHolds(model, layer, input);
    if (ordered) {
      let highest = sql.raw("NULL");
      for (const [name, input] of field.names) {
        const held = test(input);
        highest = held
          ? sql`(IF ${held} { ${name} } ELSE { ${highest} })`
          : sql`${name}`;
      }
      return visible
        ? sql`(IF ${visible} { ${highest} } ELSE { NULL })`
        : highest;
    }
    const held = sql.join(
      field.names.map(
        ([name, input]) =>
          sql`${sql.raw(JSON.stringify(name))}: ${this.#truth(test(input))}`
      ),
      ", "
    );
    if (!visible) return sql`{ ${held} }`;
    const none = field.names
      .map(([name]) => `${JSON.stringify(name)}: false`)
      .join(", ");
    return sql`(IF ${visible} { { ${held} } } ELSE { { ${sql.raw(none)} } })`;
  }

  /**
   * What a claimed arm whose row did not come back carries: the empty document, "the
   * row is gone", which the decoder refuses. Under a related domain the row may exist
   * and be hidden, which reads as an empty slot.
   */
  #absentArm(edge: Reference): Sql {
    if (this.#queries.domainOf(edge.target, "related") === undefined)
      return sql.raw("{}");
    return sql`(IF array::len(${this.#traversal(edge, undefined, { take: 1 })}) > 0 { NULL } ELSE { {} })`;
  }

  #relation(given: Relation): Sql {
    const predicate = this.#queries.scoped(
      given.edge.target,
      given.arguments.selector?.predicate,
      "related"
    );
    const field: Relation = predicate
      ? {
          ...given,
          arguments: {
            ...given.arguments,
            selector: { ...given.arguments.selector, predicate } as never,
          },
        }
      : given;
    this.#inRelation += 1;
    try {
      return this.#relationRead(field);
    } finally {
      this.#inRelation -= 1;
    }
  }

  #relationRead(field: Relation): Sql {
    const { arguments: args, projection } = field;
    const predicate = args.selector?.predicate;
    const members = this.#destructure(projection);
    if (field.edge.kind === "junction" && field.edge.declared)
      return this.#declaredMembers(field, field.edge);
    if (field.recurrence)
      return this.#carrier(field.edge, args, field.recurrence.depth, members);
    if (
      this.#distinctly(field.edge.target, args.distinct as string[] | undefined)
    )
      return this.#distinctMembers(field.edge, args, members);
    if (field.edge.kind === "junction") {
      const { hop } = this.edgeOf(field.edge);
      const target = field.edge.target;
      const { extras, clauses } = this.#clauses(
        target,
        args,
        args.selector?.predicate
      );
      const read = sql`${hop}(SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${name(tableOf(target))} ${sql.join(clauses, " ")})`;
      return field.edge.many
        ? sql`${read}${members}`
        : sql`((${read}${members})[0] ?? NULL)`;
    }
    const edge = reference(field.edge);
    if (!edge.many && edge.owner === "source" && this.#linked(edge)) {
      const link = name(
        this.#queries.columnName(edge.source, edge.pairs[0]!.source)
      );
      // A hidden target reads as an absent one.
      if (predicate)
        return sql`(IF ${link} = NONE { NULL } ELSE { ((SELECT * FROM $this.${link} WHERE ${this.predicate(predicate, true)})${members})[0] ?? NULL })`;
      return sql`(${name(this.#queries.columnName(edge.source, edge.pairs[0]!.source))}${members} ?? NULL)`;
    }
    const paged = edge.many
      ? this.#pagesOfParents(edge, predicate, args)
      : undefined;
    const read = paged ?? this.#traversal(edge, args.selector?.predicate, args);
    return edge.many
      ? sql`${read}${members}`
      : sql`((${read}${members})[0] ?? NULL)`;
  }

  /**
   * A relation through a model of its own: the row's links, then the rows they
   * name. Each row may carry the link that produced it, as `$through`.
   */
  #declaredMembers(field: Relation, edge: Junction): Sql {
    const { arguments: args, projection, linkRow, linkWhere } = field;
    const target = edge.target;
    const link = edge.declared!.model;
    if (field.recurrence)
      return this.#carrier(
        edge,
        args,
        field.recurrence.depth,
        this.#destructure(projection)
      );
    const fields = projection.fields.map((member) => {
      const { value, alias } = this.#field(projection.model, member);
      return sql`${name(alias)}: ${value}`;
    });
    if (linkRow) {
      const columns = linkRow.fields.map((member) => {
        const { value, alias } = this.#field(link, {
          kind: "scalar",
          name: member,
        });
        return sql`${name(alias)}: ${value}`;
      });
      const named = this.linkTarget(edge, edge.targetSide, "");
      // The link that named this row.
      fields.push(
        sql`\`$through\`: ($links[WHERE ${named} = $row])[0].{ ${sql.join(columns, ", ")} }`
      );
    }
    const { extras, clauses } = this.#clauses(
      target,
      args,
      args.selector?.predicate,
      [sql.raw("id IN $linked")]
    );
    const page = sql`(SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${name(tableOf(target))} ${sql.join(clauses, " ")})`;
    const rows = linkRow
      ? sql`${page}.map(|$item| { LET $row = $item.id; $item.{ ${sql.join(fields, ", ")} } })`
      : sql`${page}.{ ${sql.join(fields, ", ")} }`;
    const read = edge.many ? rows : sql`(${rows})[0] ?? NULL`;
    return sql`({ LET $owner = $this; LET $links = ${this.#links(edge, "$owner", linkWhere?.predicate)}; LET $linked = (SELECT VALUE ${this.linkTarget(edge, edge.targetSide, "")} FROM $links); ${read} })`;
  }

  /** The records one step along `edge` from the record `parent` holds, in order. */
  #children(
    edge: Membership,
    parent: string,
    args: Relation["arguments"]
  ): Sql {
    const predicate = args.selector?.predicate;
    const target = edge.target;
    const held = sql.raw(parent);
    const narrowed = () => this.#clauses(target, args, predicate);
    if (edge.kind === "junction" && edge.declared) {
      const { extras, clauses } = this.#clauses(target, args, predicate, [
        // One subquery less than `#links`: a parser counts its depth.
        sql`id IN (SELECT VALUE ${this.linkTarget(edge, edge.targetSide, "")} FROM ${name(tableOf(edge.declared.model))} WHERE ${sql.join(this.#linkMatch(edge, edge.sourceSide, parent), " AND ")})`,
      ]);
      return sql`(SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${name(tableOf(target))} ${sql.join(clauses, " ")}).id`;
    }
    if (edge.kind === "junction") {
      const { hop } = this.edgeOf(edge);
      const { extras, clauses } = narrowed();
      return sql`${held}${hop}(SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${name(tableOf(target))} ${sql.join(clauses, " ")}).id`;
    }
    const reached = reference(edge);
    if (this.#linked(reached)) {
      if (reached.owner === "source") {
        const link = this.physical(reached.source, reached.pairs[0]!.source);
        if (predicate) {
          const { extras, clauses } = narrowed();
          return sql`(IF ${held}.${link} != NONE { (SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${held}.${link} ${sql.join(clauses, " ")}).id } ELSE { [] })`;
        }
        return sql`(IF ${held}.${link} != NONE { [${held}.${link}] } ELSE { [] })`;
      }
      const { extras, clauses } = narrowed();
      return sql`${held}<~(SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${name(tableOf(target))} FIELD ${name(this.#queries.columnName(target, reached.pairs[0]!.target))} ${sql.join(clauses, " ")}).id`;
    }
    const { extras, clauses } = this.#clauses(target, args, predicate, [
      this.#correlated(reached, parent),
    ]);
    return sql`(SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${name(tableOf(target))} ${sql.join(clauses, " ")}).id`;
  }

  /**
   * A breadth-first walk from a record, as one value: a fold over the levels,
   * each the distinct records the last one reached. A numeric depth labels each
   * edge with its level. An exhaustive one keeps what it has seen, which is what
   * ends a cycle, and refuses past the depth SurrealDB allows a recursion rather
   * than answer a part of the graph.
   */
  #walk(
    edge: Membership,
    args: Relation["arguments"],
    depth: number | false,
    root: Sql
  ): Sql {
    if (depth === 0) return sql.raw("{ level: [], edges: [] }");
    const children = this.#children(edge, "$p", args);
    if (depth === false) {
      const reached = this.#reached(edge, args, root);
      if (reached)
        return sql`({ LET $r = ${reached}; { level: [], edges: array::flatten(array::distinct(array::concat([${root}], $r)).map(|$p| (${children}).map(|$c| { p: $p, c: $c }))) } })`;
    }
    if (depth !== false)
      return sql`array::fold(array::range(1, ${sql.raw(String(depth + 1))}), { level: [${root}], edges: [] }, |$walk, $depth| { LET $pairs = array::flatten($walk.level.map(|$p| (${children}).map(|$c| { p: $p, c: $c, d: $depth }))); { level: array::distinct($pairs.c), edges: array::concat($walk.edges, $pairs) } })`;
    return sql`array::fold(array::range(1, ${sql.raw(String(MAX_WALK + 1))}), { level: [${root}], seen: [${root}], edges: [] }, |$walk, $depth| { LET $pairs = array::flatten($walk.level.map(|$p| (${children}).map(|$c| { p: $p, c: $c }))); LET $reached = array::complement(array::distinct($pairs.c), $walk.seen); { level: $reached, seen: array::concat($walk.seen, $reached), edges: array::concat($walk.edges, $pairs) } })`;
  }

  /** One step along `edge` as an idiom, which a recursion can repeat. */
  #hopIdiom(edge: Membership, args: Relation["arguments"]): Sql | undefined {
    const target = edge.target;
    const narrowed = () =>
      this.#clauses(target, { unordered: true }, args.selector?.predicate)
        .clauses;
    if (edge.kind === "junction") {
      if (edge.declared) return undefined;
      return sql`${this.edgeOf(edge).hop}(SELECT * FROM ${name(tableOf(target))} ${sql.join(narrowed(), " ")}).id`;
    }
    const held = reference(edge);
    if (!this.#linked(held)) return undefined;
    if (held.owner === "source")
      return args.selector?.predicate
        ? undefined
        : sql`.${this.physical(held.source, held.pairs[0]!.source)}`;
    return sql`<~(SELECT * FROM ${name(tableOf(target))} FIELD ${name(this.#queries.columnName(target, held.pairs[0]!.target))} ${sql.join(narrowed(), " ")}).id`;
  }

  /** Every record an exhaustive walk reaches, in one recursion rather than a fold. */
  #reached(
    edge: Membership,
    args: Relation["arguments"],
    root: Sql
  ): Sql | undefined {
    const hop = this.#hopIdiom(edge, args);
    return hop && sql`array::distinct(${root}.{..+collect}${hop})`;
  }

  /** A walk's own statements in a block: `$w`, and the refusal an endless one owes. */
  #walked(walk: Sql, root: Sql = sql.raw("$this.id")): Sql {
    return sql`LET $root = ${root}; LET $w = ${walk}; IF array::len($w.level) > 0 AND $w.seen != NONE { THROW ${`A recursive read walked past ${MAX_WALK} levels.`} };`;
  }

  /** The path a column of `up` rows above this one is read at. */
  #rowAbove(up: number | undefined, path: string): string {
    if (!up) return path;
    const row = this.#above.at(-up);
    if (row === undefined)
      throw new UnsupportedOperationError(
        "An enclosing row's column ({ $row, up }) has no row to read here."
      );
    return `${row}.`;
  }

  /** A record's key as the identity tuple the recursive decoder reads. */
  #identityOf(model: AnyModel, record: Sql): Sql {
    return this.#queries.keyOrder(model).length === 1
      ? sql`[record::id(${record})]`
      : sql`record::id(${record})`;
  }

  /** What `decodeRecursiveCarrier` reads: the root, its nodes and its edges. */
  #carrier(
    edge: Membership,
    args: Relation["arguments"],
    depth: number | false,
    members: Sql
  ): Sql {
    const { source, target } = edge;
    const walk = this.#walk(edge, args, depth, sql.raw("$root"));
    const labelled =
      depth === false ? sql.raw("") : sql.raw(", __rq_depth: $e.d");
    // A block answers with its last expression: a `RETURN` in one would leave
    // whatever expression holds the block, negations included.
    return sql`({ ${this.#walked(walk)} { __rq_root: ${this.#identityOf(source, sql.raw("$root"))}, __rq_nodes: array::distinct($w.edges.c).map(|$n| { __rq_key: ${this.#identityOf(target, sql.raw("$n"))}, __rq_row: $n${members} }), __rq_edges: $w.edges.map(|$e| { __rq_parent: ${this.#identityOf(source, sql.raw("$e.p"))}, __rq_child: ${this.#identityOf(target, sql.raw("$e.c"))}${labelled} }) } })`;
  }

  /** Whether a `distinct` narrows at all: one holding the whole key does not. */
  #distinctly(model: AnyModel, fields: readonly string[] | undefined): boolean {
    return (
      fields !== undefined &&
      fields.length > 0 &&
      !this.#queries.keyOrder(model).every((key) => fields.includes(key))
    );
  }

  /**
   * A relation's first row of each tuple. A parent's members are a value here,
   * so they group as one, where a subquery past the first could not see `$parent`.
   */
  #distinctMembers(
    edge: Membership,
    args: Relation["arguments"],
    members: Sql
  ): Sql {
    const target = edge.target;
    const predicate = args.selector?.predicate;
    const { terms } = this.#ordering(target, { ...args, take: undefined });
    const { extras: inner, order: forward } = this.#ordered(terms);
    const sorted =
      edge.kind === "junction"
        ? sql`${this.edgeOf(edge).hop}(SELECT ${sql.join([sql.raw("*"), ...inner], ", ")} FROM ${name(tableOf(target))}${predicate ? sql` WHERE ${this.predicate(predicate, true)}` : sql.raw("")} ORDER BY ${sql.join(forward, ", ")})`
        : this.#traversal(reference(edge), predicate, {
            orderBy: args.orderBy,
          });
    const tuple = sql.join(
      (args.distinct as string[]).map((field) => this.#operand(target, field)),
      ", "
    );
    const after =
      args.cursor === undefined
        ? sql.raw("")
        : sql` WHERE ${this.#cursor(target, args.cursor as Input, this.#ordering(target, args).terms)}`;
    const { extras, clauses } = this.#clauses(
      target,
      { ...args, distinct: undefined, cursor: undefined },
      undefined,
      [sql.raw("id IN $first")]
    );
    return sql`({ LET $all = ${sorted}; LET $first = (SELECT VALUE array::first(id) FROM (SELECT ${tuple}, id FROM $all${after} GROUP BY ${tuple})); (SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM $all ${sql.join(clauses, " ")})${members} })`;
  }

  /**
   * The one record a to-one's fields name, when they name its whole key: read by
   * key, where a filter on the same fields would scan its table for each row.
   */
  #heldRecord(edge: Reference): Sql | undefined {
    if (edge.many || edge.owner !== "source") return undefined;
    const keys = this.#queries.keyOrder(edge.target);
    const parts = keys.map((key) => {
      const pair = edge.pairs.find(({ target }) => target === key);
      return pair && sql`$owner.${this.physical(edge.source, pair.source)}`;
    });
    if (parts.some((part) => part === undefined)) return undefined;
    const held = parts as Sql[];
    const key =
      held.length === 1
        ? keyCast(edge.target, keys[0]!, held[0]!)
        : sql`[${sql.join(held, ", ")}]`;
    const record = sql`type::record(${tableOf(edge.target)}, ${key})`;
    // An arm another row's type names reads nothing; an unset part names no record.
    const { discriminator } = edge;
    return discriminator
      ? sql`(IF $owner.${this.physical(edge.source, discriminator.field)} = ${discriminator.value} { ${record} } ELSE { [] })`
      : record;
  }

  /**
   * The rows holding a link to this one: `FIELD` is what names the relation,
   * since without it `<~` reads every reference from that table.
   */
  #traversal(
    edge: Reference,
    predicate: PreparedPredicate | undefined,
    args: Pick<
      Partial<Arguments>,
      "orderBy" | "take" | "skip" | "cursor" | "distinct"
    > & { readonly unordered?: boolean }
  ): Sql {
    const target = edge.target;
    const linked = this.#linked(edge);
    const record = linked ? undefined : this.#heldRecord(edge);
    if (record) {
      const { extras, clauses } = this.#clauses(target, args, predicate);
      return sql`({ LET $owner = $this; SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${record} ${sql.join(clauses, " ")} })`;
    }
    const { extras, clauses } = this.#clauses(
      target,
      args,
      predicate,
      linked ? [] : [this.#correlated(edge, "$owner")]
    );
    const read = sql`SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${name(tableOf(target))}`;
    return linked
      ? sql`<~(${read} FIELD ${name(this.#queries.columnName(target, edge.pairs[0]!.target))} ${sql.join(clauses, " ")})`
      : sql`({ LET $owner = $this; ${read} ${sql.join(clauses, " ")} })`;
  }

  /**
   * `positive` carries a negation down to each comparison: SurrealQL compares in
   * two values, where `age != 20` holds of a row with no age, and viborm's filters
   * read as SQL's, where neither `age = 20` nor its negation does.
   */
  predicate(predicate: PreparedPredicate, positive: boolean, path = ""): Sql {
    switch (predicate.kind) {
      case "and":
      case "or": {
        if (predicate.predicates.length === 0)
          return sql.raw(
            (predicate.kind === "and") === positive ? "true" : "false"
          );
        // Each parenthesis counts against the parser's depth, so one arm has none.
        if (predicate.predicates.length === 1)
          return this.predicate(predicate.predicates[0]!, positive, path);
        const conjunction = (predicate.kind === "and") === positive;
        const arms = (node: PreparedPredicate): PreparedPredicate[] =>
          node.kind === predicate.kind ? node.predicates.flatMap(arms) : [node];
        const lowered = onceEach(
          arms(predicate).map((inner) => this.predicate(inner, positive, path))
        );
        // Arms with nothing in them hold as an empty one does.
        if (lowered.length === 0)
          return sql.raw(
            (predicate.kind === "and") === positive ? "true" : "false"
          );
        if (lowered.length === 1) return lowered[0]!;
        return sql`(${joined(lowered, conjunction ? " AND " : " OR ")})`;
      }
      case "not":
        return this.predicate(predicate.predicate, !positive, path);
      case "always":
        return sql.raw(predicate.value === positive ? "true" : "false");
      case "layer": {
        // A layer the call drops is no filter at all.
        const lowered = this.#queries.layer(predicate, (resolved) =>
          this.predicate(resolved, positive, path)
        );
        return lowered ?? sql.raw(positive ? "true" : "false");
      }
      case "exists": {
        const body = this.#queries.scoped(
          predicate.model,
          predicate.predicate,
          "related"
        );
        const rows = sql`SELECT VALUE id FROM ${name(tableOf(predicate.model))}${body ? sql` WHERE ${this.predicate(body, true)}` : sql.raw("")} LIMIT 1`;
        return sql`array::len(${rows}) ${sql.raw(positive ? ">" : "=")} ${sql.raw(positive ? "0" : "0")}`;
      }
      case "condition":
        return sql.raw(
          this.#queries.holds(predicate.condition) === positive
            ? "true"
            : "false"
        );
      case "operation":
        return this.#operation(predicate, positive, path);
      case "relation":
        return this.#relationFilter(predicate, positive, path);
      default:
        return refuse(`a '${predicate.kind}' filter`);
    }
  }

  #operation(
    predicate: Extract<PreparedPredicate, { kind: "operation" }>,
    positive: boolean,
    path: string
  ): Sql {
    const { target, operator } = predicate;
    if (target.kind !== "column") refuse("this filter target");
    const { scalar } = target;
    let column = this.#gated(
      scalar.model,
      scalar.field,
      sql.raw(
        `${path}${this.physical(scalar.model, scalar.field).toStatement()}`
      ),
      path
    );
    const facts = scalar.physical.scalar["~"].state;
    if (facts.type === "json" && facts.array !== true)
      return this.#jsonOperation(predicate, column, positive);
    if (target.path) refuse("this filter target");
    const spatial = this.#spatial(predicate, column, facts);
    if (spatial) {
      const asked = positive ? spatial : sql`!(${spatial})`;
      return scalar.physical.nullable ||
        this.#gatedHere(scalar.model, scalar.field)
        ? sql`(${column} != NONE AND ${asked})`
        : asked;
    }
    const bind = (value: unknown): Sql =>
      this.value(scalar.model, scalar.field, value);
    const guards: Sql[] = [];
    const operandOf = (
      operand: NonNullable<typeof predicate.operand>
    ): unknown => {
      if (operand.kind === "field") {
        const read = operand.scalar;
        const other = sql.raw(
          `${this.#rowAbove(operand.up, path)}${this.physical(read.model, read.field).toStatement()}`
        );
        if (read.physical.nullable) guards.push(sql`${other} != NONE`);
        // A key is a record and a plain column its text: they compare by the text.
        return this.#isRecord(read.model, read.field)
          ? sql`record::id(${other})`
          : other;
      }
      if (operand.kind === "parameter")
        return this.#queries.callValue(operand.parameter);
      if (operand.kind !== "value") refuse(`a '${operand.kind}' operand`);
      return operand.value;
    };
    if (predicate.operand === undefined && operator === "isNull")
      return sql`${column} ${sql.raw(positive ? "=" : "!=")} NONE`;
    const value =
      predicate.operand === undefined
        ? predicate.value
        : operandOf(predicate.operand);
    if (operator === "equals" && value === null)
      return sql`${column} ${sql.raw(positive ? "=" : "!=")} NONE`;
    const fold = (text: Sql) =>
      predicate.insensitive ? sql`string::lowercase(${text})` : text;
    // A key or a link is a record, and its text is what a pattern or a case reads.
    const isRecord = this.#isRecord(scalar.model, scalar.field);
    const asText = isRecord
      ? sql`<string>record::id(${column})`
      : this.#queries.keyOrder(scalar.model).includes(scalar.field)
        ? sql`<string>${column}`
        : column;
    const comparedToField =
      predicate.operand?.kind === "field" ||
      predicate.operands?.some((operand) => operand.kind === "field");
    if (comparedToField && isRecord) column = sql`record::id(${column})`;
    const read = predicate.insensitive ? asText : column;
    const compared = (member: unknown) =>
      predicate.insensitive && isRecord
        ? sql`string::lowercase(${member})`
        : fold(bind(member));
    let test: Sql;
    if (COMPARISONS[operator]) {
      test = sql`${fold(read)} ${sql.raw(COMPARISONS[operator])} ${compared(value)}`;
    } else if (FUNCTIONS[operator]) {
      test = sql`${sql.raw(FUNCTIONS[operator])}(${fold(asText)}, ${fold(sql`${value}`)})`;
    } else if (operator === "has") {
      if (value === null) return sql.raw(positive ? "false" : "true");
      test = sql`${column} CONTAINS ${sql`${stored({ ...facts, array: false }, value)}`}`;
    } else if (operator === "hasEvery") {
      if ((value as unknown[]).length === 0)
        return sql`${column} ${sql.raw(positive ? "!=" : "=")} NONE`;
      test = sql`${column} CONTAINSALL ${bind(value)}`;
    } else if (operator === "hasSome") {
      if ((value as unknown[]).length === 0)
        return sql.raw(positive ? "false" : "true");
      test = sql`${column} CONTAINSANY ${bind(value)}`;
    } else if (operator === "isEmpty") {
      // A list that is not there counts as empty, on every dialect.
      const empty = sql`array::len(${column} ?? []) ${sql.raw(value ? "=" : ">")} 0`;
      return positive ? empty : sql`!(${empty})`;
    } else if (operator === "in" || operator === "notIn") {
      // A call's list is the list, as one value of the caller's would be.
      const list = predicate.operands
        ? predicate.operands.flatMap((operand) => {
            const read = operandOf(operand);
            return operand.kind === "parameter" && Array.isArray(read)
              ? read
              : [read];
          })
        : (value as unknown[]);
      // An empty list asks nothing of the row, so a missing value does not matter.
      if (list.length === 0)
        return sql.raw((operator === "notIn") === positive ? "true" : "false");
      const bound = boundList(list.map(compared));
      test = sql`${fold(read)} ${sql.raw(operator === "in" ? "IN" : "NOT IN")} ${bound}`;
    } else {
      return refuse(`the '${operator}' operator`);
    }
    const nullable =
      scalar.physical.nullable || this.#gatedHere(scalar.model, scalar.field);
    const asked = positive ? test : sql`!(${test})`;
    const required = [...(nullable ? [sql`${column} != NONE`] : []), ...guards];
    return required.length
      ? sql`(${sql.join(required, " AND ")} AND ${asked})`
      : asked;
  }

  /** A point's or a vector's own operators, which read no comparison below. */
  #spatial(
    predicate: Extract<PreparedPredicate, { kind: "operation" }>,
    column: Sql,
    facts: ScalarFacts
  ): Sql | undefined {
    const { operator, value } = predicate;
    if (operator === "distance") {
      const spec = value as Input;
      const distance = this.#distance(
        column,
        facts,
        predicate.target.scalar!.field,
        spec,
        "filter"
      );
      const bounds = ["lt", "lte", "gt", "gte"]
        .filter((bound) => spec[bound] !== undefined)
        .map(
          (bound) =>
            sql`${distance} ${sql.raw(COMPARISONS[bound]!)} ${spec[bound]}`
        );
      return sql`(${sql.join(bounds, " AND ")})`;
    }
    if (facts.type !== "point" || facts.array) return undefined;
    const longitude = sql`${column}.coordinates[0]`;
    const latitude = sql`${column}.coordinates[1]`;
    if (operator === "equals") {
      if (value === null) return undefined;
      const point = value as GeoPointValue;
      // -180 and +180 are one meridian, whichever a writer stored.
      const meridian =
        point.longitude === 180
          ? sql`(${longitude} = 180 OR ${longitude} = -180)`
          : sql`${longitude} = ${point.longitude}`;
      return sql`(${meridian} AND ${latitude} = ${point.latitude})`;
    }
    if (operator !== "within") return undefined;
    const area = value as {
      readonly bounds?: {
        readonly north: number;
        readonly south: number;
        readonly east: number;
        readonly west: number;
      };
      readonly polygon?: {
        readonly outer: readonly GeoPointValue[];
        readonly holes?: readonly (readonly GeoPointValue[])[];
      };
    };
    if (area.polygon) {
      const { outer, holes = [] } = area.polygon;
      // `INTERSECTS` holds a polygon's boundary and not its holes, as PostGIS
      // does. Its plane has an edge at 180: a ring crossing it is unwrapped past
      // it, and a point read at both its longitudes.
      const crosses = [outer, ...holes].some((ring) =>
        ring.some(
          (point, index) =>
            Math.abs(
              point.longitude - ring[(index + 1) % ring.length]!.longitude
            ) > 180
        )
      );
      const coordinates = [outer, ...holes].map((ring) => {
        const points = ring.map((point) => [
          crosses && point.longitude < 0
            ? point.longitude + 360
            : point.longitude,
          point.latitude,
        ]);
        return [...points, points[0]!];
      });
      const polygon = sql`<geometry>${{ type: "Polygon", coordinates }}`;
      return crosses
        ? sql`(type::point([(IF ${longitude} < 0 { ${longitude} + 360 } ELSE { ${longitude} }), ${latitude}]) INTERSECTS ${polygon})`
        : sql`${column} INTERSECTS ${polygon}`;
    }
    const { north, south, east, west } = area.bounds!;
    const inLatitude = sql`${latitude} >= ${south} AND ${latitude} <= ${north}`;
    if (west === -180 && east === 180) return sql`(${inLatitude})`;
    const westArm = sql`${longitude} >= ${west}`;
    const eastArm = sql`${longitude} <= ${east}`;
    const arms = [
      west > east
        ? sql`(${westArm} OR ${eastArm})`
        : sql`(${westArm} AND ${eastArm})`,
      ...(west === -180 && east < 180 ? [sql`${longitude} = 180`] : []),
      ...(east === 180 && west > -180 ? [sql`${longitude} = -180`] : []),
    ];
    return sql`(${inLatitude} AND (${sql.join(arms, " OR ")}))`;
  }

  #distance(
    column: Sql,
    facts: ScalarFacts & { readonly dimension?: number },
    field: string,
    spec: Input,
    usage: string
  ): Sql {
    if (facts.type === "point") {
      const to = spec.to as GeoPointValue;
      return sql`(IF ${column} != NONE { geo::distance(${column}, ${geometry(to)}) } ELSE { NONE })`;
    }
    const to = spec.to as number[];
    if (facts.dimension !== undefined && to.length !== facts.dimension)
      throw new UnsupportedOperationError(
        `Vector distance ${usage} dimension mismatch for '${field}': expected ${facts.dimension} values, received ${to.length}.`
      );
    const distance =
      spec.metric === "cosine"
        ? sql`1 - vector::similarity::cosine(${column}, ${to})`
        : sql`vector::distance::euclidean(${column}, ${to})`;
    return sql`(IF ${column} != NONE { ${distance} } ELSE { NONE })`;
  }

  /** A JSON filter: a missing path answers neither a test nor its negation. */
  #jsonOperation(
    predicate: Extract<PreparedPredicate, { kind: "operation" }>,
    column: Sql,
    positive: boolean
  ): Sql {
    const { target, operator, value, insensitive } = predicate;
    const steps = target.kind === "column" ? (target.path ?? []) : [];
    const at = steps.reduce(jsonStep, column);
    const answer = (test: Sql, reads: Sql = at) =>
      positive ? test : sql`(${reads} != NONE AND !(${test}))`;
    // A value this operator cannot compare answers neither it nor its negation.
    const typed = (guard: Sql, test: Sql) =>
      sql`(${guard} AND ${positive ? test : sql`!(${test})`})`;
    const text = (fn: string) => {
      const fold = (member: Sql) =>
        insensitive ? sql`string::lowercase(${member})` : member;
      return typed(
        sql`type::is_string(${at})`,
        sql`${sql.raw(fn)}(${fold(at)}, ${fold(sql`${value}`)})`
      );
    };
    const isArray = sql`type::is_array(${at})`;
    switch (operator) {
      case "equals": {
        const sentinel = jsonNullKindOf(value);
        if (sentinel === "DbNull" || (value === null && steps.length === 0))
          return sql`${column} ${sql.raw(positive ? "=" : "!=")} NONE`;
        if (sentinel === "JsonNull") return answer(sql`${at} = NULL`, column);
        if (sentinel)
          return answer(sql`(${column} = NONE OR ${at} = NULL)`, column);
        return answer(sql`${at} = ${value}`);
      }
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const kind = typeof value === "number" ? "number" : "string";
        return typed(
          sql`${sql.raw(`type::is_${kind}`)}(${at})`,
          sql`${at} ${sql.raw(COMPARISONS[operator]!)} ${value}`
        );
      }
      case "string_contains":
        return text("string::contains");
      case "string_starts_with":
        return text("string::starts_with");
      case "string_ends_with":
        return text("string::ends_with");
      case "array_contains":
        return typed(
          isArray,
          sql`${at} CONTAINSALL ${Array.isArray(value) ? value : [value]}`
        );
      case "array_starts_with":
        return typed(isArray, sql`${at}[0] = ${value}`);
      case "array_ends_with":
        return typed(isArray, sql`array::last(${at}) = ${value}`);
      default:
        return refuse(`the '${operator}' operator`);
    }
  }

  /** A key or a link is a record: its value is bound as one, never as a string. */
  value(model: AnyModel, field: string, value: unknown): Sql {
    const q = this.#queries;
    // A value this statement reads for itself ({@link SurrealQueries.locatedValue}):
    // a record, where a private column holds its key.
    if (value instanceof Sql)
      return model["~"].state.scalars[field]
        ? value
        : this.#carried(model, field, sql`record::id(${value})`);
    if (isSingleKey(q, model, field))
      return sql`${new RecordId(
        tableOf(model),
        (isIntegerKey(model, field) && typeof value === "string"
          ? Number(value)
          : keyPart(model, field, value)) as string
      )}`;
    for (const slot of Object.keys(model["~"].state.relations)) {
      const { edges } = q.countedMemberships(model, slot);
      const edge = edges[0];
      if (
        edges.length === 1 &&
        edge?.kind === "reference" &&
        edge.owner === "source" &&
        edge.pairs.length === 1 &&
        edge.pairs[0]!.source === field &&
        isSingleKey(q, edge.target, edge.pairs[0]!.target)
      )
        return sql`${new RecordId(
          tableOf(edge.target),
          keyPart(edge.target, edge.pairs[0]!.target, value) as string
        )}`;
    }
    const sentinel = jsonNullKindOf(value);
    if (sentinel)
      return sentinel === "JsonNull" ? sql`${null}` : sql.raw("NONE");
    const state = model["~"].state.scalars[field]?.["~"].state;
    return state
      ? sql`${stored(state, value)}`
      : sql`${this.#carriesText(model, field) && value !== null && value !== undefined ? String(value) : value}`;
  }

  #relationFilter(
    predicate: Extract<PreparedPredicate, { kind: "relation" }>,
    positive: boolean,
    path: string
  ): Sql {
    const edge = predicate.edge;
    const { quantifier } = predicate;
    const inner = predicate.predicate;
    if (predicate.closure) {
      if (path) refuse("a recursive filter through a to-one link");
      const wanted = quantifier === "some" || quantifier === "is";
      const found = this.#closure(edge, predicate.closure, quantifier, inner);
      return wanted === positive ? found : sql`!(${found})`;
    }
    // As the SQL lowering's EXISTS and NOT EXISTS: a body-less `is` asks that no
    // related row exists (`author: null`), a body-less `isNot` that one does.
    const wanted =
      quantifier === "some" ||
      (quantifier === "is" && inner !== undefined) ||
      (quantifier === "isNot" && inner === undefined);
    const asked = this.#queries.scoped(
      edge.target,
      quantifier === "every" && inner
        ? ({ kind: "not", predicate: inner } as const)
        : inner,
      "related"
    );
    const heldLink =
      this.#judging &&
      this.#lets &&
      asked &&
      !predicate.link &&
      !readsAbove(asked) &&
      edge.kind === "reference" &&
      !edge.many &&
      edge.owner === "source" &&
      this.#linked(edge);
    if (heldLink && this.#walksForward(asked)) {
      // One row's link is one read, where a list of all that hold is many.
      const link = `${path}${this.physical(edge.source, edge.pairs[0]!.source).toStatement()}`;
      const inner = this.predicate(asked, true, `${link}.`);
      // A list holds nothing unset, so asking is enough, and a scan can stop early.
      const held = onlyLists(asked)
        ? inner
        : sql`(${sql.raw(link)} != NONE AND ${inner})`;
      return wanted === positive ? held : sql`!(${held})`;
    }
    if (heldLink && !path) {
      const targets = this.#hoist(
        this.#selecting(edge.target, sql.raw("id"), asked)
      )!;
      const held = sql`${this.physical(edge.source, edge.pairs[0]!.source)} IN ${targets}`;
      return wanted === positive ? held : sql`!(${held})`;
    }
    // A row above stays in its own statement: a list hoisted out of it has no such row.
    const holders =
      (!path || this.#judging) &&
      asked &&
      predicate !== this.#walking &&
      !readsAbove(asked) &&
      this.#holders(predicate, asked);
    if (holders) {
      const held = this.#hoist(holders.list(holders.rows()))!;
      return sql`${sql.raw(path ? path.slice(0, -1) : "id")} ${sql.raw(wanted === positive ? "IN" : "NOT IN")} ${held}`;
    }
    if (predicate.link) this.#queries.refuseHiddenLink(edge, predicate);
    const above = `$above${this.#above.length}`;
    this.#above.push(above);
    let found: Sql;
    try {
      found =
        edge.kind === "junction" && edge.declared
          ? this.#relatedThrough(edge, quantifier, inner, predicate.link, path)
          : this.#related(edge, quantifier, inner, path);
    } finally {
      this.#above.pop();
    }
    const row = path ? `$this.${path.slice(0, -1)}` : "$this";
    const within =
      asked && readsAbove(asked)
        ? sql`({ LET ${sql.raw(above)} = ${sql.raw(row)}; ${found} })`
        : found;
    return wanted === positive ? within : sql`!(${within})`;
  }

  /**
   * The records holding a relation to the rows a body holds of, walked from those
   * rows: a list computed once, however many rows the statement then reads. `rows`
   * reads what each body row holds, and `list` makes those one list of records.
   */
  #holders(
    filter: Extract<PreparedPredicate, { kind: "relation" }>,
    body: PreparedPredicate
  ):
    | {
        readonly rows: (limit?: number) => Sql;
        readonly list: (rows: Sql) => Sql;
      }
    | undefined {
    const edge = filter.edge;
    if (!this.#lets || filter.closure || filter.link) return undefined;
    const target = edge.target;
    const distinct = (rows: Sql) => sql`array::distinct(${rows})`;
    const flat = (rows: Sql) => sql`array::flatten(${rows})`;
    if (edge.kind === "junction") {
      if (edge.declared) return undefined;
      const { back } = this.edgeOf(edge);
      return {
        rows: (limit) =>
          this.#selecting(
            target,
            sql`${back}${name(tableOf(edge.source))}`,
            body,
            limit
          ),
        list: (rows) => distinct(flat(rows)),
      };
    }
    const held = reference(edge);
    if (!this.#linked(held)) return undefined;
    const { source, target: holder } = held.pairs[0]!;
    if (held.owner === "source")
      return {
        // Counting toward a limit reads the index on the link, which stops at it:
        // from each target, one with many holders would be read whole.
        rows: (limit) =>
          limit === undefined
            ? this.#selecting(
                target,
                sql`<~(${name(tableOf(held.source))} FIELD ${name(this.#queries.columnName(held.source, source))})`,
                body
              )
            : sql`(SELECT VALUE id FROM ${name(tableOf(held.source))} WHERE ${this.physical(held.source, source)} IN ${this.#hoist(this.#selecting(target, sql.raw("id"), body))!} LIMIT ${sql.raw(String(limit))})`,
        list: flat,
      };
    const column = name(this.#queries.columnName(target, holder));
    return {
      rows: (limit) => this.#selecting(target, column, body, limit),
      list: distinct,
    };
  }

  /** `SELECT VALUE` over the rows a predicate holds of, driven as a statement is. */
  #selecting(
    model: AnyModel,
    value: Sql,
    body: PreparedPredicate,
    limit?: number
  ): Sql {
    const { from, rest } = this.#driven(model, body);
    return sql`(SELECT VALUE ${value} FROM ${from}${
      rest ? sql` WHERE ${this.predicate(rest, true)}` : sql.raw("")
    }${limit === undefined ? sql.raw("") : sql.raw(` LIMIT ${limit}`)})`;
  }

  /**
   * Where a statement reads its rows: the table, or a relation filter's holders
   * when every row must be one of them, which then reads only those.
   */
  #driven(
    model: AnyModel,
    predicate: PreparedPredicate | undefined,
    paged = false
  ): {
    readonly from: Sql;
    readonly rest: PreparedPredicate | undefined;
    /** A page may need fewer rows than the list holds: read only so far ahead. */
    readonly ahead?: { readonly rows: Sql; readonly arm: PreparedPredicate };
    /** `from` is the one record the filter names, and `rest` asks more of it. */
    readonly named?: boolean;
  } {
    const table = name(tableOf(model));
    if (!(predicate && this.#lets)) return { from: table, rest: predicate };
    // A row named by its key is read, and its links followed.
    if (this.#namesOneRow(model, predicate)) {
      const named = this.namedRecord(model, predicate);
      return named
        ? { from: named.record, rest: named.rest, named: true }
        : { from: table, rest: predicate };
    }
    const flat = (node: PreparedPredicate): PreparedPredicate[] =>
      node.kind === "and" ? node.predicates.flatMap(flat) : [node];
    const arms = flat(predicate);
    /** A list, where `arm` is a relation filter some row can hold. */
    const listed = (arm: PreparedPredicate) => {
      if (
        arm.kind !== "relation" ||
        !arm.predicate ||
        (arm.quantifier !== "some" && arm.quantifier !== "is")
      )
        return undefined;
      // Among the rows this call may see of them, as a filter reads them anywhere.
      const asked = this.#queries.scoped(
        arm.edge.target,
        arm.predicate,
        "related"
      )!;
      // A row above stays in its own statement: a list hoisted out of it has no such row.
      if (readsAbove(asked)) return undefined;
      const holders = this.#holders(arm, asked);
      if (!holders) return undefined;
      if (!paged) return { from: this.#hoist(holders.list(holders.rows()))! };
      const rows = this.#hoist(holders.rows(HOLDERS_AHEAD))!;
      return {
        from: this.#hoist(holders.list(rows))!,
        ahead: { rows, arm },
      };
    };
    const without = (at: number) => {
      const others = arms.filter((_, position) => position !== at);
      return others.length
        ? ({ kind: "and", predicates: others } as const)
        : undefined;
    };
    for (const [index, arm] of arms.entries()) {
      if (arm.kind !== "layer") {
        const found = listed(arm);
        if (found) return { ...found, rest: without(index) };
        continue;
      }
      // A rule's own arms read as its layer reads them, with what is left of it kept.
      const resolved = this.#queries.resolved(arm);
      if (!resolved) continue;
      const inner = flat(resolved);
      for (const [position, candidate] of inner.entries()) {
        let found: ReturnType<typeof listed>;
        this.#queries.layer(arm, () => {
          found = listed(candidate);
          return sql.raw("");
        });
        if (!found) continue;
        const left = inner.filter((_, at) => at !== position);
        const others = arms.filter((_, at) => at !== index);
        const kept: PreparedPredicate[] = left.length
          ? [
              ...others,
              {
                ...arm,
                predicate: { kind: "and", predicates: left },
                folded: new Map(),
              },
            ]
          : others;
        return {
          ...(found as NonNullable<typeof found>),
          rest: kept.length ? { kind: "and", predicates: kept } : undefined,
        };
      }
    }
    return { from: table, rest: predicate };
  }

  /** Whether a link and the row it names hold what a quantifier asks, together. */
  #relatedThrough(
    edge: Junction,
    quantifier: string,
    inner: PreparedPredicate | undefined,
    link: PreparedPredicate | undefined,
    path: string
  ): Sql {
    if (path) refuse("a filter through a to-one link into a declared junction");
    const narrowed =
      quantifier === "every" && inner
        ? ({ kind: "not", predicate: inner } as const)
        : inner;
    const named = this.linkTarget(edge, edge.targetSide, "");
    // `every` over a pair: no link of this row fails the link's test and the
    // row's together. Their halves cannot answer it one after the other.
    if (quantifier === "every" && link) {
      const fails = [
        this.predicate(link, false, "$l."),
        ...(inner
          ? [
              sql`array::len(SELECT VALUE id FROM ${name(tableOf(edge.target))} WHERE id = ${this.linkTarget(edge, edge.targetSide, "$l")} AND ${this.predicate(inner, false)} LIMIT 1) > 0`,
            ]
          : []),
      ];
      return sql`({ LET $owner = $this; array::len(${this.#links(edge, "$owner")}.filter(|$l| ${sql.join(fails, " OR ")})) > 0 })`;
    }
    const rows = narrowed
      ? sql`SELECT VALUE id FROM ${name(tableOf(edge.target))} WHERE id IN $linked AND ${this.predicate(narrowed, true)} LIMIT 1`
      : sql.raw("SELECT VALUE id FROM $linked LIMIT 1");
    return sql`({ LET $owner = $this; LET $linked = (SELECT VALUE ${named} FROM ${this.#links(edge, "$owner", link)}); array::len(${rows}) > 0 })`;
  }

  /** Whether the rows a walk from this one reaches hold what a quantifier asks. */
  #closure(
    edge: Membership,
    closure: { readonly depth: number | false; readonly self: boolean },
    quantifier: string,
    inner: PreparedPredicate | undefined
  ): Sql {
    const narrowed =
      quantifier === "every" && inner
        ? ({ kind: "not", predicate: inner } as const)
        : inner;
    const test = (rows: Sql) =>
      narrowed
        ? sql`array::len(SELECT VALUE id FROM ${rows} WHERE ${this.predicate(narrowed, true)} LIMIT 1) > 0`
        : sql`array::len(${rows}) > 0`;
    const scope = this.#queries.scoped(edge.target, undefined, "related");
    const args = (scope ? { selector: { predicate: scope } } : {}) as never;
    // Without `self`, a link's first step is the row's own value: a judged row's
    // is the one it would leave, not the one stored.
    const root = sql.raw(
      edge.kind === "reference" && edge.owner === "source" && !closure.self
        ? "$this"
        : "$this.id"
    );
    const recursion =
      closure.depth === false
        ? this.#reached(edge, args, sql.raw("$root"))
        : undefined;
    if (recursion)
      return sql`({ LET $root = ${root}; LET $r = ${recursion}; ${test(closure.self ? sql.raw("array::concat([$root], $r)") : sql.raw("$r"))} })`;
    const walk = this.#walk(edge, args, closure.depth, sql.raw("$root"));
    const reached = closure.self
      ? sql.raw("array::concat([$root], $w.edges.c)")
      : sql.raw("$w.edges.c");
    return sql`({ ${this.#walked(walk, root)} ${test(reached)} })`;
  }

  /** Whether a related row exists, among those the quantifier looks at. */
  #related(
    relation: Membership,
    quantifier: string,
    inner: PreparedPredicate | undefined,
    path: string
  ): Sql {
    const narrowed = this.#queries.scoped(
      relation.target,
      quantifier === "every" && inner
        ? ({ kind: "not", predicate: inner } as const)
        : inner,
      "related"
    );
    if (relation.kind === "junction") {
      if (path) refuse("a to-many filter through a to-one link");
      const { hop } = this.edgeOf(relation);
      const target = name(tableOf(relation.target));
      return narrowed
        ? sql`${hop}(${target} WHERE ${this.predicate(narrowed, true)})`
        : sql`${hop}${target}`;
    }
    const edge = reference(relation);
    if (!edge.many && edge.owner === "source" && this.#linked(edge)) {
      const link = `${path}${name(this.#queries.columnName(edge.source, edge.pairs[0]!.source)).toStatement()}`;
      if (narrowed && walksFurther(narrowed))
        return sql`(${sql.raw(link)} != NONE AND array::len(SELECT VALUE id FROM ${sql.raw(`$this.${link}`)} WHERE ${this.predicate(narrowed, true)}) > 0)`;
      return narrowed
        ? sql`(${sql.raw(link)} != NONE AND ${this.predicate(narrowed, true, `${link}.`)})`
        : sql`${sql.raw(link)} != NONE`;
    }
    if (path) refuse("a to-many filter through a to-one link");
    // A non-empty list holds, in one parser level fewer than asking for its length.
    return this.#traversal(edge, narrowed, { take: 1 });
  }
}
