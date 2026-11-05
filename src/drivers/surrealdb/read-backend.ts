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
import { Sql, sql } from "@sql";
import { RecordId } from "surrealdb";

type AnyModel = PreparedProjection["model"];
type Relation = Extract<PreparedProjectionField, { kind: "relation" }>;
type Reference = Extract<Membership, { kind: "reference" }>;
type Junction = Extract<Membership, { kind: "junction" }>;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function refuse(what: string): never {
  throw new UnsupportedOperationError(
    `The SurrealDB read backend does not support ${what} yet.`
  );
}

function name(identifier: string): Sql {
  if (!IDENTIFIER.test(identifier)) refuse(`the name '${identifier}'`);
  return sql.raw(identifier);
}

function tableOf(model: AnyModel): string {
  return model["~"].names.sql!;
}

function isSingleKey(queries: Queries, model: AnyModel, field: string) {
  const keys = queries.keyOrder(model);
  return keys.length === 1 && keys[0] === field;
}

function reference(edge: Membership): Reference {
  if (edge.kind !== "reference" || edge.discriminator)
    refuse("a junction or variant relation");
  if (edge.pairs.length !== 1) refuse("a compound relation key");
  return edge;
}

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

export class SurrealReadBackend implements ReadBackend {
  readonly #queries: Queries;

  constructor(queries: Queries) {
    this.#queries = queries;
  }

