import type { DatabaseAdapter } from "@adapters/database-adapter";
import { assembleAdapterSelect } from "@adapters/adapter-internals";
import { QueryEngineError } from "@errors";
import { findAddressableKey, type AnyModel } from "@schema/model";
import { Sql, sql } from "@sql";
import {
  decodePhysicalDecimal,
  materializePhysicalDecimal,
  type DecimalDescriptor,
} from "@validation/primitives/decimal-codec";
import {
  type Arguments,
  type EngineSchema,
  type Input,
  record,
  entries,
} from "./schema";
import {
  bindMembership,
  type Membership,
  physicalField,
  storedFields,
} from "./storage";

type Leaf = {
  kind: "scalar";
  type: string;
  nullable: boolean;
  decimal?: DecimalDescriptor;
};
type Shape =
  | { kind: "object"; fields: Record<string, Shape | Leaf> }
  | { kind: "collection"; row: Shape }
  | { kind: "variants"; many: boolean; arms: Record<string, Shape> }
  | {
      kind: "recursive";
      relation: string;
      many: boolean;
      seeds: Shape[];
      descendant: Shape;
      carriers: {
        seed: string;
        depth: string;
        path: string;
        value: string;
      };
    };
export interface Query {
  sql: Sql;
  shape: Shape;
  expectedRows?: {
    readonly count: number;
    readonly missing: string;
  };
}
export interface SelectorFacts {
  fields: Set<string>;
  equals: Map<string, unknown>;
  exact: boolean;
  reads: SelectorRead[];
}
export interface SelectorRead {
  readonly model: AnyModel;
  readonly path: readonly Membership[];
  readonly fields: Set<string>;
  readonly equals: Map<string, unknown>;
  readonly exact: boolean;
}
export type TraversalArgs = Partial<
  Pick<Arguments, "where" | "select" | "include" | "orderBy">
>;
export interface RecursiveTraversal {
  readonly seeds: readonly { readonly args: TraversalArgs }[];
  readonly relation: string;
  readonly depth: number;
  readonly args?: TraversalArgs;
}

/** The decoder identifies the invalid value; its operation owns public errors. */
export class InvalidScalarResult extends TypeError {
  constructor(
    readonly scalarType: string,
    readonly reason: string,
  ) {
    super(`Invalid provider ${scalarType === "int" ? "integer" : scalarType}`);
  }
}

