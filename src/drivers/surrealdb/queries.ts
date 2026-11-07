/**
 * `docs/architecture/query-backend-frontier.md` step 5.
 *
 * `Commands` locates and captures rows through `Queries.select`, so a nested
 * write reads through this. Everything else it asks of `Queries` is shared.
 */

import { UnsupportedOperationError } from "@errors";
import {
  type PreparedDomain,
  type PreparedPredicate,
  type PreparedProjection,
  type PreparedSelector,
  Queries,
  type Query,
  type RowCondition,
  type SelectControls,
  wholeValue,
} from "@query-engine/raptor3/shared/query";
import type {
  CallScope,
  Condition,
  Parameter,
  RowPurpose,
} from "@query-engine/raptor3/shared/row-scope";
import type { Arguments, Input } from "@query-engine/raptor3/shared/schema";
import type { Membership } from "@query-engine/raptor3/shared/storage";
import { Sql, sql } from "@sql";
import { SurrealReadBackend } from "./read-backend";

type AnyModel = Parameters<Queries["select"]>[0];
type Junction = Extract<Membership, { kind: "junction" }>;

function refuse(what: string): never {
  throw new UnsupportedOperationError(
    `The SurrealDB write backend does not support ${what} yet.`
  );
}

export class SurrealQueries extends Queries {
  /** `id` is the record's: a field of that name beside a key of another lives apart. */
  override columnName(model: AnyModel, field: string): string {
    const column = super.columnName(model, field);
    return column === "id" && !this.keyOrder(model).includes(field)
      ? "id_field"
      : column;
  }

  /** A caller's filter on a link row is a test of what a direct read could hide. */
  refuseHiddenLink(
    edge: Membership,
    filter: { readonly linkFields?: readonly string[] }
  ): void {
    if (!this.lowersLayer)
      this.refuseHiddenLinkRow(edge, filter.linkFields!, "filter");
  }

  override under(domain: PreparedDomain, call?: CallScope): Queries {
    return new SurrealQueries(
      this.schema,
      this.adapter,
      this.result,
      domain,
      call
    );
  }

  /** A layer's predicate for this call, read while it lowers: `undefined` where it drops. */
  /** A layer's predicate for this call, `undefined` where the call drops it. */
  resolved(
    node: Extract<PreparedPredicate, { kind: "layer" }>
  ): PreparedPredicate | undefined {
    return this.resolve(node);
  }

  layer(
    node: Extract<PreparedPredicate, { kind: "layer" }>,
    lower: (resolved: PreparedPredicate) => Sql
  ): Sql | undefined {
    const resolved = this.resolve(node);
    if (resolved === undefined) return undefined;
    const excluded = (this.excluded ??= []);
    excluded.push(node.layer);
    try {
      return lower(resolved);
    } finally {
      excluded.pop();
    }
  }

  /** `predicate` among the rows this call may see for `purpose`. */
  scoped(
    model: AnyModel,
    predicate: PreparedPredicate | undefined,
    purpose: RowPurpose
  ): PreparedPredicate | undefined {
    const scope = this.scope(model, purpose)?.predicate;
    if (scope === undefined) return predicate;
    return predicate === undefined
      ? scope
      : { kind: "and", predicates: [predicate, scope] };
  }

  /** Whether a layer's predicates are lowering here, which read every column as it is. */
  get lowersLayer(): boolean {
    return (this.excluded?.length ?? 0) > 0;
  }

  /** The order this call's extensions give a read that states none. */
  orderOf(model: AnyModel): Arguments["orderBy"] {
    return this.defaultOrder(model);
  }

  /** What a call's value is, in a domain's condition or operand. */
  callValue(parameter: Parameter): unknown {
    return parameter.read(this.values, this.instant);
  }

  holds(condition: Condition): boolean {
    return condition.holds(this.values, this.instant);
  }

  override read(
    model: AnyModel,
    operation: Parameters<Queries["read"]>[1],
    args: Arguments
  ) {
    return this.#lowering.read(model, operation, args);
  }

  /** These spell a statement's parts, and only a statement written whole is read here. */
  override updateAssignment(): Sql {
    return refuse("an assignment spelled apart from its statement");
  }

  override lowerSelector(): Sql | undefined {
    return refuse("a condition spelled apart from its statement");
  }

  override lockAll(): Query {
    return refuse("locks");
  }

  #backend: SurrealReadBackend | undefined;