  read(model: AnyModel, operation: ReadOperation, args: Arguments): Read {
    const q = this.#queries;
    const prepared = q.prepareProjection(model, args);
    switch (operation) {
      case "findUnique": {
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
        if ((args.take ?? 1) < 0) refuse("a negative take");
        const query = {
          sql: this.statement(
            model,
            prepared,
            { ...args, take: 1 },
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
        const query = {
          sql: this.statement(model, prepared, args, this.#filter(model, args)),
          shape: prepared.shape,
        };
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
    return sql.join(
      [
        sql`SELECT ${this.columns(prepared)} FROM ${from}`,
        ...this.#clauses(model, args, predicate, conditions),
      ],
      " "
    );
  }

  /** The row `identity` names, every key field equal. */
  identity(model: AnyModel, identity: Input): Sql {
    return sql.join(
      Object.entries(identity).map(
        ([field, value]) =>
          sql`${name(this.#queries.columnName(model, field))} = ${this.value(model, field, value)}`
      ),
      " AND "
    );
  }

  /** The target rows of `edge` for this parent, or those outside them. */
  member(edge: Membership, parent: Input, outside = false): Sql {
    if (edge.kind === "junction")
      return sql`id ${sql.raw(outside ? "NOT IN" : "IN")} ${this.membersOf(edge, parent)}`;
    const reached = reference(edge);
    const { source, target } = reached.pairs[0]!;
    const held = parent[source];
    if (held === null || held === undefined)
      return sql.raw(outside ? "true" : "false");
    const column = name(this.#queries.columnName(reached.target, target));
    const test = sql`${column} = ${this.value(reached.target, target, held)}`;
    return outside ? sql`!(${test})` : test;
  }

  /**
   * A generated junction as an edge table. `in` is its canonical first side, so
   * the direction does not depend on which model declared the relation, and a
   * self relation tells its two directions apart by it.
   */
  edgeOf(edge: Junction) {
    const resolved = edge.scope.edge;
    if (resolved.kind !== "junction" || edge.declared)
      refuse("a variant or declared junction");
    for (const side of [edge.sourceSide, edge.targetSide])
      if (
        side.members.length !== 1 ||
        !isSingleKey(
          this.#queries,
          side.model,
          side.members[0]!.referencedField
        )
      )
        refuse("a junction over anything but a record's own key");
    const { topology } = resolved;
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

  /** The record one side of a junction holds. */
  end(side: Junction["sourceSide"], key: unknown): Sql {
    return this.value(side.model, side.members[0]!.referencedField, key);
  }

  /** The path from one record to its members through an edge table. */
  membersOf(edge: Junction, parent: Input): Sql {
    const { hop } = this.edgeOf(edge);
    const key = parent[edge.sourceSide.members[0]!.referencedField];
    return sql`${this.end(edge.sourceSide, key)}${hop}${name(tableOf(edge.target))}`;
  }

  #clauses(
    model: AnyModel,
    args: Pick<
      Partial<Arguments>,
      "orderBy" | "take" | "skip" | "cursor" | "distinct"
    >,
    predicate: PreparedPredicate | undefined,
    conditions: readonly Sql[] = []
  ): Sql[] {
    if (args.cursor !== undefined) refuse("a cursor");
    if (args.distinct?.length) refuse("distinct");
    if ((args.take ?? 0) < 0) refuse("a negative take");
    const clauses: Sql[] = [];
    const where = [
      ...(predicate ? [this.predicate(predicate, true)] : []),
      ...conditions,
    ];
    if (where.length) clauses.push(sql`WHERE ${sql.join(where, " AND ")}`);
    clauses.push(sql`ORDER BY ${this.order(model, args.orderBy)}`);
    // A bound LIMIT is what a nested read's index needs written, so both inline
    // an integer admission has already checked.
    if (args.take !== undefined)
      clauses.push(sql.raw(`LIMIT ${Number(args.take)}`));
    if (args.skip !== undefined)
      clauses.push(sql.raw(`START ${Number(args.skip)}`));
    return clauses;
  }

  /** The caller's order, completed by the key: every page has one total order. */
  order(model: AnyModel, input: Arguments["orderBy"]): Sql {
    const q = this.#queries;
    const terms: Sql[] = [];
    const ordered = new Set<string>();
    const orders = input === undefined ? [] : [input].flat();
    for (const order of orders) {
      for (const [field, direction] of Object.entries(order)) {
        if (direction === undefined) continue;
        if (direction !== "asc" && direction !== "desc")
          refuse(`ordering by '${field}' with this specification`);
        if (model["~"].state.relations[field])
          refuse(`ordering by the relation '${field}'`);
        const physical = model["~"].state.scalars[field]?.["~"].state;
        if (physical?.nullable)
          refuse(`ordering by the nullable field '${field}'`);
        ordered.add(field);
        terms.push(
          sql`${name(q.columnName(model, field))} ${sql.raw(direction === "desc" ? "DESC" : "ASC")}`
        );
      }
    }
    for (const field of q.keyOrder(model)) {
      if (ordered.has(field)) continue;
      terms.push(sql`${name(q.columnName(model, field))} ASC`);
    }
    return sql.join(terms, ", ");
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
        const column = name(this.#queries.columnName(model, field.name));
        const nullable =
          model["~"].state.scalars[field.name]?.["~"].state.nullable;
        return {
          // An absent field is NONE, which a row carries as no key at all.
          value: nullable ? sql`(${column} ?? NULL)` : column,
          alias: field.name,
        };
      }
      case "relation":
        return { value: this.#relation(field), alias: field.name };
      default:
        return refuse(`a '${field.kind}' projection`);
    }
  }

  #relation(field: Relation): Sql {
    if (field.linkRow || field.linkWhere) refuse("$through");
    if (field.recurrence) refuse("recurse");
    const { arguments: args, projection } = field;
    const members = this.#destructure(projection);
    if (field.edge.kind === "junction") {
      const { hop } = this.edgeOf(field.edge);
      const target = field.edge.target;
      return sql`${hop}(SELECT * FROM ${name(tableOf(target))} ${sql.join(this.#clauses(target, args, args.selector?.predicate), " ")})${members}`;
    }
    const edge = reference(field.edge);
    if (!edge.many && edge.owner === "source") {
      if (args.selector) refuse("a filter on a to-one relation");
      return sql`(${name(this.#queries.columnName(edge.source, edge.pairs[0]!.source))}${members} ?? NULL)`;
    }
    const read = this.#traversal(edge, args.selector?.predicate, args);
    return edge.many
      ? sql`${read}${members}`
      : sql`((${read}${members})[0] ?? NULL)`;
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
    const holder = name(
      this.#queries.columnName(target, edge.pairs[0]!.target)
    );
    return sql`<~(SELECT * FROM ${name(tableOf(target))} FIELD ${holder} ${sql.join(this.#clauses(target, args, predicate), " ")})`;
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
    if (target.kind !== "column" || target.path) refuse("this filter target");
    const { scalar } = target;
    const column = sql.raw(
      `${path}${name(this.#queries.columnName(scalar.model, scalar.field)).toStatement()}`
    );
    const bind = (value: unknown): Sql =>
      this.value(scalar.model, scalar.field, value);
    const operandOf = (
      operand: NonNullable<typeof predicate.operand>
    ): unknown => {
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
      test = sql`${sql.raw(FUNCTIONS[operator])}(${fold(column)}, ${fold(bind(value))})`;
    } else if (operator === "in" || operator === "notIn") {
      const list = predicate.operands
        ? predicate.operands.map(operandOf)
        : (value as unknown[]);
      const bound = sql`[${sql.join(
        list.map((member) => bind(member)),
        ", "
      )}]`;
      test = sql`${column} ${sql.raw(operator === "in" ? "IN" : "NOT IN")} ${bound}`;
    } else {
      return refuse(`the '${operator}' operator`);
    }
    const nullable = scalar.physical.nullable;
    const asked = positive ? test : sql`!(${test})`;
    return nullable ? sql`(${column} != NONE AND ${asked})` : asked;
  }

  /** A key or a link is a record: its value is bound as one, never as a string. */
  value(model: AnyModel, field: string, value: unknown): Sql {
    // A value this statement reads for itself ({@link SurrealQueries.locatedValue}).
    if (value instanceof Sql) return value;
    const q = this.#queries;
    if (isSingleKey(q, model, field))
      return sql`${new RecordId(tableOf(model), value as string)}`;
    for (const slot of Object.keys(model["~"].state.relations)) {
      const { edges } = q.countedMemberships(model, slot);
      const edge = edges[0];
      if (
        edges.length === 1 &&
        edge?.kind === "reference" &&
        edge.owner === "source" &&
        edge.pairs.length === 1 &&
        edge.pairs[0]!.source === field
      )
        return sql`${new RecordId(tableOf(edge.target), value as string)}`;
    }
    // Admission hands a datetime over as text, which a `datetime` field refuses.
    return model["~"].state.scalars[field]?.["~"].state.type === "datetime"
      ? sql`${new Date(value as string)}`
      : sql`${value}`;
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
    if (!edge.many && edge.owner === "source") {
      const link = `${path}${name(this.#queries.columnName(edge.source, edge.pairs[0]!.source)).toStatement()}`;
      return inner
        ? sql`(${sql.raw(link)} != NONE AND ${this.predicate(inner, true, `${link}.`)})`
        : sql`${sql.raw(link)} != NONE`;
    }
    if (path) refuse("a to-many filter through a to-one link");
    return sql`array::len(${this.#traversal(edge, narrowed, { take: 1 })}) > 0`;
  }
}