/** Query scopes and output shapes share no record-identity requirement. */
export class Queries {
  private nextAlias = 0;
  constructor(
    readonly schema: EngineSchema,
    readonly adapter: DatabaseAdapter,
  ) {}
  alias(): string {
    return `q${this.nextAlias++}`;
  }
  table(model: AnyModel, alias?: string): Sql {
    return this.adapter.identifiers.table(model["~"].names.sql!, alias);
  }
  column(model: AnyModel, field: string, alias?: string): Sql {
    const name = this.columnName(model, field);
    return alias
      ? this.adapter.identifiers.column(alias, name)
      : this.adapter.identifiers.escape(name);
  }
  columnName(model: AnyModel, field: string): string {
    const physical = physicalField(this.schema, model, field);
    const state = physical.scalar["~"].state;
    if (
      state.array ||
      (state.type !== "int" &&
        state.type !== "string" &&
        state.type !== "decimal")
    ) {
      throw new Error(
        `Raptor 3 G1 scalar codec is not implemented: ${state.type}${state.array ? "[]" : ""}`,
      );
    }
    return physical.name;
  }
  value(value: unknown): Sql {
    return value instanceof Sql ? value : this.adapter.literals.value(value);
  }
  fieldValue(model: AnyModel, field: string, value: unknown): Sql {
    const state = physicalField(this.schema, model, field).scalar["~"].state;
    if (state.type !== "decimal" || value === null) return this.value(value);
    return value instanceof Sql
      ? this.adapter.expressions.decimalCast(value, state.decimal)
      : this.adapter.literals.decimal(value as string, state.decimal);
  }
  projectedColumn(model: AnyModel, field: string, alias?: string): Sql {
    const column = this.column(model, field, alias);
    return physicalField(this.schema, model, field).scalar["~"].state.type ===
      "decimal"
      ? this.adapter.expressions.cast(column, "text")
      : column;
  }
  private scalarShape(model: AnyModel, field: string): Leaf {
    const physical = physicalField(this.schema, model, field);
    const state = physical.scalar["~"].state;
    return {
      kind: "scalar",
      type: state.type,
      nullable: physical.nullable,
      decimal: state.type === "decimal" ? state.decimal : undefined,
    };
  }
  junctionWhere(
    edge: Extract<Membership, { kind: "junction" }>,
    values: Input,
    alias?: string,
  ): Sql {
    return this.adapter.operators.and(
      ...[edge.sourceSide, edge.targetSide].flatMap((side) =>
        side.members
          .filter((pair) => Object.hasOwn(values, pair.junctionField))
          .map((pair) =>
            this.adapter.operators.eq(
              alias
                ? this.adapter.identifiers.column(alias, pair.junctionField)
                : this.adapter.identifiers.escape(pair.junctionField),
              this.fieldValue(
                side.model,
                pair.referencedField,
                values[pair.junctionField],
              ),
            ),
          ),
      ),
    );
  }
  junction(
    edge: Extract<Membership, { kind: "junction" }>,
    values: Input,
    forUpdate = false,
  ): Query {
    const a = this.adapter;
    const alias = this.alias();
    const owner =
      edge.uniqueSide === "target" ? edge.sourceSide : edge.targetSide;
    const fields: Record<string, Leaf> = {};
    const columns = owner.members.map((pair) => {
      const shape = this.scalarShape(owner.model, pair.referencedField);
      fields[pair.junctionField] = shape;
      const column = a.identifiers.column(alias, pair.junctionField);
      return a.identifiers.aliased(
        shape.type === "decimal" ? a.expressions.cast(column, "text") : column,
        pair.junctionField,
      );
    });
    return {
      sql: assembleAdapterSelect(a, {
        columns: sql.join(columns, ", "),
        from: a.identifiers.table(edge.table, alias),
        where: this.junctionWhere(edge, values, alias),
        forUpdate,
      }),
      shape: { kind: "object", fields },
    };
  }
  updateValue(
    model: AnyModel,
    field: string,
    value: unknown,
    before = this.column(model, field),
  ): Sql {
    if (
      !(value instanceof Sql) &&
      value !== null &&
      typeof value === "object"
    ) {
      const operation = record(value);
      if ("increment" in operation)
        return this.adapter.expressions.add(
          physicalField(this.schema, model, field).scalar["~"].state.type ===
            "int"
            ? this.adapter.expressions.cast(before, "integer")
            : before,
          this.fieldValue(model, field, operation.increment),
        );
      if ("set" in operation)
        return this.fieldValue(model, field, operation.set);
      throw new Error(
        `Raptor 3 G1 update operator is not implemented: ${Object.keys(operation).join(", ")}`,
      );
    }
    return this.fieldValue(model, field, value);
  }
  predicate(
    expression: Sql,
    value: unknown,
    model?: AnyModel,
    field?: string,
    facts?: SelectorFacts,
  ): Sql {
    if (facts && field) {
      facts.fields.add(field);
      if (
        value === null ||
        (typeof value !== "object" && !(value instanceof Sql))
      )
        facts.equals.set(field, value);
      else if (
        !(value instanceof Sql) &&
        Object.keys(record(value)).length === 1 &&
        "equals" in record(value)
      )
        facts.equals.set(field, record(value).equals);
      else facts.exact = false;
    }
    const { operators: op } = this.adapter;
    const operandSql = (operand: unknown) =>
      model && field
        ? this.fieldValue(model, field, operand)
        : this.value(operand);
    if (value === null) return op.isNull(expression);
    if (value instanceof Sql || typeof value !== "object")
      return op.eq(expression, operandSql(value));
    return op.and(
      ...Object.entries(record(value)).map(([name, operand]) => {
        switch (name) {
          case "equals":
            return this.predicate(expression, operand, model, field);
          case "in":
            return op.in(
              expression,
              this.adapter.literals.list(
                (operand as unknown[]).map(operandSql),
              ),
            );
          case "gte":
            return op.gte(expression, operandSql(operand));
          case "gt":
            return op.gt(expression, operandSql(operand));
          case "lte":
            return op.lte(expression, operandSql(operand));
          case "lt":
            return op.lt(expression, operandSql(operand));
          case "not":
            return op.not(this.predicate(expression, operand, model, field));
          default:
            throw new Error(`Raptor 3 G1 filter is not implemented: ${name}`);
        }
      }),
    );
  }
  where(
    model: AnyModel,
    where: Input | undefined,
    alias?: string,
    facts?: SelectorFacts,
    path: readonly Membership[] = [],
  ): Sql | undefined {
    if (!where) return undefined;
    return this.adapter.operators.and(
      ...Object.entries(where).map(([field, operand]) => {
        if (field === "AND" || field === "OR") {
          if (field === "OR" && facts) facts.exact = false;
          const conditions = entries(operand).map((clause) =>
            this.where(model, clause, alias, facts, path)!,
          );
          return field === "AND"
            ? this.adapter.operators.and(...conditions)
            : this.adapter.operators.or(...conditions);
        }
        if (field === "NOT") {
          if (facts) facts.exact = false;
          return this.adapter.operators.not(
            this.where(model, record(operand), alias, facts, path)!,
          );
        }
        if (model["~"].state.relations[field]) {
          const edge = bindMembership(this.schema, model, field);
          return this.relationWhere(edge, operand, alias, facts, [
            ...path,
            edge,
          ]);
        }
        const key = findAddressableKey(model, field);
        if (key?.name)
          return this.adapter.operators.and(
            ...key.fields.map((member) =>
              this.predicate(
                this.column(model, member, alias),
                record(operand)[member],
                model,
                member,
                facts,
              ),
            ),
          );
        return this.predicate(
          this.column(model, field, alias),
          operand,
          model,
          field,
          facts,
        );
      }),
    );
  }
  selectorFacts(model: AnyModel, where?: Input): SelectorFacts {
    const facts: SelectorFacts = {
      fields: new Set(),
      equals: new Map(),
      exact: true,
      reads: [],
    };
    this.where(model, where, undefined, facts);
    return facts;
  }
  private relationWhere(
    edge: Membership,
    operand: unknown,
    parentAlias: string | undefined,
    facts: SelectorFacts | undefined,
    path: readonly Membership[],
  ): Sql {
    const a = this.adapter;
    const childAlias = this.alias();
    const relation = record(operand);
    return a.operators.and(
      ...Object.entries(relation).map(([quantifier, value]) => {
        const nestedFacts: SelectorFacts | undefined = facts
          ? {
              fields: new Set(),
              equals: new Map(),
              exact:
                facts.exact &&
                quantifier !== "none" &&
                quantifier !== "every" &&
                quantifier !== "isNot",
              reads: [],
            }
          : undefined;
        const nested =
          value === null
            ? undefined
            : this.where(
                edge.target,
                record(value),
                childAlias,
                nestedFacts,
                path,
              );
        if (facts && nestedFacts) {
          facts.reads.push({
            model: edge.target,
            path,
            fields: nestedFacts.fields,
            equals: nestedFacts.equals,
            exact: nestedFacts.exact,
          });
          facts.reads.push(...nestedFacts.reads);
        }
        const correlated = this.correlation(
          edge,
          parentAlias ?? "",
          childAlias,
        );
        const condition = a.operators.and(
          correlated,
          ...(nested
            ? [quantifier === "every" ? a.operators.not(nested) : nested]
            : []),
        );
        const query = a.subqueries.existsCheck(
          this.table(edge.target, childAlias),
          condition,
        );
        switch (quantifier) {
          case "some":
            return a.filters.some(query);
          case "none":
            return a.filters.none(query);
          case "every":
            return a.filters.every(query);
          case "is":
            return value === null
              ? a.filters.isNot(query)
              : a.filters.is(query);
          case "isNot":
            return value === null
              ? a.filters.is(query)
              : a.filters.isNot(query);
          default:
            throw new Error(
              `Raptor 3 G3P-05 relation filter is not implemented: ${quantifier}`,
            );
        }
      }),
    );
  }
  correlation(edge: Membership, parent: string, target: string): Sql {
    return this.membershipWhere(edge, target, parent);
  }
  memberWhere(edge: Membership, parent: Input, alias: string): Sql {
    return this.membershipWhere(edge, alias, parent);
  }
  private membershipWhere(
    edge: Membership,
    target: string,
    source: string | Input,
  ): Sql {
    const a = this.adapter;
    if (edge.kind === "reference") {
      return a.operators.and(
        ...(edge.discriminator
          ? [
              a.operators.eq(
                edge.discriminator.side === "source"
                  ? typeof source === "string"
                    ? this.column(edge.source, edge.discriminator.field, source)
                    : this.value(source[edge.discriminator.field])
                  : this.column(edge.target, edge.discriminator.field, target),
                this.value(edge.discriminator.value),
              ),
            ]
          : []),
        ...edge.pairs.map((pair) =>
          a.operators.eq(
            typeof source === "string"
              ? this.column(edge.source, pair.source, source)
              : this.column(edge.target, pair.target, target),
            typeof source === "string"
              ? this.column(edge.target, pair.target, target)
              : this.fieldValue(edge.target, pair.target, source[pair.source]),
          ),
        ),
      );
    }
    const junction = this.alias();
    const conditions = [
      ...edge.sourceSide.members.map((pair) =>
        a.operators.eq(
          a.identifiers.column(junction, pair.junctionField),
          typeof source === "string"
            ? this.column(edge.source, pair.referencedField, source)
            : this.fieldValue(
                edge.source,
                pair.referencedField,
                source[pair.referencedField],
              ),
        ),
      ),
      ...edge.targetSide.members.map((pair) =>
        a.operators.eq(
          a.identifiers.column(junction, pair.junctionField),
          this.column(edge.target, pair.referencedField, target),
        ),
      ),
    ];
    return a.filters.some(
      a.subqueries.existsCheck(
        a.identifiers.table(edge.table, junction),
        a.operators.and(...conditions),
      ),
    );
  }
  order(
    model: AnyModel,
    input: Arguments["orderBy"],
    alias: string,
  ): Sql | undefined {
    if (!input) return undefined;
    return sql.join(
      this.orderTerms(model, input, alias).map(({ expression, descending }) =>
        descending
          ? this.adapter.orderBy.desc(expression)
          : this.adapter.orderBy.asc(expression),
      ),
      ", ",
    );
  }
  private orderTerms(
    model: AnyModel,
    input: Arguments["orderBy"],
    alias: string,
  ): { readonly expression: Sql; readonly descending: boolean }[] {
    if (!input) return [];
    return entries(input).flatMap((order) =>
      Object.entries(order).map(([field, direction]) => ({
        expression: this.column(model, field, alias),
        descending: direction === "desc",
      })),
    );
  }
  select(
    model: AnyModel,
    args: Partial<Arguments>,
    membership?: { edge: Membership; parent: Input },
    controls: { condition?: Sql; forUpdate?: boolean } = {},
  ): Query {
    const alias = this.alias();
    const projection = this.project(model, args, alias);
    const filter = this.where(model, args.where, alias);
    return {
      sql: assembleAdapterSelect(this.adapter, {
        columns: sql.join(projection.columns, ", "),
        from: this.table(model, alias),
        where: this.adapter.operators.and(
          ...(membership
            ? [this.memberWhere(membership.edge, membership.parent, alias)]
            : []),
          ...(filter ? [filter] : []),
          ...(controls.condition ? [controls.condition] : []),
        ),
        orderBy: this.order(model, args.orderBy, alias),
        limit: args.take === undefined ? undefined : this.value(args.take),
        offset: args.skip === undefined ? undefined : this.value(args.skip),
        forUpdate: controls.forUpdate,
      }),
      shape: projection.shape,
    };
  }
  selectSeries(model: AnyModel, select: Input, identities: Input[]): Query {
    const alias = this.alias();
    const projection = this.project(model, { select }, alias);
    const predicates = identities.map((identity) =>
      this.where(model, identity, alias)!,
    );
    return {
      sql: assembleAdapterSelect(this.adapter, {
        columns: sql.join(projection.columns, ", "),
        from: this.table(model, alias),
        where: this.adapter.operators.or(...predicates),
        orderBy: this.adapter.expressions.caseWhen(
          predicates.map((when, index) => ({
            when,
            then: this.value(index),
          })),
          this.value(identities.length),
        ),
      }),
      shape: projection.shape,
      expectedRows: {
        count: identities.length,
        missing:
          "createMany with 'select' could not read back one of the created rows at the primary key it reported. A later row in the same call moved that row's primary key; use the '{ count }' form, or write those rows in separate calls.",
      },
    };
  }
  recursive(model: AnyModel, traversal: RecursiveTraversal): Query {
    if (traversal.seeds.length === 0)
      throw new Error("A recursive traversal requires at least one seed");
    const resolved = this.schema.index.get(model)!.get(traversal.relation);
    if (
      !resolved ||
      resolved.edge.kind === "variantRowCarrier" ||
      resolved.edge.kind === "variantJunctionCarrier"
    )
      throw new Error(
        `Raptor 3 recursive traversal requires one ordinary relation: ${traversal.relation}`,
      );
    const edge = bindMembership(this.schema, model, traversal.relation);
    if (edge.target !== model)
      throw new Error(
        `Raptor 3 recursive traversal relation '${traversal.relation}' is not self-referential`,
      );
    const a = this.adapter;
    const cteName = this.alias();
    const occupied = new Set(
      storedFields(this.schema, model).map((field) =>
        this.columnName(model, field),
      ),
    );
    const carrier = (base: string) => {
      let name = `__${cteName}_${base}`;
      while (occupied.has(name)) name = `_${name}`;
      occupied.add(name);
      return name;
    };
    const carriers = {
      seed: carrier("seed"),
      depth: carrier("depth"),
      path: carrier("path"),
      value: carrier("value"),
    };
    const withoutRelation = (args: TraversalArgs): TraversalArgs => ({
      ...args,
      ...(args.select
        ? {
            select: Object.fromEntries(
              Object.entries(args.select).filter(
                ([field]) => field !== traversal.relation,
              ),
            ),
          }
        : {}),
      ...(args.include
        ? {
            include: Object.fromEntries(
              Object.entries(args.include).filter(
                ([field]) => field !== traversal.relation,
              ),
            ),
          }
        : {}),
    });
    const identityDocument = (alias: string) =>
      a.json.object(
        this.schema
          .keys(model)
          .map((field) => [field, this.projectedColumn(model, field, alias)]),
      );
    const projectedDocument = (projection: {
      readonly entries: [string, Sql][];
      readonly shape: Shape;
    }) =>
      a.json.object(
        projection.entries.map(([field, expression]) => [
          field,
          projection.shape.kind === "object" &&
          projection.shape.fields[field]!.kind !== "scalar"
            ? a.json.document(expression)
            : expression,
        ]),
      );
    const carried = (alias: string) =>
      storedFields(this.schema, model).map((field) =>
        a.identifiers.aliased(
          this.column(model, field, alias),
          this.columnName(model, field),
        ),
      );
    const seedShapes: Shape[] = [];
    const anchors = traversal.seeds.map((seed, index) => {
      const alias = this.alias();
      const args = withoutRelation(seed.args);
      const projection = this.project(model, args, alias);
      seedShapes.push(projection.shape);
      return assembleAdapterSelect(a, {
        columns: sql.join(
          [
            a.identifiers.aliased(this.value(index), carriers.seed),
            a.identifiers.aliased(this.value(0), carriers.depth),
            a.identifiers.aliased(
              a.arrays.literal([a.json.document(identityDocument(alias))]),
              carriers.path,
            ),
            a.identifiers.aliased(
              projectedDocument(projection),
              carriers.value,
            ),
            ...carried(alias),
          ],
          ", ",
        ),
        from: this.table(model, alias),
        where: this.where(model, args.where, alias),
      });
    });
    const childAlias = this.alias();
    const walkAlias = this.alias();
    const descendantArgs = withoutRelation(traversal.args ?? {});
    const descendant = this.project(model, descendantArgs, childAlias);
    const walkColumn = (name: string) => a.identifiers.column(walkAlias, name);
    const childIdentity = identityDocument(childAlias);
    const recursive = assembleAdapterSelect(a, {
      columns: sql.join(
        [
          a.identifiers.aliased(walkColumn(carriers.seed), carriers.seed),
          a.identifiers.aliased(
            a.expressions.add(walkColumn(carriers.depth), this.value(1)),
            carriers.depth,
          ),
          a.identifiers.aliased(
            a.arrays.push(
              walkColumn(carriers.path),
              a.json.document(childIdentity),
            ),
            carriers.path,
          ),
          a.identifiers.aliased(projectedDocument(descendant), carriers.value),
          ...carried(childAlias),
        ],
        ", ",
      ),
      from: sql`${this.table(model, childAlias)} ${a.joins.inner(
        a.identifiers.aliased(a.identifiers.escape(cteName), walkAlias),
        this.correlation(edge, walkAlias, childAlias),
      )}`,
      where: a.operators.and(
        a.operators.lt(walkColumn(carriers.depth), this.value(traversal.depth)),
        ...(descendantArgs.where
          ? [this.where(model, descendantArgs.where, childAlias)!]
          : []),
        a.operators.not(
          a.arrays.has(
            walkColumn(carriers.path),
            a.json.document(childIdentity),
          ),
        ),
      ),
    });
    const finalAlias = this.alias();
    const finalColumn = (name: string) =>
      a.identifiers.column(finalAlias, name);
    const rootOrder = traversal.seeds.flatMap((seed, index) =>
      this.orderTerms(model, seed.args.orderBy, finalAlias).map(
        ({ expression, descending }) => {
          const selected = a.expressions.caseWhen(
            [
              {
                when: a.operators.and(
                  a.operators.eq(finalColumn(carriers.seed), this.value(index)),
                  a.operators.eq(finalColumn(carriers.depth), this.value(0)),
                ),
                then: expression,
              },
            ],
            this.value(null),
          );
          return descending
            ? a.orderBy.desc(selected)
            : a.orderBy.asc(selected);
        },
      ),
    );
    const siblingOrder = this.order(model, descendantArgs.orderBy, finalAlias);
    const final = assembleAdapterSelect(a, {
      columns: sql.join(
        Object.values(carriers).map((name) =>
          a.identifiers.aliased(finalColumn(name), name),
        ),
        ", ",
      ),
      from: a.identifiers.aliased(a.identifiers.escape(cteName), finalAlias),
      orderBy: sql.join(
        [
          a.orderBy.asc(finalColumn(carriers.seed)),
          a.orderBy.asc(finalColumn(carriers.depth)),
          ...rootOrder,
          ...(siblingOrder ? [siblingOrder] : []),
          ...this.schema
            .keys(model)
            .map((field) =>
              a.orderBy.asc(this.column(model, field, finalAlias)),
            ),
        ],
        ", ",
      ),
    });
    return {
      sql: sql`${a.cte.recursive(
        cteName,
        a.setOperations.unionAll(...anchors),
        recursive,
      )} ${final}`,
      shape: {
        kind: "recursive",
        relation: traversal.relation,
        many: edge.many,
        seeds: seedShapes,
        descendant: descendant.shape,
        carriers,
      },
    };
  }
  private project(
    model: AnyModel,
    args: Partial<Arguments>,
    alias: string,
  ): { columns: Sql[]; entries: [string, Sql][]; shape: Shape } {
    const a = this.adapter;
    const selected = args.select ?? {
      ...Object.fromEntries(
        model["~"].scalarFieldNames
          .filter((field) => !model["~"].state.omit?.[field])
          .map((field) => [field, true]),
      ),
      ...args.include,
    };
    const columns: Sql[] = [];
    const projected: [string, Sql][] = [];
    const fields: Record<string, Shape | Leaf> = {};
    for (const [name, selection] of Object.entries(selected)) {
      if (!selection) continue;
      if (!model["~"].state.relations[name]) {
        const expression = this.projectedColumn(model, name, alias);
        columns.push(a.identifiers.aliased(expression, name));
        projected.push([name, expression]);
        fields[name] = this.scalarShape(model, name);
        continue;
      }
      const resolved = this.schema.index.get(model)!.get(name)!;
      if (
        !resolved.member &&
        (resolved.edge.kind === "variantRowCarrier" ||
          resolved.edge.kind === "variantJunctionCarrier")
      ) {
        const many = resolved.edge.kind === "variantJunctionCarrier";
        const configuration = selection === true ? {} : record(selection);
        const only = configuration.only as string[] | undefined;
        const arms: Record<string, Shape> = {};
        const expressions: [string, Sql][] = [];
        for (const member of resolved.edge.members) {
          if (
            many
              ? only && !only.includes(member.variant)
              : selection !== true &&
                configuration[member.variant] === undefined
          )
            continue;
          const arm = many
            ? record(configuration.variants ?? {})[member.variant]
            : configuration[member.variant];
          const nested = this.relationProjection(
            bindMembership(this.schema, model, name, member.variant),
            arm === undefined ? true : arm,
            alias,
          );
          arms[member.variant] = nested.shape;
          expressions.push([
            member.variant,
            a.json.document(nested.expression),
          ]);
        }
        const expression = a.json.object(expressions);
        columns.push(a.identifiers.aliased(expression, name));
        projected.push([name, expression]);
        fields[name] = { kind: "variants", many, arms };
        continue;
      }
      const nested = this.relationProjection(
        bindMembership(this.schema, model, name),
        selection,
        alias,
      );
      columns.push(a.identifiers.aliased(nested.expression, name));
      projected.push([name, nested.expression]);
      fields[name] = nested.shape;
    }
    return { columns, entries: projected, shape: { kind: "object", fields } };
  }
  private relationProjection(
    edge: Membership,
    selection: unknown,
    alias: string,
  ): { expression: Sql; shape: Shape } {
    const a = this.adapter;
    const nested =
      selection === true ? {} : (record(selection) as Partial<Arguments>);
    const childAlias = this.alias();
    const child = this.project(edge.target, nested, childAlias);
    const childFields =
      child.shape.kind === "object" ? Object.keys(child.shape.fields) : [];
    const page = assembleAdapterSelect(a, {
      columns: sql.join(child.columns, ", "),
      from: this.table(edge.target, childAlias),
      where: a.operators.and(
        this.correlation(edge, alias, childAlias),
        ...(nested.where
          ? [this.where(edge.target, nested.where, childAlias)!]
          : []),
      ),
      orderBy: this.order(edge.target, nested.orderBy, childAlias),
      limit: !edge.many
        ? this.value(1)
        : nested.take === undefined
          ? undefined
          : this.value(nested.take),
      offset: nested.skip === undefined ? undefined : this.value(nested.skip),
    });
    const pageAlias = this.alias();
    const object = a.json.object(
      childFields.map((field) => [
        field,
        child.shape.kind === "object" &&
        child.shape.fields[field]!.kind !== "scalar"
          ? a.json.document(a.identifiers.column(pageAlias, field))
          : a.identifiers.column(pageAlias, field),
      ]),
    );
    const expression = a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: edge.many
          ? a.expressions.coalesce(a.json.agg(object), a.json.emptyArray())
          : object,
        from: a.subqueries.correlate(page, pageAlias),
      }),
    );
    const shape: Shape = edge.many
      ? { kind: "collection", row: child.shape }
      : child.shape;
    return { expression, shape };
  }
  grouped(model: AnyModel, args: Arguments): Query {
    const a = this.adapter;
    const alias = this.alias();
    const columns: Sql[] = [];
    const fields: Record<string, Shape | Leaf> = {};
    for (const field of args.by!) {
      columns.push(
        a.identifiers.aliased(this.column(model, field, alias), field),
      );
      fields[field] = {
        kind: "scalar",
        type: model["~"].state.scalars[field]!["~"].state.type,
        nullable: false,
      };
    }
    if (args._count) {
      columns.push(a.identifiers.aliased(a.aggregates.count(), "_count"));
      fields._count = { kind: "scalar", type: "int", nullable: false };
    }
    for (const aggregate of ["_sum", "_min", "_max", "_avg"] as const) {
      if (!args[aggregate]) continue;
      const nested: Record<string, Leaf> = {};
      const pairs: [string, Sql][] = Object.keys(record(args[aggregate])).map(
        (field) => {
          nested[field] = {
            kind: "scalar",
            type: aggregate === "_avg" ? "float" : "int",
            nullable: true,
          };
          return [
            field,
            this.aggregate(aggregate, this.column(model, field, alias)),
          ];
        },
      );
      fields[aggregate] = { kind: "object", fields: nested };
      columns.push(a.identifiers.aliased(a.json.object(pairs), aggregate));
    }
    const having = args.having
      ? a.operators.and(
          ...Object.entries(args.having).flatMap(([field, aggregates]) =>
            Object.entries(record(aggregates)).map(([aggregate, condition]) =>
              this.predicate(
                this.aggregate(aggregate, this.column(model, field, alias)),
                condition,
              ),
            ),
          ),
        )
      : undefined;
    return {
      sql: assembleAdapterSelect(a, {
        columns: sql.join(columns, ", "),
        from: this.table(model, alias),
        where: this.where(model, args.where, alias),
        groupBy: sql.join(
          args.by!.map((field) => this.column(model, field, alias)),
          ", ",
        ),
        having,
        orderBy: this.order(model, args.orderBy, alias),
        limit: args.take === undefined ? undefined : this.value(args.take),
        offset: args.skip === undefined ? undefined : this.value(args.skip),
      }),
      shape: { kind: "object", fields },
    };
  }
  private aggregate(name: string, column: Sql): Sql {
    switch (name) {
      case "_sum":
        return this.adapter.aggregates.sum(column);
      case "_min":
        return this.adapter.aggregates.min(column);
      case "_max":
        return this.adapter.aggregates.max(column);
      case "_avg":
        return this.adapter.aggregates.avg(column);
      case "_count":
        return this.adapter.aggregates.count(column);
      default:
        throw new Error(`Raptor 3 G1 aggregate is not implemented: ${name}`);
    }
  }
  decode(query: Query, rows: Input[], internal = false): Input[] {
    if (query.shape.kind === "recursive")
      return this.decodeRecursive(query.shape, rows, internal);
    if (query.expectedRows && rows.length < query.expectedRows.count)
      throw new QueryEngineError(query.expectedRows.missing);
    if (query.expectedRows && rows.length > query.expectedRows.count)
      throw new QueryEngineError(
        "Raptor 3 createMany final read returned inconsistent row counts.",
      );
    return rows.map(
      (row) => this.decodeValue(query.shape, row, internal) as Input,
    );
  }
  private decodeRecursive(
    shape: Extract<Shape, { kind: "recursive" }>,
    rows: Input[],
    internal: boolean,
  ): Input[] {
    const roots: Input[] = [];
    const occurrences = new Map<string, Input>();
    for (const row of rows) {
      const rawSeed = row[shape.carriers.seed];
      const rawDepth = row[shape.carriers.depth];
      const seed = typeof rawSeed === "bigint" ? Number(rawSeed) : rawSeed;
      const depth = typeof rawDepth === "bigint" ? Number(rawDepth) : rawDepth;
      if (
        typeof seed !== "number" ||
        typeof depth !== "number" ||
        !Number.isSafeInteger(seed) ||
        !Number.isSafeInteger(depth)
      )
        throw new TypeError("Invalid provider recursive occurrence");
      const rawPath = row[shape.carriers.path];
      const path = typeof rawPath === "string" ? JSON.parse(rawPath) : rawPath;
      if (!Array.isArray(path))
        throw new TypeError("Invalid provider recursive path");
      const occurrenceShape =
        depth === 0 ? shape.seeds[seed] : shape.descendant;
      if (!occurrenceShape)
        throw new TypeError("Invalid provider recursive seed");
      const decoded = this.decodeValue(
        occurrenceShape,
        row[shape.carriers.value],
        internal,
      );
      if (
        decoded === null ||
        typeof decoded !== "object" ||
        Array.isArray(decoded)
      )
        throw new TypeError("Invalid provider recursive row");
      const occurrence = record(decoded);
      occurrence[shape.relation] = shape.many ? [] : null;
      const pathKey = `${seed}:${JSON.stringify(path)}`;
      occurrences.set(pathKey, occurrence);
      if (depth === 0) {
        roots.push(occurrence);
        continue;
      }
      const parent = occurrences.get(
        `${seed}:${JSON.stringify(path.slice(0, -1))}`,
      );
      if (!parent)
        throw new TypeError("Invalid provider recursive parent occurrence");
      if (shape.many) {
        const children = parent[shape.relation];
        if (!Array.isArray(children))
          throw new TypeError("Invalid provider recursive collection");
        children.push(occurrence);
      } else parent[shape.relation] = occurrence;
    }
    return roots;
  }
  private decodeValue(
    shape: Shape | Leaf,
    value: unknown,
    internal: boolean,
  ): unknown {
    if (shape.kind === "scalar") {
      if (value === null && shape.nullable) return null;
      if (shape.type === "decimal") {
        const representation =
          this.adapter.result.decimalRepresentation ?? "text";
        const decoded = internal
          ? decodePhysicalDecimal(value, shape.decimal!, representation)
          : materializePhysicalDecimal(value, shape.decimal!, representation);
        if (decoded === undefined)
          throw new InvalidScalarResult(
            "decimal",
            "the value is not an exact decimal in this column's declared domain",
          );
        return decoded;
      }
      if (shape.type === "int") {
        const number = typeof value === "bigint" ? Number(value) : value;
        if (typeof number !== "number" || !Number.isSafeInteger(number))
          throw new InvalidScalarResult(
            "int",
            "the value is not a canonical integer",
          );
        return number;
      }
      if (shape.type === "string" && typeof value === "string") return value;
      if (
        shape.type === "float" &&
        typeof value === "number" &&
        Number.isFinite(value)
      )
        return value;
      throw new TypeError(`Raptor 3 G1 cannot decode provider ${shape.type}`);
    }
    if (shape.kind === "recursive")
      throw new TypeError("A recursive shape requires occurrence rows");
    const decoded: unknown =
      typeof value === "string" ? JSON.parse(value) : value;
    if (shape.kind === "variants") {
      const variants = record(decoded);
      const values: unknown[] = [];
      for (const [type, arm] of Object.entries(shape.arms)) {
        const rows = this.decodeValue(arm, variants[type], internal);
        if (shape.many) {
          for (const data of rows as unknown[]) values.push({ type, data });
        } else if (rows !== null) return { type, data: rows };
      }
      return shape.many ? values : null;
    }
    if (shape.kind === "collection") {
      if (!Array.isArray(decoded))
        throw new TypeError("Invalid provider collection");
      return decoded.map((row) => this.decodeValue(shape.row, row, internal));
    }
    if (decoded === null) return null;
    if (typeof decoded !== "object" || Array.isArray(decoded))
      throw new TypeError("Invalid provider row");
    return Object.fromEntries(
      Object.entries(shape.fields).map(([field, nested]) => [
        field,
        this.decodeValue(nested, record(decoded)[field], internal),
      ]),
    );
  }
}