  get #lowering(): SurrealReadBackend {
    this.#backend ??= new SurrealReadBackend(this);
    return this.#backend;
  }

  #row(model: AnyModel, row: RowCondition): Sql {
    switch (row.kind) {
      case "fieldNull":
        return sql`${this.#lowering.physical(model, row.field)} = NONE`;
      case "notIdentity":
        return sql`!(${sql.join(
          row.identities.map(
            (identity) => sql`(${this.#lowering.identity(model, identity)})`
          ),
          " OR "
        )})`;
      default: {
        // A located value is read where it is spent, so the database compares it.
        const moves = row.fields.flatMap((field) => {
          const stated = row.after[field];
          // Nothing this write states: the column keeps what it holds.
          if (stated === undefined) return [];
          const whole = wholeValue(stated);
          if (!whole) return [sql.raw("true")];
          const after = whole.value;
          if (after instanceof Sql)
            return [
              sql`({ LET $moved = ${after}; (IF type::is_record($moved) { record::id($moved) } ELSE { $moved }) != ${row.before[field]} })`,
            ];
          return String(row.before[field]) === String(after)
            ? []
            : [sql.raw("true")];
        });
        return moves.length
          ? sql`(${sql.join(moves, " OR ")})`
          : sql.raw("false");
      }
    }
  }

  /** A field of the row `selector` names, read inside the statement that spends it. */
  override locatedValue(
    model: AnyModel,
    field: string,
    selector: PreparedSelector
  ): Sql {
    const where = selector.predicate
      ? sql`WHERE ${this.#lowering.predicate(selector.predicate, true)} `
      : sql.raw("");
    return sql`(SELECT VALUE ${this.#lowering.physical(model, field)} FROM ${sql.raw(model["~"].names.sql!)} ${where}LIMIT 1)[0]`;
  }

  /** The edge between two records, named by each side's junction field. */
  override junction(edge: Junction, values: Input): Query {
    if (edge.declared) return this.#lowering.linkRowQuery(edge, values);
    const { table, near, far, out } = this.#lowering.edgeOf(edge);
    const knows = (side: Junction["sourceSide"]) =>
      Object.hasOwn(values, side.members[0]!.junctionField);
    const end = (side: Junction["sourceSide"]) =>
      this.#lowering.end(side, (pair) => values[pair.junctionField]);
    // From its source, an edge is reached along the record's own list.
    const edges = knows(edge.sourceSide)
      ? sql`${end(edge.sourceSide)}${out}`
      : table;
    const conditions = [
      ...(knows(edge.targetSide)
        ? [sql`${far} = ${end(edge.targetSide)}`]
        : []),
    ];
    const unique = edge.uniqueSide === "target";
    const owner = unique ? edge.sourceSide : edge.targetSide;
    const read = unique ? near : far;
    const fields: Record<string, ReturnType<typeof this.scalarShape>> = {};
    const columns = owner.members.map((pair, index) => {
      fields[pair.junctionField] = this.scalarShape(
        owner.model,
        pair.referencedField
      );
      const value =
        owner.members.length === 1
          ? read
          : sql`record::id(${read})[${sql.raw(String(index))}]`;
      return sql`${value} AS ${sql.raw(pair.junctionField)}`;
    });
    return {
      sql: sql`SELECT ${sql.join(columns, ", ")} FROM ${edges}${conditions.length ? sql` WHERE ${sql.join(conditions, " AND ")}` : sql.raw("")}`,
      shape: { kind: "object", fields },
    };
  }

  /** Rows a write named, by key, in the order it named them: a list reads so. */
  override selectSeries(
    prepared: PreparedProjection,
    identities: Input[],
    operation: "createMany" | "updateMany" = "createMany"
  ): Query {
    const { model } = prepared;
    const records = sql.join(
      identities.map((identity) => this.#lowering.recordOfRow(model, identity)),
      ", "
    );
    return {
      sql: sql`SELECT ${this.#lowering.columns(prepared)} FROM [${records}]`,
      shape: prepared.shape,
      expectedRows: this.seriesExpectation(model, identities.length, operation),
    };
  }

  /**
   * `forUpdate` reads as it is: SurrealDB takes no lock, and a transaction that
   * writes a row another committed fails at its own commit.
   */
  override select(
    model: AnyModel,
    args: Partial<Arguments>,
    membership?: { edge: Membership; parent: Input; outside?: boolean },
    controls: SelectControls = {}
  ): Query {
    if (controls.source) refuse("a read over a write's own rows");
    const projection =
      controls.projection ?? this.prepareProjection(model, args);
    const given = controls.selector
      ? controls.selector.predicate
      : args.where === undefined
        ? undefined
        : this.prepareSelector(model, args.where).predicate;
    const predicate = controls.purpose
      ? this.scoped(model, given, controls.purpose)
      : given;
    // A path reads a record's members without scanning the table holding them.
    const path =
      membership?.edge.kind === "junction" &&
      !membership.edge.declared &&
      !membership.outside
        ? this.#lowering.membersOf(membership.edge, membership.parent)
        : undefined;
    const conditions = () => [
      ...(membership && !path
        ? [
            this.#lowering.member(
              membership.edge,
              membership.parent,
              membership.outside
            ),
          ]
        : []),
      ...(controls.identity
        ? [this.#lowering.identity(model, controls.identity)]
        : []),
      ...(controls.unless?.predicate
        ? [this.#lowering.predicate(controls.unless.predicate, false)]
        : []),
      ...(controls.row ? [this.#row(model, controls.row)] : []),
    ];
    return {
      sql: this.#lowering.hoisted(() =>
        this.#lowering.statement(
          model,
          projection,
          args,
          predicate,
          conditions(),
          path
        )
      ),
      shape: projection.shape,
    };
  }
}
