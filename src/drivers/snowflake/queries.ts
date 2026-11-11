/**
 * Snowflake's reads: the SQL backend's, with one form changed.
 *
 * The SQL backend reads a relation as a correlated subquery over a correlated
 * page (`(SELECT json_agg(…) FROM (SELECT … WHERE parent.id = child.fk ORDER
 * BY … LIMIT n) AS page)`). Snowflake refuses both halves of that: a `LIMIT`
 * is allowed only in an uncorrelated subquery, and a derived table may not
 * read an outer row (`Unsupported subquery type cannot be evaluated`). What it
 * does evaluate is a correlated scalar subquery that is an aggregate, whose
 * correlation is an equality in its own `WHERE`
 * (docs.snowflake.com/en/user-guide/querying-subqueries): it decorrelates
 * that into a grouped join.
 *
 * So a relation here is read from an UNCORRELATED page, which projects the
 * key it joins its parent on and windows itself per key, and only the
 * aggregate around it is correlated:
 *
 * ```sql
 * (SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT_KEEP_NULL('id', "p"."id", …))
 *         WITHIN GROUP (ORDER BY "p"."$rn"), ARRAY_CONSTRUCT())
 *    FROM (SELECT "c"."id", …, "c"."authorId" AS "$k0",
 *                 ROW_NUMBER() OVER (PARTITION BY "c"."authorId" ORDER BY …) AS "$rn"
 *            FROM "posts" AS "c" WHERE …
 *         QUALIFY "$rn" <= 2) AS "p"
 *   WHERE "p"."$k0" = "parent"."id")
 * ```
 *
 * A deeper relation is the same form inside the page's own select list,
 * correlated to the page's row. Every other part of a read — the root page,
 * filters (`EXISTS` correlated in a `WHERE` is supported), `_count`,
 * aggregates and groups — is the SQL backend's, through the Snowflake
 * adapter.
 *
 * Refused, with a typed error before anything is sent: a nested `cursor` or
 * `distinct`, a nested order by a relation or a `_count`, a recursive
 * relation, a polymorphic slot and a junction's `$through` row.
 */

