import type { DatabaseAdapter } from "@adapters/database-adapter";
import { assembleAdapterSelect } from "@adapters/adapter-internals";
import { QueryEngineError, TransactionError } from "@errors";
import {
  fieldRefPayload,
  formatFieldRef,
  isFieldRef,
} from "@schema/field-ref";
import {
  findAddressableKey,
  type AnyModel,
  type OrderedModelKey,
} from "@schema/model";
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
  type PhysicalField,
  storedFields,
} from "./storage";

type Leaf = {
  kind: "scalar";
  type: string;
  nullable: boolean;
  decimal?: DecimalDescriptor;
};
export type ProjectionShape =
  | {
      kind: "object";
      fields: Record<string, ProjectionShape | Leaf>;
    }
  | { kind: "collection"; row: ProjectionShape }
  | {
      kind: "variants";
      many: boolean;
      arms: Record<string, ProjectionShape>;
    }
  | {
      kind: "recursive";
      relation: string;
      many: boolean;
      seeds: ProjectionShape[];
      descendant: ProjectionShape;
      carriers: {
        seed: string;
        depth: string;
        path: string;
        value: string;
      };
    };
type Shape = ProjectionShape;
type RelationProjectionArguments = Pick<
  Partial<Arguments>,
  "orderBy" | "take" | "skip"
> & { readonly selector?: PreparedSelector };
interface PreparedRelationProjection {
  readonly edge: Membership;
  readonly arguments: RelationProjectionArguments;
  readonly projection: PreparedProjection;
}
export type PreparedProjectionField =
  | { readonly kind: "scalar"; readonly name: string }
  | ({
      readonly kind: "relation";
      readonly name: string;
    } & PreparedRelationProjection)
  | {
      readonly kind: "variants";
      readonly name: string;
      readonly many: boolean;
      readonly arms: readonly ({
        readonly variant: string;
      } & PreparedRelationProjection)[];
    };
