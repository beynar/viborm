/**
 * PROTOTYPE, read-only: `docs/architecture/query-backend-frontier.md` step 4.
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
  PreparedPredicate,
  PreparedProjection,
  PreparedProjectionField,
  Queries,
  Query,
  Read,
  ReadBackend,
} from "@query-engine/raptor3/shared/query";
import { firstRow, rowSet } from "@query-engine/raptor3/shared/query";
import type {
  Arguments,
  Input,
  ReadOperation,
} from "@query-engine/raptor3/shared/schema";
import type { Membership } from "@query-engine/raptor3/shared/storage";
import { jsonNullKindOf } from "@schema/json-null";
import { Sql, sql } from "@sql";
import { Decimal, GeometryPoint, RecordId } from "surrealdb";

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
const INDEX = /^\d+$/;
const QUOTABLE = /^[A-Za-z0-9_]+$/;

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
  readonly descending: boolean;
  readonly nullable: boolean;
  readonly nulls?: "first" | "last";
};

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

/** A record id's part as the provider holds it. */
function plainPart(value: unknown): unknown {
  return value;
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

/** One step of a JSON path: an index where it reads as one. */
function jsonStep(step: string): string {
  return INDEX.test(step) ? `[${step}]` : `[${JSON.stringify(step)}]`;
}

export class SurrealReadBackend implements ReadBackend {
  readonly #queries: Queries;

  constructor(queries: Queries) {
    this.#queries = queries;
  }

  read(model: AnyModel, operation: ReadOperation, args: Arguments): Read {
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
          sql: this.statement(model, prepared, args, selector?.predicate),
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
            { ...args, take },
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
          sql: this.statement(model, prepared, args, this.#filter(model, args)),
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
              : sql`count(${this.physical(model, field)} != NONE) AS ${name(alias)}`
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

  /** Whether a relation's link is a record, which a graph read can follow. */
  #linked(edge: Reference): boolean {
    if (edge.pairs.length !== 1 || edge.discriminator) return false;
    const q = this.#queries;
    const { source, target } = edge.pairs[0]!;
    return edge.owner === "source"
      ? isSingleKey(q, edge.target, target)
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
  #correlated(edge: Reference): Sql {
    const q = this.#queries;
    const pairs = edge.pairs.map(({ source, target }) => {
      const parent = sql`$parent.${this.physical(edge.source, source)}`;
      if (!edge.discriminator)
        return sql`${this.physical(edge.target, target)} = ${parent}`;
      if (isSingleKey(q, edge.target, target))
        return sql`id = type::record(${tableOf(edge.target)}, ${keyCast(edge.target, target, parent)})`;
      return sql`${this.physical(edge.target, target)} = ${this.#carried(edge.target, target, sql`record::id(${parent})`)}`;
    });
    const { discriminator } = edge;
    if (discriminator) {
      const owner = discriminator.side === "source" ? edge.source : edge.target;
      const column = this.physical(owner, discriminator.field);
      pairs.push(
        discriminator.side === "source"
          ? sql`$parent.${column} = ${discriminator.value}`
          : sql`${column} = ${discriminator.value}`
      );
    }
    return sql.join(pairs, " AND ");
  }

  /** The rows an aggregate reads: the filtered table, or its page. */
  #rows(model: AnyModel, args: Arguments): Sql {
    const predicate = this.#filter(model, args);
    const paged =
      args.take !== undefined ||
      args.skip !== undefined ||
      args.cursor !== undefined;
    if (paged) {
      const { extras, clauses } = this.#clauses(model, args, predicate);
      return sql`(SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${name(tableOf(model))} ${sql.join(clauses, " ")})`;
    }
    return predicate
      ? sql`${name(tableOf(model))} WHERE ${this.predicate(predicate, true)}`
      : name(tableOf(model));
  }

  /**
   * `aggregate` and `groupBy`: flat aggregates inside, the public shape outside,
   * where a `having` and an order read them by name. `math::sum` of nothing is 0,
   * and SQL's is NULL, so each aggregate carries how many values it saw.
   */
  #aggregation(model: AnyModel, args: Arguments, by: readonly string[]): Query {
    const inner = new Map<string, Sql>();
    const flat = (alias: string, expression: Sql) => {
      inner.set(alias, sql`${expression} AS ${name(alias)}`);
      return name(alias);
    };
    const seen = (field: string) =>
      flat(`__n_${field}`, sql`count(${this.physical(model, field)} != NONE)`);
    const of = (aggregate: string, field: string) => {
      if (aggregate === "_count" && field === "_all")
        return flat("__count__all", sql`count()`);
      const column = this.physical(model, field);
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
      const column = flat(field, this.physical(model, field));
      outer.push(sql`(${column} ?? NULL) AS ${name(field)}`);
      fields[field] = this.#leaf(model, field);
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
      ? this.#having(model, args.having as Input, of, seen)
      : undefined;
    const order = this.#groupOrder(model, args.orderBy, of, by);
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
      ? this.#rows(model, {
          ...args,
          take: undefined,
          skip: undefined,
          cursor: undefined,
        })
      : this.#rows(model, args);
    return {
      sql: sql.join(
        [
          sql`SELECT ${sql.join(outer.length ? outer : [sql.raw("true AS __row")], ", ")} FROM (SELECT ${sql.join([...inner.values()], ", ")} FROM ${rows} ${grouping})`,
          ...clauses,
        ],
        " "
      ),
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

  #having(
    model: AnyModel,
    having: Input,
    of: (aggregate: string, field: string) => Sql,
    seen: (field: string) => Sql
  ): Sql {
    const clauses: Sql[] = [];
    for (const [key, value] of Object.entries(having)) {
      if (value === undefined) continue;
      if (key === "AND" || key === "OR" || key === "NOT") {
        const arms = [value]
          .flat()
          .map((arm) => this.#having(model, arm as Input, of, seen));
        if (arms.length === 0) {
          // An empty OR holds of nothing; an empty AND or NOT asks nothing.
          if (key === "OR") clauses.push(sql.raw("false"));
          continue;
        }
        clauses.push(
          key === "NOT"
            ? sql`(${sql.join(
                arms.map((arm) => sql`!(${arm})`),
                " AND "
              )})`
            : sql`(${sql.join(arms, key === "OR" ? " OR " : " AND ")})`
        );
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
            true
          )
        );
        continue;
      }
      for (const aggregate of aggregated) {
        const expression = of(aggregate, key);
        const asked = filter[aggregate] as Input;
        // An aggregate of no values is NULL, whatever `math::sum` says of them.
        const guard = aggregate === "_count" ? undefined : seen(key);
        if (guard && asked.equals === null) {
          clauses.push(sql`${guard} = 0`);
          continue;
        }
        const test = this.#compare(
          model,
          key,
          aggregate === "_count",
          expression,
          asked
        );
        clauses.push(guard ? sql`(${guard} > 0 AND ${test})` : test);
      }
    }
    return clauses.length
      ? sql`(${sql.join(clauses, " AND ")})`
      : sql.raw("true");
  }

  #compare(
    model: AnyModel,
    field: string,
    counted: boolean,
    expression: Sql,
    filter: Input
  ): Sql {
    const bind = (value: unknown) =>
      counted ? sql`${value}` : this.value(model, field, value);
    const given = Object.entries(filter).filter(
      ([, operand]) => operand !== undefined
    );
    if (given.length === 0) return sql.raw("true");
    const tests = given.map(([operator, operand]) => {
      if (COMPARISONS[operator])
        return sql`${expression} ${sql.raw(COMPARISONS[operator])} ${bind(operand)}`;
      if (operator === "not")
        return typeof operand === "object" && operand !== null
          ? sql`!(${this.#compare(model, field, counted, expression, operand as Input)})`
          : sql`${expression} != ${bind(operand)}`;
      if (operator === "in" || operator === "notIn")
        return sql`${expression} ${sql.raw(operator === "in" ? "IN" : "NOT IN")} [${sql.join(
          (operand as unknown[]).map(bind),
          ", "
        )}]`;
      return refuse(`the '${operator}' operator in a having`);
    });
    return sql`(${sql.join(tests, " AND ")})`;
  }

  #groupOrder(
    _model: AnyModel,
    input: unknown,
    of: (aggregate: string, field: string) => Sql,
    by: readonly string[]
  ): Sql[] {
    const terms: Sql[] = [];
    for (const order of input === undefined ? [] : [input].flat()) {
      for (const [key, spec] of Object.entries(order as Input)) {
        if (spec === undefined) continue;
        if (AGGREGATE_NAMES.includes(key)) {
          for (const [field, direction] of Object.entries(spec as Input))
            terms.push(
              sql`${of(key, field)} ${sql.raw(direction === "desc" ? "DESC" : "ASC")}`
            );
          continue;
        }
        const sort = typeof spec === "string" ? spec : (spec as Input).sort;
        terms.push(
          sql`${name(key)} ${sql.raw(sort === "desc" ? "DESC" : "ASC")}`
        );
      }
    }
    return terms.length || by.length === 0
      ? terms
      : by.map((field) => sql`${name(field)} ASC`);
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
    return args.where === undefined
      ? undefined
      : this.#queries.prepareSelector(model, args.where).predicate;
  }

  statement(
    model: AnyModel,
    prepared: PreparedProjection,
    args: Partial<Arguments>,
    predicate: PreparedPredicate | undefined,
    conditions: readonly Sql[] = [],
    from: Sql = name(tableOf(model))
  ): Sql {
    const { extras, clauses } = this.#clauses(
      model,
      args,
      predicate,
      conditions
    );
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
    if (shadowed)
      return sql`SELECT ${this.columns(prepared)} FROM (${sql.join(
        [
          sql`SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${from}`,
          ...clauses,
        ],
        " "
      )})`;
    return sql.join(
      [
        sql`SELECT ${sql.join([this.columns(prepared), ...extras], ", ")} FROM ${from}`,
        ...clauses,
      ],
      " "
    );
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

  /** A compound key's record. */
  recordOf(model: AnyModel, row: Input): RecordId {
    return new RecordId(
      tableOf(model),
      this.#queries
        .keyOrder(model)
        .map((key) => plainPart(this.#part(model, key, row[key]))) as never
    );
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
    if (edge.kind === "junction")
      return sql`id ${sql.raw(outside ? "NOT IN" : "IN")} ${this.membersOf(edge, parent)}`;
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
    if (edge.declared) refuse("a declared junction");
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
    };
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
    >,
    predicate: PreparedPredicate | undefined,
    conditions: readonly Sql[] = []
  ): { readonly extras: Sql[]; readonly clauses: Sql[] } {
    const { terms, forward } = this.#ordering(model, args);
    const { extras, order } = this.#ordered(terms);
    const located = [
      ...(predicate ? [this.predicate(predicate, true)] : []),
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
      clauses.push(
        sql`WHERE ${sql.join(
          [
            this.#distinct(
              model,
              distinct!,
              located,
              chosen.order,
              chosen.extras
            ),
            ...cursor,
          ],
          " AND "
        )}`
      );
    } else if (located.length + cursor.length > 0) {
      clauses.push(sql`WHERE ${sql.join([...located, ...cursor], " AND ")}`);
    }
    clauses.push(sql`ORDER BY ${sql.join(order, ", ")}`);
    // A bound LIMIT is what a nested read's index needs written, so both inline
    // an integer admission has already checked.
    if (args.take !== undefined)
      clauses.push(sql.raw(`LIMIT ${Math.abs(Number(args.take))}`));
    if (args.skip !== undefined)
      clauses.push(sql.raw(`START ${Number(args.skip)}`));
    return { extras, clauses };
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
    const columns = fields.map((field) => this.physical(model, field));
    const filter = where.length
      ? sql`WHERE ${sql.join(where, " AND ")} `
      : sql.raw("");
    const ordered = sql`SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${table} ${filter}ORDER BY ${sql.join(order, ", ")}`;
    const tuple = sql.join(columns, ", ");
    return sql`id IN (SELECT VALUE array::first(id) FROM (SELECT ${tuple}, id FROM (${ordered}) GROUP BY ${tuple}))`;
  }

  /** The rows from the cursor's on, in the order this read walks them. */
  #cursor(model: AnyModel, cursor: Input, terms: readonly OrderTerm[]): Sql {
    const table = name(tableOf(model));
    const located = this.predicate(
      this.#queries.prepareSelector(model, cursor, true, false).predicate!,
      true
    );
    const at = (expression: Sql) =>
      sql`(SELECT VALUE ${expression} FROM ${table} WHERE ${located} LIMIT 1)[0]`;
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
    const after = walked.reduceRight<Sql | undefined>((rest, term) => {
      const value = at(term.expression);
      const sign = sql.raw(term.descending ? "<" : ">");
      if (!rest)
        return sql`${term.expression} ${sql.raw(term.descending ? "<=" : ">=")} ${value}`;
      return sql`(${term.expression} ${sign} ${value} OR (${term.expression} = ${value} AND ${rest}))`;
    }, undefined)!;
    return sql`(array::len(SELECT VALUE id FROM ${table} WHERE ${located} LIMIT 1) > 0 AND ${after})`;
  }

  /** The caller's order, completed by the key: every page has one total order. */
  #orderTerms(model: AnyModel, input: Arguments["orderBy"]): OrderTerm[] {
    const q = this.#queries;
    const terms: OrderTerm[] = [];
    const ordered = new Set<string>();
    const orders = input === undefined ? [] : [input].flat();
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
        expression: this.physical(model, field),
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
          this.physical(model, field),
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
      expression: sql.raw(
        `${path}${this.physical(model, field).toStatement()}`
      ),
      named: path === "",
      descending: sort === "desc",
      nullable: path !== "" || state.nullable === true,
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
        expression: sql`array::len(${this.#members(edge)})`,
        named: false,
        descending: spec._count === "desc",
        nullable: false,
      };
    }
    const [nested, inner] = Object.entries(spec)[0]!;
    if (edge.many) refuse(`ordering by the relation '${field}'`);
    const prefix =
      edge.kind === "reference" && edge.owner === "source" && this.#linked(edge)
        ? `${path}${this.physical(edge.source, edge.pairs[0]!.source).toStatement()}.`
        : `(${this.#members(edge).toStatement()})[0].`;
    return edge.target["~"].state.relations[nested]
      ? this.#relationOrder(edge.target, nested, inner as Input, prefix)
      : this.#scalarOrder(edge.target, nested, inner, prefix);
  }

  /** Every member of a to-many, unfiltered, as a value. */
  #members(edge: Membership, predicate?: PreparedPredicate): Sql {
    if (edge.kind === "junction") {
      const { hop } = this.edgeOf(edge);
      const target = name(tableOf(edge.target));
      return predicate
        ? sql`${hop}(${target} WHERE ${this.predicate(predicate, true)})`
        : sql`${hop}${target}`;
    }
    return this.#traversal(reference(edge), predicate, {});
  }

  columns(prepared: PreparedProjection): Sql {
    return sql.join(
      prepared.fields.map((field) => {
        const { value, alias } = this.#field(prepared.model, field);
        return sql`${value} AS ${name(alias)}`;
      }),
      ", "
    );
  }

  /** One projected field, as a `SELECT` or a `RETURN` lists it. */
  column(model: AnyModel, field: PreparedProjectionField): Sql {
    const { value, alias } = this.#field(model, field);
    return sql`${value} AS ${name(alias)}`;
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
        return {
          // An absent field is NONE, which a row carries as no key at all.
          value: nullable ? sql`(${column} ?? NULL)` : column,
          alias: field.name,
        };
      }
      case "relation":
        return { value: this.#relation(field), alias: field.name };
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
              return sql`${name(arm.variant)}: (IF ${claim} = ${edge.discriminator!.value} { ${row} ?? {} } ELSE { NULL })`;
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
                (edge) => sql`array::len(${this.#members(edge, counted)})`
              );
              return sql`${name(count.relation)}: ${sql.join(lengths, " + ")}`;
            }),
            ", "
          )} }`,
          alias: field.name,
        };
      default:
        return refuse(`a '${field.kind}' projection`);
    }
  }

  #relation(field: Relation): Sql {
    if (field.linkRow || field.linkWhere) refuse("$through");
    if (field.recurrence) refuse("recurse");
    const { arguments: args, projection } = field;
    const members = this.#destructure(projection);
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
      if (args.selector) refuse("a filter on a to-one relation");
      return sql`(${name(this.#queries.columnName(edge.source, edge.pairs[0]!.source))}${members} ?? NULL)`;
    }
    const read = this.#traversal(edge, args.selector?.predicate, args);
    return edge.many
      ? sql`${read}${members}`
      : sql`((${read}${members})[0] ?? NULL)`;
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
      (args.distinct as string[]).map((field) => this.physical(target, field)),
      ", "
    );
    const { extras, clauses } = this.#clauses(
      target,
      { ...args, distinct: undefined },
      undefined,
      [sql.raw("id IN $first")]
    );
    return sql`(RETURN { LET $all = ${sorted}; LET $first = (SELECT VALUE array::first(id) FROM (SELECT ${tuple}, id FROM $all GROUP BY ${tuple})); RETURN (SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM $all ${sql.join(clauses, " ")})${members}; })`;
  }

  /**
   * The rows holding a link to this one: `FIELD` is what names the relation,
   * since without it `<~` reads every reference from that table.
   */
  #traversal(
    edge: Reference,
    predicate: PreparedPredicate | undefined,
    args: Pick<Arguments, "orderBy" | "take" | "skip" | "cursor" | "distinct">
  ): Sql {
    const target = edge.target;
    const linked = this.#linked(edge);
    const { extras, clauses } = this.#clauses(
      target,
      args,
      predicate,
      linked ? [] : [this.#correlated(edge)]
    );
    const read = sql`SELECT ${sql.join([sql.raw("*"), ...extras], ", ")} FROM ${name(tableOf(target))}`;
    return linked
      ? sql`<~(${read} FIELD ${name(this.#queries.columnName(target, edge.pairs[0]!.target))} ${sql.join(clauses, " ")})`
      : sql`(${read} ${sql.join(clauses, " ")})`;
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
        const conjunction = (predicate.kind === "and") === positive;
        return sql`(${sql.join(
          predicate.predicates.map((inner) =>
            this.predicate(inner, positive, path)
          ),
          conjunction ? " AND " : " OR "
        )})`;
      }
      case "not":
        return this.predicate(predicate.predicate, !positive, path);
      case "always":
        return sql.raw(predicate.value === positive ? "true" : "false");
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
    const column = sql.raw(
      `${path}${this.physical(scalar.model, scalar.field).toStatement()}`
    );
    const facts = scalar.physical.scalar["~"].state;
    if (facts.type === "json" && facts.array !== true)
      return this.#jsonOperation(predicate, column, positive);
    if (target.path) refuse("this filter target");
    const spatial = this.#spatial(predicate, column, facts);
    if (spatial) {
      const asked = positive ? spatial : sql`!(${spatial})`;
      return scalar.physical.nullable
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
        const other = sql.raw(
          `${operand.up === undefined ? path : "$parent."}${this.physical(operand.scalar.model, operand.scalar.field).toStatement()}`
        );
        if (operand.scalar.physical.nullable)
          guards.push(sql`${other} != NONE`);
        return other;
      }
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
    let test: Sql;
    if (COMPARISONS[operator]) {
      test = sql`${fold(column)} ${sql.raw(COMPARISONS[operator])} ${fold(bind(value))}`;
    } else if (FUNCTIONS[operator]) {
      // A key is a record, and its text is what a pattern reads.
      const read = this.#queries.keyOrder(scalar.model).includes(scalar.field)
        ? sql`<string>record::id(${column})`
        : column;
      test = sql`${sql.raw(FUNCTIONS[operator])}(${fold(read)}, ${fold(sql`${value}`)})`;
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
      const list = predicate.operands
        ? predicate.operands.map(operandOf)
        : (value as unknown[]);
      // An empty list asks nothing of the row, so a missing value does not matter.
      if (list.length === 0)
        return sql.raw((operator === "notIn") === positive ? "true" : "false");
      const bound = sql`[${sql.join(
        list.map((member) => fold(bind(member))),
        ", "
      )}]`;
      test = sql`${fold(column)} ${sql.raw(operator === "in" ? "IN" : "NOT IN")} ${bound}`;
    } else {
      return refuse(`the '${operator}' operator`);
    }
    const nullable = scalar.physical.nullable;
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
    const at = sql.raw(
      `${column.toStatement()}${steps.map(jsonStep).join("")}`
    );
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
          : value) as string
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
        return sql`${new RecordId(tableOf(edge.target), value as string)}`;
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
    if (predicate.closure) refuse("recurse");
    if (predicate.link) refuse("$through");
    const edge = predicate.edge;
    const { quantifier } = predicate;
    const inner = predicate.predicate;
    // As the SQL lowering's EXISTS and NOT EXISTS: a body-less `is` asks that no
    // related row exists (`author: null`), a body-less `isNot` that one does.
    const wanted =
      quantifier === "some" ||
      (quantifier === "is" && inner !== undefined) ||
      (quantifier === "isNot" && inner === undefined);
    const found = this.#related(edge, quantifier, inner, path);
    return wanted === positive ? found : sql`!(${found})`;
  }

  /** Whether a related row exists, among those the quantifier looks at. */
  #related(
    relation: Membership,
    quantifier: string,
    inner: PreparedPredicate | undefined,
    path: string
  ): Sql {
    const narrowed =
      quantifier === "every" && inner
        ? ({ kind: "not", predicate: inner } as const)
        : inner;
    if (relation.kind === "junction") {
      if (path) refuse("a to-many filter through a to-one link");
      const { hop } = this.edgeOf(relation);
      const target = name(tableOf(relation.target));
      return narrowed
        ? sql`array::len(${hop}(${target} WHERE ${this.predicate(narrowed, true)})) > 0`
        : sql`array::len(${hop}${target}) > 0`;
    }
    const edge = reference(relation);
    if (!edge.many && edge.owner === "source" && this.#linked(edge)) {
      const link = `${path}${name(this.#queries.columnName(edge.source, edge.pairs[0]!.source)).toStatement()}`;
      return inner
        ? sql`(${sql.raw(link)} != NONE AND ${this.predicate(inner, true, `${link}.`)})`
        : sql`${sql.raw(link)} != NONE`;
    }
    if (path) refuse("a to-many filter through a to-one link");
    return sql`array::len(${this.#traversal(edge, narrowed, { take: 1 })}) > 0`;
  }
}