import { assembleAdapterSelect } from "@adapters/adapter-internals";
import { UnsupportedOperationError } from "@errors";
import type { AnyModel } from "@schema/model";
import { type Sql, sql } from "@sql";
import type {
  Leaf,
  PreparedProjection,
  PreparedProjectionField,
  PreparedRelationProjection,
  ProjectionShape,
} from "@query-engine/raptor3/shared/query";
import { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
import { physicalField } from "@query-engine/raptor3/shared/storage";

/** What a nested read on Snowflake does not express. */
function refused(what: string): never {
  throw new UnsupportedOperationError(
    `Snowflake reads a relation without ${what}. Read it with a second query, or with $queryRaw.`,
    { meta: { dialect: "snowflake", feature: what } }
  );
}

interface OrderKey {
  readonly expression: Sql;
  readonly descending: boolean;
  readonly nulls: "first" | "last";
  readonly nullable: boolean;
}

const KEY = (index: number) => `$k${index}`;
const ORDER = (index: number) => `$o${index}`;
const RANK = "$rn";

export class SnowflakeQueries extends SqlQueries {
  override lowerProjection(
    projection: PreparedProjection,
    alias?: string,
    visible = false
  ): Sql[] {
    const a = this.adapter;
    return projection.fields.map((field) => {
      if (field.kind === "relation")
        return a.identifiers.aliased(
          this.#relation(field, alias ?? ""),
          field.name
        );
      if (field.kind === "variants") refused("a polymorphic slot");
      return super.lowerProjection(
        { ...projection, fields: [field] },
        alias,
        visible
      )[0]!;
    });
  }

  /** One relation of the row at `parentAlias`, as one aggregate value. */
  #relation(
    field: Extract<PreparedProjectionField, { kind: "relation" }>,
    parentAlias: string
  ): Sql {
    const relation: PreparedRelationProjection = field;
    const { edge, arguments: nested, projection } = relation;
    if (relation.recurrence) refused("recursion");
    if (relation.linkRow || relation.linkWhere) refused("its $through row");
    if (edge.discriminator) refused("a polymorphic slot");
    if (nested.cursor !== undefined) refused("a cursor");
    if (nested.distinct?.length) refused("distinct");

    const a = this.adapter;
    const childAlias = this.alias();
    const columns = this.lowerProjection(projection, childAlias, true);
    const where: Sql[] = [];
    let from: Sql;
    let joins: Sql[] | undefined;
    // The child's side of each key pair, and the parent column it equals.
    const keys: [child: Sql, parent: Sql][] = [];
    if (edge.kind === "reference") {
      from = this.table(edge.target, childAlias);
      for (const pair of edge.pairs)
        keys.push([
          this.column(edge.target, pair.target, childAlias),
          this.column(edge.source, pair.source, parentAlias),
        ]);
    } else {
      const link = this.alias();
      from = a.identifiers.table(edge.table, link);
      joins = [
        a.joins.inner(
          this.table(edge.target, childAlias),
          a.operators.and(
            ...this.junctionSideConditions(edge.targetSide, link, childAlias)
          )
        ),
      ];
      for (const pair of edge.sourceSide.members)
        keys.push([
          a.identifiers.column(link, pair.junctionField),
          this.column(edge.source, pair.referencedField, parentAlias),
        ]);
    }
    // The related domain enters where the SQL backend's `correlation` puts
    // it: on the target row, outside any quantifier.
    const domain = this.domainOf(edge.target, "related");
    if (domain) where.push(this.lowerSelector(domain, childAlias)!);
    if (nested.selector) where.push(this.lowerSelector(nested.selector, childAlias)!);

    const order = this.#order(edge.target, nested.orderBy, childAlias);
    // A negative `take` reads the window backwards; the decoder restores it.
    const backward = nested.take !== undefined && nested.take < 0;
    const presented = backward
      ? order.map((key) => ({
          ...key,
          descending: !key.descending,
          nulls: key.nulls === "first" ? ("last" as const) : ("first" as const),
        }))
      : order;
    const windowed =
      !edge.many || nested.take !== undefined || nested.skip !== undefined;
    const pageColumns = [...columns];
    for (const [index, [child]] of keys.entries())
      pageColumns.push(a.identifiers.aliased(child, KEY(index)));
    const qualify: Sql[] = [];
    if (windowed) {
      pageColumns.push(
        a.identifiers.aliased(
          sql`ROW_NUMBER() OVER (PARTITION BY ${sql.join(
            keys.map(([child]) => child),
            ", "
          )} ORDER BY ${this.#orderList(presented) ?? sql.raw("1")})`,
          RANK
        )
      );
      const rank = a.identifiers.escape(RANK);
      const skip = nested.skip ?? 0;
      if (skip > 0) qualify.push(a.operators.gt(rank, this.value(skip)));
      if (!edge.many) qualify.push(a.operators.eq(rank, this.value(1)));
      else if (nested.take !== undefined)
        qualify.push(
          a.operators.lte(rank, this.value(skip + Math.abs(nested.take)))
        );
    } else {
      for (const [index, key] of presented.entries())
        pageColumns.push(a.identifiers.aliased(key.expression, ORDER(index)));
    }
    const page = assembleAdapterSelect(a, {
      columns: sql.join(pageColumns, ", "),
      from,
      joins,
      where: where.length === 0 ? undefined : a.operators.and(...where),
    });
    const pageAlias = this.alias();
    const qualified =
      qualify.length === 0
        ? page
        : sql`${page} QUALIFY ${a.operators.and(...qualify)}`;

    const members: [string, Sql][] = Object.entries(
      projection.shape.fields
    ).map(([name, leaf]) => [
      name,
      this.#carried(leaf, a.identifiers.column(pageAlias, name)),
    ]);
    for (const gate of projection.shape.gates ?? [])
      members.push([gate, a.identifiers.column(pageAlias, gate)]);
    const object = a.json.object(members);
    const within = windowed
      ? a.orderBy.asc(a.identifiers.column(pageAlias, RANK))
      : this.#orderList(
          presented.map((key, index) => ({
            ...key,
            expression: a.identifiers.column(pageAlias, ORDER(index)),
          }))
        );
    const aggregated = within
      ? sql`ARRAY_AGG(${object}) WITHIN GROUP (ORDER BY ${within})`
      : sql`ARRAY_AGG(${object})`;
    return a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: edge.many
          ? a.expressions.coalesce(aggregated, a.json.emptyArray())
          : sql`GET(${aggregated}, 0)`,
        from: a.subqueries.correlate(qualified, pageAlias),
        where: a.operators.and(
          ...keys.map(([, parent], index) =>
            a.operators.eq(a.identifiers.column(pageAlias, KEY(index)), parent)
          )
        ),
      })
    );
  }

  /**
   * A nested page's order: the caller's scalar terms, then the target's key,
   * NULLs placed as the SQL backend's page places them.
   */
  #order(
    model: AnyModel,
    input: unknown,
    alias: string
  ): OrderKey[] {
    const keys: OrderKey[] = [];
    const ordered = new Set<string>();
    const terms = Array.isArray(input) ? input : input ? [input] : [];
    for (const term of terms) {
      for (const [field, direction] of Object.entries(
        term as Record<string, unknown>
      )) {
        if (direction === undefined) continue;
        if (model["~"].state.relations[field])
          refused("an order by a related row or its _count");
        let descending: boolean;
        let nulls: "first" | "last" | undefined;
        if (direction === "asc" || direction === "desc")
          descending = direction === "desc";
        else {
          const specification = direction as Record<string, unknown>;
          if (specification._distance !== undefined)
            refused("an order by distance");
          descending = specification.sort === "desc";
          nulls = specification.nulls as "first" | "last" | undefined;
        }
        ordered.add(field);
        keys.push({
          expression: this.column(model, field, alias),
          descending,
          nulls: nulls ?? (descending ? "first" : "last"),
          nullable: physicalField(this.schema, model, field).nullable,
        });
      }
    }
    for (const field of this.keyOrder(model)) {
      if (ordered.has(field)) continue;
      keys.push({
        expression: this.column(model, field, alias),
        descending: false,
        nulls: "last",
        nullable: physicalField(this.schema, model, field).nullable,
      });
    }
    return keys;
  }

  #orderList(keys: readonly OrderKey[]): Sql | undefined {
    if (keys.length === 0) return undefined;
    const a = this.adapter;
    return sql.join(
      keys.map((key) => {
        const direction = key.descending ? "desc" : "asc";
        if (!key.nullable) return a.orderBy[direction](key.expression);
        return key.nulls === "first"
          ? a.orderBy.nullsFirst(key.expression, direction)
          : a.orderBy.nullsLast(key.expression, direction);
      }),
      ", "
    );
  }

  /**
   * A page column carried inside the relation's document, in the spelling
   * its decoder reads: exact text for what a JSON number would round, hex for
   * bytes, and an ISO instant for a timestamp, which a VARIANT would otherwise
   * spell in the session's output format.
   */
  #carried(leaf: ProjectionShape | Leaf, column: Sql): Sql {
    const a = this.adapter;
    if (leaf.kind !== "scalar") return a.json.document(column);
    if (leaf.list)
      return leaf.type === "decimal" ||
        leaf.type === "bigint" ||
        leaf.type === "number"
        ? a.arrays.exactNumericProjection(column)
        : column;
    switch (leaf.type) {
      case "decimal":
      case "bigint":
        return a.expressions.cast(column, "text");
      case "datetime":
        return sql`TO_VARCHAR(CAST(${column} AS TIMESTAMP_TZ), 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')`;
      case "date":
        return sql`TO_VARCHAR(${column}, 'YYYY-MM-DD')`;
      case "blob":
        return a.expressions.caseWhen(
          [{ when: a.operators.isNull(column), then: a.literals.null() }],
          a.expressions.blobToHex(column)
        );
      default:
        return column;
    }
  }
}