export interface PreparedProjection {
  readonly model: AnyModel;
  readonly fields: readonly PreparedProjectionField[];
  readonly shape: Extract<ProjectionShape, { kind: "object" }>;
}
export interface Query {
  sql: Sql;
  shape: Shape;
  expectedRows?: {
    readonly count: number;
    readonly missing: Error;
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
type PreparedScalar = {
  readonly model: AnyModel;
  readonly field: string;
  readonly physical: PhysicalField;
};
type PreparedOperand =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "field"; readonly scalar: PreparedScalar };
type PreparedPredicate =
  | {
      readonly kind: "and" | "or";
      readonly predicates: readonly PreparedPredicate[];
    }
  | { readonly kind: "not"; readonly predicate: PreparedPredicate }
  | {
      readonly kind: "comparison";
      readonly operator: "equals" | "gte" | "gt" | "lte" | "lt";
      readonly scalar: PreparedScalar;
      readonly operand: PreparedOperand;
    }
  | {
      readonly kind: "in";
      readonly scalar: PreparedScalar;
      readonly operands: readonly PreparedOperand[];
    }
  | { readonly kind: "isNull"; readonly scalar: PreparedScalar }
  | {
      readonly kind: "relation";
      readonly edge: Membership;
      readonly quantifier: string;
      readonly predicate?: PreparedPredicate;
    };
export interface PreparedSelector {
  readonly model: AnyModel;
  readonly facts: SelectorFacts;
  readonly uniqueKey?: OrderedModelKey;
  readonly uniqueValues?: ReadonlyMap<string, unknown>;
  readonly predicate?: PreparedPredicate;
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
    return Object.freeze({
      kind: "scalar",
      type: state.type,
      nullable: physical.nullable,
      decimal: state.type === "decimal" ? state.decimal : undefined,
    });
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
  prepareSelector(model: AnyModel, where?: Input): PreparedSelector {
    const facts: SelectorFacts = {
      fields: new Set(),
      equals: new Map(),
      exact: true,
      reads: [],
    };
    const keys = Object.keys(where ?? {});
    const uniqueKey =
      keys.length === 1 ? findAddressableKey(model, keys[0]!) : undefined;
    const selected = uniqueKey
      ? uniqueKey.name
        ? record(where![uniqueKey.name])
        : where!
      : undefined;
    return Object.freeze({
      model,
      facts,
      uniqueKey,
      uniqueValues: selected
        ? new Map(
            uniqueKey!.fields.map((field) => [field, selected[field]]),
          )
        : undefined,
      predicate: where
        ? this.prepareWhere(model, where, facts, [])
        : undefined,
    });
  }
  selectorFacts(selector: PreparedSelector): SelectorFacts {
    return selector.facts;
  }
  identitySelector(model: AnyModel, identity: Input): PreparedSelector {
    const facts: SelectorFacts = {
      fields: new Set(),
      equals: new Map(),
      exact: true,
      reads: [],
    };
    return Object.freeze({
      model,
      facts,
      predicate: Object.freeze({
        kind: "and",
        predicates: Object.freeze(
          Object.entries(identity).map(([field, value]) =>
            this.prepareScalarPredicate(model, field, value, facts),
          ),
        ),
      }),
    });
  }
  andSelectors(
    model: AnyModel,
    selectors: readonly PreparedSelector[],
  ): PreparedSelector {
    const facts: SelectorFacts = {
      fields: new Set(),
      equals: new Map(),
      exact: true,
      reads: [],
    };
    const predicates: PreparedPredicate[] = [];
    for (const selector of selectors) {
      for (const field of selector.facts.fields) facts.fields.add(field);
      for (const [field, value] of selector.facts.equals)
        facts.equals.set(field, value);
      facts.exact &&= selector.facts.exact;
      facts.reads.push(...selector.facts.reads);
      if (selector.predicate) predicates.push(selector.predicate);
    }
    return Object.freeze({
      model,
      facts,
      predicate:
        predicates.length === 0
          ? undefined
          : Object.freeze({
              kind: "and",
              predicates: Object.freeze(predicates),
            }),
    });
  }
  lowerSelector(selector: PreparedSelector, alias?: string): Sql | undefined {
    return selector.predicate
      ? this.lowerPredicate(selector.predicate, alias)
      : undefined;
  }
  lowerWhere(
    model: AnyModel,
    where: Input | undefined,
    alias?: string,
  ): Sql | undefined {
    return this.lowerSelector(this.prepareSelector(model, where), alias);
  }
  lowerMutationLimit(
    model: AnyModel,
    selector: PreparedSelector,
    limit: number | undefined
  ): { readonly where?: Sql; readonly suffix?: Sql } {
    const adapter = this.adapter;
    const lowered = this.lowerSelector(selector);
    if (limit === undefined) return { where: lowered };
    if (adapter.capabilities.supportsMutationRowLimit)
      return {
        where: lowered,
        suffix: adapter.clauses.limit(this.value(limit)),
      };
    const alias = this.alias();
    const keys = this.schema.keys(model);
    const targetColumns = keys.map((field) => this.column(model, field));
    const selectedColumns = keys.map((field) =>
      this.column(model, field, alias)
    );
    const target =
      targetColumns.length === 1
        ? targetColumns[0]!
        : sql`(${sql.join(targetColumns, ", ")})`;
    const capped = assembleAdapterSelect(adapter, {
      columns: sql.join(selectedColumns, ", "),
      from: this.table(model, alias),
      where: this.lowerSelector(selector, alias),
      limit: this.value(limit),
    });
    return {
      where: adapter.operators.in(target, adapter.subqueries.scalar(capped)),
    };
  }
  lowerIdentity(model: AnyModel, identity: Input, alias?: string): Sql {
    return this.adapter.operators.and(
      ...Object.entries(identity).map(([field, value]) =>
        this.adapter.operators.eq(
          this.column(model, field, alias),
          this.fieldValue(model, field, value),
        ),
      ),
    );
  }
  private prepareWhere(
    model: AnyModel,
    where: Input,
    facts: SelectorFacts,
    path: readonly Membership[],
  ): PreparedPredicate {
    return Object.freeze({
      kind: "and",
      predicates: Object.freeze(
        Object.entries(where).map(([field, operand]) => {
          if (field === "AND" || field === "OR") {
            if (field === "OR") facts.exact = false;
            return Object.freeze({
              kind: field === "AND" ? "and" : "or",
              predicates: Object.freeze(
                entries(operand).map((clause) =>
                  this.prepareWhere(model, clause, facts, path),
                ),
              ),
            });
          }
          if (field === "NOT") {
            facts.exact = false;
            return Object.freeze({
              kind: "not",
              predicate: this.prepareWhere(
                model,
                record(operand),
                facts,
                path,
              ),
            });
          }
          if (model["~"].state.relations[field]) {
            const edge = bindMembership(this.schema, model, field);
            return this.prepareRelationPredicate(edge, operand, facts, [
              ...path,
              edge,
            ]);
          }
          const key = findAddressableKey(model, field);
          if (key?.name)
            return Object.freeze({
              kind: "and",
              predicates: Object.freeze(
                key.fields.map((member) =>
                  this.prepareScalarPredicate(
                    model,
                    member,
                    record(operand)[member],
                    facts,
                  ),
                ),
              ),
            });
          return this.prepareScalarPredicate(model, field, operand, facts);
        }),
      ),
    });
  }
  private prepareScalarPredicate(
    model: AnyModel,
    field: string,
    value: unknown,
    facts: SelectorFacts,
  ): PreparedPredicate {
    const scalar = Object.freeze({
      model,
      field,
      physical: physicalField(this.schema, model, field),
    });
    facts.fields.add(field);
    const filter =
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Sql) &&
      !isFieldRef(value)
        ? record(value)
        : undefined;
    const hasEquality =
      filter === undefined ||
      (Object.keys(filter).length === 1 && "equals" in filter);
    const equality =
      filter && hasEquality
        ? filter.equals
        : value;
    if (
      hasEquality &&
      (equality === null ||
        (typeof equality !== "object" && !(equality instanceof Sql)))
    )
      facts.equals.set(field, equality);
    else facts.exact = false;
    return this.prepareScalarOperations(scalar, value);
  }
  private prepareScalarOperations(
    scalar: PreparedScalar,
    value: unknown,
  ): PreparedPredicate {
    if (value === null) return Object.freeze({ kind: "isNull", scalar });
    if (
      value instanceof Sql ||
      isFieldRef(value) ||
      typeof value !== "object"
    )
      return Object.freeze({
        kind: "comparison",
        operator: "equals",
        scalar,
        operand: this.prepareOperand(scalar.model, value),
      });
    return Object.freeze({
      kind: "and",
      predicates: Object.freeze(
        Object.entries(record(value)).map(([name, operand]) => {
          switch (name) {
            case "equals":
              return this.prepareScalarOperations(scalar, operand);
            case "in":
              return Object.freeze({
                kind: "in",
                scalar,
                operands: Object.freeze(
                  (operand as unknown[]).map((member) =>
                    this.prepareOperand(scalar.model, member),
                  ),
                ),
              });
            case "gte":
            case "gt":
            case "lte":
            case "lt":
              return Object.freeze({
                kind: "comparison",
                operator: name,
                scalar,
                operand: this.prepareOperand(scalar.model, operand),
              });
            case "not":
              return Object.freeze({
                kind: "not",
                predicate: this.prepareScalarOperations(scalar, operand),
              });
            default:
              throw new Error(
                `Raptor 3 G1 filter is not implemented: ${name}`,
              );
          }
        }),
      ),
    });
  }
  private prepareOperand(model: AnyModel, value: unknown): PreparedOperand {
    if (!isFieldRef(value))
      return Object.freeze({ kind: "value", value });
    const payload = fieldRefPayload(value);
    const scope = model["~"].names.ts ?? "unknown";
    if (payload.model !== scope)
      throw new QueryEngineError(
        `Field reference '${formatFieldRef(value)}' cannot be used while filtering '${scope}': a field reference may only compare columns of the same model.`,
      );
    if (!model["~"].state.scalars[payload.field])
      throw new QueryEngineError(
        `Field reference '${formatFieldRef(value)}' does not name a scalar field of '${scope}'.`,
      );
    return Object.freeze({
      kind: "field",
      scalar: Object.freeze({
        model,
        field: payload.field,
        physical: physicalField(this.schema, model, payload.field),
      }),
    });
  }
  private prepareRelationPredicate(
    edge: Membership,
    operand: unknown,
    facts: SelectorFacts,
    path: readonly Membership[],
  ): PreparedPredicate {
    return Object.freeze({
      kind: "and",
      predicates: Object.freeze(
        Object.entries(record(operand)).map(([quantifier, value]) => {
          const nestedFacts: SelectorFacts = {
            fields: new Set(),
            equals: new Map(),
            exact:
              quantifier !== "none" &&
              quantifier !== "every" &&
              quantifier !== "isNot",
            reads: [],
          };
          const predicate =
            value === null
              ? undefined
              : this.prepareWhere(
                  edge.target,
                  record(value),
                  nestedFacts,
                  path,
                );
          facts.reads.push({
            model: edge.target,
            path,
            fields: nestedFacts.fields,
            equals: nestedFacts.equals,
            exact: nestedFacts.exact,
          });
          facts.reads.push(...nestedFacts.reads);
          return Object.freeze({
            kind: "relation",
            edge,
            quantifier,
            predicate,
          });
        }),
      ),
    });
  }
  private lowerPredicate(
    predicate: PreparedPredicate,
    alias?: string,
  ): Sql {
    const a = this.adapter;
    switch (predicate.kind) {
      case "and":
        return a.operators.and(
          ...predicate.predicates.map((member) =>
            this.lowerPredicate(member, alias),
          ),
        );
      case "or":
        return a.operators.or(
          ...predicate.predicates.map((member) =>
            this.lowerPredicate(member, alias),
          ),
        );
      case "not":
        return a.operators.not(this.lowerPredicate(predicate.predicate, alias));
      case "isNull":
        return a.operators.isNull(this.preparedColumn(predicate.scalar, alias));
      case "in":
        return a.operators.in(
          this.preparedColumn(predicate.scalar, alias),
          a.literals.list(
            predicate.operands.map((operand) =>
              this.lowerOperand(predicate.scalar, operand, alias),
            ),
          ),
        );
      case "comparison": {
        const left = this.preparedColumn(predicate.scalar, alias);
        const right = this.lowerOperand(
          predicate.scalar,
          predicate.operand,
          alias,
        );
        return a.operators[predicate.operator === "equals" ? "eq" : predicate.operator](
          left,
          right,
        );
      }
      case "relation":
        return this.lowerRelationPredicate(predicate, alias);
    }
  }
  private preparedColumn(scalar: PreparedScalar, alias?: string): Sql {
    return alias
      ? this.adapter.identifiers.column(alias, scalar.physical.name)
      : this.adapter.identifiers.escape(scalar.physical.name);
  }
  private lowerOperand(
    scalar: PreparedScalar,
    operand: PreparedOperand,
    alias?: string,
  ): Sql {
    if (operand.kind === "field")
      return this.preparedColumn(operand.scalar, alias);
    const state = scalar.physical.scalar["~"].state;
    if (state.type !== "decimal" || operand.value === null)
      return this.value(operand.value);
    return operand.value instanceof Sql
      ? this.adapter.expressions.decimalCast(operand.value, state.decimal)
      : this.adapter.literals.decimal(operand.value as string, state.decimal);
  }
  private lowerValuePredicate(expression: Sql, value: unknown): Sql {
    const op = this.adapter.operators;
    if (value === null) return op.isNull(expression);
    if (value instanceof Sql || typeof value !== "object")
      return op.eq(expression, this.value(value));
    return op.and(
      ...Object.entries(record(value)).map(([name, operand]) => {
        switch (name) {
          case "equals":
            return this.lowerValuePredicate(expression, operand);
          case "in":
            return op.in(
              expression,
              this.adapter.literals.list(
                (operand as unknown[]).map((member) => this.value(member)),
              ),
            );
          case "gte":
          case "gt":
          case "lte":
          case "lt":
            return op[name](expression, this.value(operand));
          case "not":
            return op.not(this.lowerValuePredicate(expression, operand));
          default:
            throw new Error(
              `Raptor 3 G1 filter is not implemented: ${name}`,
            );
        }
      }),
    );
  }
  private lowerRelationPredicate(
    predicate: Extract<PreparedPredicate, { kind: "relation" }>,
    parentAlias?: string,
  ): Sql {
    const a = this.adapter;
    const childAlias = this.alias();
    const nested = predicate.predicate
      ? this.lowerPredicate(predicate.predicate, childAlias)
      : undefined;
    const condition = a.operators.and(
      this.correlation(predicate.edge, parentAlias ?? "", childAlias),
      ...(nested
        ? [
            predicate.quantifier === "every"
              ? a.operators.not(nested)
              : nested,
          ]
        : []),
    );
    const query = a.subqueries.existsCheck(
      this.table(predicate.edge.target, childAlias),
      condition,
    );
    switch (predicate.quantifier) {
      case "some":
        return a.filters.some(query);
      case "none":
        return a.filters.none(query);
      case "every":
        return a.filters.every(query);
      case "is":
        return predicate.predicate ? a.filters.is(query) : a.filters.isNot(query);
      case "isNot":
        return predicate.predicate ? a.filters.isNot(query) : a.filters.is(query);
      default:
        throw new Error(
          `Raptor 3 G3P-05 relation filter is not implemented: ${predicate.quantifier}`,
        );
    }
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
    controls: {
      condition?: Sql;
      forUpdate?: boolean;
      identity?: Input;
      projection?: PreparedProjection;
      selector?: PreparedSelector;
    } = {},
  ): Query {
    const alias = this.alias();
    const prepared = controls.projection ?? this.prepareProjection(model, args);
    const projection = this.lowerProjection(prepared, alias);
    const selector =
      controls.selector ??
      (args.where === undefined
        ? undefined
        : this.prepareSelector(model, args.where));
    const filter = selector
      ? this.lowerSelector(selector, alias)
      : undefined;
    return {
      sql: assembleAdapterSelect(this.adapter, {
        columns: sql.join(projection.columns, ", "),
        from: this.table(model, alias),
        where: this.adapter.operators.and(
          ...(membership
            ? [this.memberWhere(membership.edge, membership.parent, alias)]
            : []),
          ...(filter ? [filter] : []),
          ...(controls.identity
            ? [this.lowerIdentity(model, controls.identity, alias)]
            : []),
          ...(controls.condition ? [controls.condition] : []),
        ),
        orderBy: this.order(model, args.orderBy, alias),
        limit: args.take === undefined ? undefined : this.value(args.take),
        offset: args.skip === undefined ? undefined : this.value(args.skip),
        forUpdate: controls.forUpdate,
      }),
      shape: prepared.shape,
    };
  }
  selectSeries(
    prepared: PreparedProjection,
    identities: Input[],
    operation: "createMany" | "updateMany" = "createMany"
  ): Query {
    const model = prepared.model;
    const alias = this.alias();
    const projection = this.lowerProjection(prepared, alias);
    const predicates = identities.map(
      (identity) => this.lowerIdentity(model, identity, alias),
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
      shape: prepared.shape,
      expectedRows: {
        count: identities.length,
        missing:
          operation === "createMany"
            ? new QueryEngineError(
                "createMany with 'select' could not read back one of the created rows at the primary key it reported. A later row in the same call moved that row's primary key; use the '{ count }' form, or write those rows in separate calls."
              )
            : new TransactionError(
                "updateMany with 'select' could not read back one of the updated rows at its final primary key.",
                {
                  meta: {
                    model: model["~"].names.ts ?? "unknown",
                    operation: "updateMany",
                  },
                }
              ),
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
    const projectedDocument = (
      projection: PreparedProjection,
      lowered: { readonly entries: [string, Sql][] },
    ) =>
      a.json.object(
        lowered.entries.map(([field, expression]) => [
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
      const projection = this.prepareProjection(model, args);
      const lowered = this.lowerProjection(projection, alias);
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
              projectedDocument(projection, lowered),
              carriers.value,
            ),
            ...carried(alias),
          ],
          ", ",
        ),
        from: this.table(model, alias),
        where: this.lowerWhere(model, args.where, alias),
      });
    });
    const childAlias = this.alias();
    const walkAlias = this.alias();
    const descendantArgs = withoutRelation(traversal.args ?? {});
    const descendant = this.prepareProjection(model, descendantArgs);
    const loweredDescendant = this.lowerProjection(descendant, childAlias);
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
          a.identifiers.aliased(
            projectedDocument(descendant, loweredDescendant),
            carriers.value,
          ),
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
          ? [this.lowerWhere(model, descendantArgs.where, childAlias)!]
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
  prepareProjection(
    model: AnyModel,
    args: Partial<Arguments>,
  ): PreparedProjection {
    const selected = args.select ?? {
      ...Object.fromEntries(
        model["~"].scalarFieldNames
          .filter((field) => !model["~"].state.omit?.[field])
          .map((field) => [field, true]),
      ),
      ...args.include,
    };
    const prepared: PreparedProjectionField[] = [];
    const fields: Record<string, Shape | Leaf> = {};
    for (const [name, selection] of Object.entries(selected)) {
      if (!selection) continue;
      if (!model["~"].state.relations[name]) {
        prepared.push(Object.freeze({ kind: "scalar", name }));
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
        const preparedArms: ({
          readonly variant: string;
        } & PreparedRelationProjection)[] = [];
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
          const nested = this.prepareRelationProjection(
            bindMembership(this.schema, model, name, member.variant),
            arm === undefined ? true : arm,
          );
          arms[member.variant] = nested.edge.many
            ? Object.freeze({
                kind: "collection",
                row: nested.projection.shape,
              })
            : nested.projection.shape;
          preparedArms.push(
            Object.freeze({ variant: member.variant, ...nested }),
          );
        }
        fields[name] = Object.freeze({
          kind: "variants",
          many,
          arms: Object.freeze(arms),
        });
        prepared.push(
          Object.freeze({
            kind: "variants",
            name,
            many,
            arms: Object.freeze(preparedArms),
          }),
        );
        continue;
      }
      const nested = this.prepareRelationProjection(
        bindMembership(this.schema, model, name),
        selection,
      );
      fields[name] = nested.edge.many
        ? Object.freeze({ kind: "collection", row: nested.projection.shape })
        : nested.projection.shape;
      prepared.push(Object.freeze({ kind: "relation", name, ...nested }));
    }
    return Object.freeze({
      model,
      fields: Object.freeze(prepared),
      shape: Object.freeze({ kind: "object", fields: Object.freeze(fields) }),
    });
  }
  private prepareRelationProjection(
    edge: Membership,
    selection: unknown,
  ): PreparedRelationProjection {
    const nested =
      selection === true ? {} : (record(selection) as Partial<Arguments>);
    return Object.freeze({
      edge,
      arguments: Object.freeze({
        selector: nested.where
          ? this.prepareSelector(edge.target, nested.where)
          : undefined,
        orderBy: nested.orderBy,
        take: nested.take,
        skip: nested.skip,
      }),
      projection: this.prepareProjection(edge.target, nested),
    });
  }
  lowerProjection(
    projection: PreparedProjection,
    alias?: string,
  ): { readonly columns: Sql[]; readonly entries: [string, Sql][] } {
    const a = this.adapter;
    const columns: Sql[] = [];
    const entries: [string, Sql][] = [];
    for (const field of projection.fields) {
      let expression: Sql;
      if (field.kind === "scalar") {
        expression = this.projectedColumn(projection.model, field.name, alias);
      } else if (field.kind === "relation") {
        expression = this.lowerRelationProjection(field, alias ?? "");
      } else {
        expression = a.json.object(
          field.arms.map((arm) => [
            arm.variant,
            a.json.document(this.lowerRelationProjection(arm, alias ?? "")),
          ]),
        );
      }
      columns.push(a.identifiers.aliased(expression, field.name));
      entries.push([field.name, expression]);
    }
    return { columns, entries };
  }
  lowerProjectionValues(
    projection: PreparedProjection,
    values: Input,
  ): readonly Sql[] {
    return projection.fields.map((field) => {
      const scalar = field as Extract<
        PreparedProjectionField,
        { kind: "scalar" }
      >;
      return this.adapter.identifiers.aliased(
        this.fieldValue(projection.model, scalar.name, values[scalar.name]),
        scalar.name,
      );
    });
  }
  private lowerRelationProjection(
    relation: PreparedRelationProjection,
    alias: string,
  ): Sql {
    const a = this.adapter;
    const { edge, arguments: nested, projection } = relation;
    const childAlias = this.alias();
    const child = this.lowerProjection(projection, childAlias);
    const childFields = Object.keys(projection.shape.fields);
    const page = assembleAdapterSelect(a, {
      columns: sql.join(child.columns, ", "),
      from: this.table(edge.target, childAlias),
      where: a.operators.and(
        this.correlation(edge, alias, childAlias),
        ...(nested.selector
          ? [this.lowerSelector(nested.selector, childAlias)!]
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
        projection.shape.fields[field]!.kind !== "scalar"
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
    return expression;
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
              this.lowerValuePredicate(
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
        where: this.lowerWhere(model, args.where, alias),
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
  decodeQuery(query: Query, rows: Input[], internal = false): Input[] {
    if (query.expectedRows && rows.length < query.expectedRows.count)
      throw query.expectedRows.missing;
    if (query.expectedRows && rows.length > query.expectedRows.count)
      throw new QueryEngineError(
        "Raptor 3 createMany final read returned inconsistent row counts.",
      );
    return this.decodeProjection(query.shape, rows, internal);
  }
  decodeProjection(
    shape: ProjectionShape,
    rows: Input[],
    internal = false,
  ): Input[] {
    if (shape.kind === "recursive")
      return this.decodeRecursive(shape, rows, internal);
    return rows.map((row) => this.decodeValue(shape, row, internal) as Input);
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
