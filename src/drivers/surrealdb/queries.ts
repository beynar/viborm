/**
 * PROTOTYPE: `docs/architecture/query-backend-frontier.md` step 5.
 *
 * `Commands` locates and captures rows through `Queries.select`, so a nested
 * write reads through this. Everything else it asks of `Queries` is shared.
 */

import { UnsupportedOperationError } from "@errors";
import {
  type PreparedSelector,
  Queries,
  type Query,
  type RowCondition,
  type SelectControls,
} from "@query-engine/raptor3/shared/query";
import type { Arguments, Input } from "@query-engine/raptor3/shared/schema";
import type { Membership } from "@query-engine/raptor3/shared/storage";
import { type Sql, sql } from "@sql";
import { SurrealReadBackend } from "./read-backend";

type AnyModel = Parameters<Queries["select"]>[0];
type Junction = Extract<Membership, { kind: "junction" }>;

function refuse(what: string): never {
  throw new UnsupportedOperationError(
    `The SurrealDB write backend does not support ${what} yet.`
  );
}

export class SurrealQueries extends Queries {
  get #lowering(): SurrealReadBackend {
    return new SurrealReadBackend(this);
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
      default:
        return sql.raw(
          row.fields.some((field) => row.before[field] !== row.after[field])
            ? "true"
            : "false"
        );
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
    const { table, near, far } = this.#lowering.edgeOf(edge);
    const conditions: Sql[] = [];
    for (const [end, side] of [
      [near, edge.sourceSide],
      [far, edge.targetSide],
    ] as const) {
      if (Object.hasOwn(values, side.members[0]!.junctionField))
        conditions.push(
          sql`${end} = ${this.#lowering.end(side, (pair) => values[pair.junctionField])}`
        );
    }
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
      sql: sql`SELECT ${sql.join(columns, ", ")} FROM ${table} WHERE ${sql.join(conditions, " AND ")}`,
      shape: { kind: "object", fields },
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
    if (controls.unless) refuse("a read excluding a selector");
    if (controls.source) refuse("a read over a write's own rows");
    if (controls.condition) refuse("a spelled condition");
    const projection =
      controls.projection ?? this.prepareProjection(model, args);
    const predicate = controls.selector
      ? controls.selector.predicate
      : args.where === undefined
        ? undefined
        : this.prepareSelector(model, args.where).predicate;
    // A path reads a record's members without scanning the table holding them.
    const path =
      membership?.edge.kind === "junction" && !membership.outside
        ? this.#lowering.membersOf(membership.edge, membership.parent)
        : undefined;
    const conditions = [
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
      ...(controls.row ? [this.#row(model, controls.row)] : []),
    ];
    return {
      sql: this.#lowering.statement(
        model,
        projection,
        args,
        predicate,
        conditions,
        path
      ),
      shape: projection.shape,
    };
  }
}
