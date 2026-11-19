/**
 * The body of a database view, for the migrations
 * (`docs/architecture/schema-views-plan.md` §3.1): the view's declared read,
 * compiled by the read compiler itself. {@link ViewBodyQueries} changes two
 * things of a read and nothing else: its root scalars are projected as
 * stored, under their column names, and its root states no order unless it
 * takes a window. Its documents (relations, `_count`, `_aggregate`) are
 * projected as a read carries them, so the client decodes a view's JSON
 * column with the decoder of the read that carried it. An aggregated view's
 * body is the read compiler's `groupBy`, its root projected as flat columns:
 * each grouped field as stored, each aggregate cast to its column's scalar.
 *
 * Only the migrations import this module: nothing the client or the engine
 * imports reaches it, so no application bundle carries it.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { FeatureNotSupportedError, UnsupportedOperationError } from "@errors";
import type { Schema } from "@schema/hydration";
import type { AnyModel } from "@schema/model";
import type { Scalar } from "@schema/scalars/base";
import { type ViewAggregate, viewFacts } from "@schema/view/facts";
import type { Sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import { aggregatedIdentifier, isCompact } from "./shared/identifier";
import {
  type PreparedAggregates,
  type PreparedProjection,
  refusesWhileDecoding,
} from "./shared/query";
import {
  type Arguments,
  EngineSchema,
  entries,
  type ResolvedSchemaViews,
} from "./shared/schema";
import { SqlQueries, type SqlSelectControls } from "./shared/sql-queries";
import { nameOf, scalarsOf, tableOf } from "./shared/terms";

/**
 * How a view's dialect makes an expression one of the view's columns: what
 * its migration driver states, as it states each scalar's column type.
 */
export interface ViewColumnSql {
  /** `expression` cast to the type the dialect stores a column of `scalar` in. */
  viewCast(expression: Sql, scalar: Scalar): Sql;
  /**
   * A time step's period, a date, as the `YYYY-MM-DD` text `groupBy`
   * publishes for it: where the dialect has periods.
   */
  viewDay?(period: Sql): Sql;
}

export interface ViewBodyContext {
  /** The schema the view and every model its query reads belong to. */
  readonly schema: Schema;
  /** The schema's resolved views, where the caller already holds them. */
  readonly resolved?: ResolvedSchemaViews;
  /**
   * The adapter the body is written with, made for this one body (its table
   * renderer is wrapped to note what the body reads). The dialect's migration
   * driver makes it (`MigrationDriver.viewWriter`): one fixed configuration
   * per dialect, so that every driver of a dialect writes one text, in the
   * estate's PostgreSQL schema.
   */
  readonly adapter: DatabaseAdapter;
  /** How the same driver makes an expression a column of the view. */
  readonly columns: ViewColumnSql;
}

export interface ViewBody {
  /** The view's SELECT, bound values still in it. */
  readonly statement: Sql;
  /**
   * The decoder shape of a view row, what a client decodes: its scalars'
   * leaves and each JSON column's document, as JSON data. Members keep their
   * order (the order a carried document's array holds them in); a leaf drops
   * its scalar object and lists its enum values.
   */
  readonly shape: unknown;
  /**
   * Physical names of every table and view the statement reads, each once,
   * the source first: relation targets and junction tables, those its
   * filters read included.
   */
  readonly reads: readonly string[];
}

/** The period a refusal's message ends on, which the view's own adds again. */
const FINAL_STOP = /\.$/;

/**
 * A root whose query takes no window asks the page owner nothing, as a
 * related page that asked for none: no order, no limit.
 */
const UNORDERED: SqlSelectControls = { purpose: "root", unique: true };

/** A query clause a view cannot hold, and why, named with the view. */
function refuse(view: string, clause: string, reason: string): never {
  throw new UnsupportedOperationError(
    `View '${view}' cannot be created from a query that ${clause}: ${reason}.`,
    { meta: { model: view, feature: clause } }
  );
}

/** What a view's query may not say at its root, read off its admitted form. */
function refuseRoot(view: string, query: Arguments): void {
  if (query.cursor !== undefined)
    refuse(view, "pages from a cursor", "a paging anchor is not a row set");
  if (query.take !== undefined && query.take < 0)
    refuse(
      view,
      "takes a negative window",
      "a window read from the end is a read's, not a row set's"
    );
  if (query.take === undefined && query.orderBy !== undefined)
    refuse(
      view,
      "orders its rows without a take",
      "a view has no order; order its rows where they are read"
    );
  if (query.take === undefined && query.skip !== undefined)
    refuse(
      view,
      "skips rows without a take",
      "a view has no order to skip rows in"
    );
  if (query.orderBy === undefined) return;
  for (const term of entries(query.orderBy))
    for (const direction of Object.values(term))
      if (isRecord(direction) && direction._distance !== undefined)
        refuse(
          view,
          "orders by a distance",
          "the distance binds a query value per call"
        );
}

/**
 * The read compiler, writing a view's body. Built for one view, on an adapter
 * of its own.
 */
class ViewBodyQueries extends SqlQueries {
  readonly #view: string;
  /** The view's model: its columns' scalars. */
  readonly #model: AnyModel;
  readonly #columns: ViewColumnSql;
  /** The alias the root row is read under, set as the statement opens. */
  #root: string | undefined;

  constructor(
    schema: EngineSchema,
    adapter: DatabaseAdapter,
    view: AnyModel,
    columns: ViewColumnSql
  ) {
    super(schema, adapter);
    this.#view = nameOf(view);
    this.#model = view;
    this.#columns = columns;
  }

  override rootAlias(): string {
    this.#root = super.rootAlias();
    return this.#root;
  }

  /**
   * The root's scalars as stored, each its bare column under its column
   * name: the view's column is the table's, so a filter, an order or an
   * aggregate on the view means what it means on the table. Every other
   * member, and every row below the root, is projected as a read projects it.
   */
  override lowerProjection(
    projection: PreparedProjection,
    alias?: string,
    visible = false
  ): Sql[] {
    if (alias === undefined || alias !== this.#root)
      return super.lowerProjection(projection, alias, visible);
    if (refusesWhileDecoding(projection))
      refuse(
        this.#view,
        "reads a recursive relation or a polymorphic slot",
        "their reads can refuse while decoding, so every read of the view could"
      );
    const { model } = projection;
    const columns: Sql[] = [];
    for (const field of projection.fields) {
      if (field.kind === "distance")
        refuse(
          this.#view,
          "selects a distance",
          "the distance binds a query value per call"
        );
      columns.push(
        field.kind === "scalar"
          ? this.adapter.identifiers.aliased(
              this.column(model, field.name, alias),
              this.columnName(model, field.name)
            )
          : super.lowerProjection({ ...projection, fields: [field] }, alias)[0]!
      );
    }
    return columns;
  }

  /** A grouped field at the root, as stored: the view's column is the table's. */
  override projectedColumn(
    model: AnyModel,
    field: string,
    alias?: string
  ): Sql {
    return alias !== undefined && alias === this.#root
      ? this.column(model, field, alias)
      : super.projectedColumn(model, field, alias);
  }

  /**
   * A grouped root's aggregates, each its own column under the view's name
   * for it (`count`, `sumAmount`), read off the view's facts. A carried
   * aggregate below the root (a relation's `_aggregate`) is a read's.
   */
  protected override aggregateColumns(
    model: AnyModel,
    selection: PreparedAggregates,
    alias: string
  ): [string, Sql][] {
    const aggregated = viewFacts(this.#model)?.aggregated;
    if (alias !== this.#root || aggregated === undefined)
      return super.aggregateColumns(model, selection, alias);
    return Object.entries(aggregated.origins).flatMap(
      ([name, { aggregate, field }]): [string, Sql][] =>
        aggregate === undefined
          ? []
          : [[name, this.#aggregate(model, aggregate, field, alias, name)]]
    );
  }

  /**
   * One aggregate as a column of its scalar. The provider's own `SUM`, cast:
   * where a read splits a sum into parts its provider cannot overflow, the
   * view's column holds the sum its scalar holds. `MIN` and `MAX` answer
   * their column's type: a compact identifier is picked in the text it
   * travels in and stored back as its column stores it.
   */
  #aggregate(
    model: AnyModel,
    aggregate: ViewAggregate,
    field: string | undefined,
    alias: string,
    name: string
  ): Sql {
    const a = this.adapter;
    const column =
      field === undefined ? undefined : this.column(model, field, alias);
    const state =
      field === undefined ? undefined : scalarsOf(model)[field]?.["~"].state;
    if (aggregate === "_min" || aggregate === "_max") {
      const { id } = this.scalarShape(model, field!);
      const operand = aggregatedIdentifier(a, id, column!);
      const boolean = state?.type === "boolean";
      const picked =
        aggregate === "_min"
          ? a.aggregates.min(operand, boolean)
          : a.aggregates.max(operand, boolean);
      return isCompact(id)
        ? a.expressions.idCast(picked, id.representation)
        : picked;
    }
    const value =
      aggregate === "_count"
        ? a.aggregates.count(column)
        : aggregate === "_sum"
          ? a.aggregates.sum(column!)
          : state?.decimal === undefined
            ? a.aggregates.avg(column!)
            : a.aggregates.decimalAvg(column!, state.decimal);
    return this.#columns.viewCast(value, scalarsOf(this.#model)[name]!);
  }

  /** Every caller's SQL operand is settled here before it is lowered. */
  override settleRows(): Sql {
    return refuse(
      this.#view,
      "filters with an SQL fragment",
      "a view's query holds plain values, which its migration writes as literals"
    );
  }
}

/**
 * Leaves as JSON data: a scalar object is the leaf's declaring scalar, which
 * the leaf's other members already state; a set of enum values is listed.
 */
function asData(this: unknown, key: string, value: unknown): unknown {
  if (key === "scalar" && isRecord(this) && this.kind === "scalar")
    return undefined;
  return value instanceof Set ? [...value] : value;
}

/**
 * The body of `view`, a model of `context.schema` that `view` declared: its
 * declared query admitted as its source's `findMany` and compiled by the read
 * compiler without extension, row domain or call, refused where a view cannot
 * hold what it says (plan §2.2).
 */
export function viewBody(context: ViewBodyContext, view: AnyModel): ViewBody {
  const { source, query, aggregated } = viewFacts(view)!;
  const schema = new EngineSchema(context.schema, context.resolved);
  const { adapter, columns } = context;
  // Every persistent table a lowering names goes through this one renderer.
  const reads = new Set<string>([tableOf(source)]);
  const { identifiers, period } = adapter;
  adapter.identifiers = {
    ...identifiers,
    table: (name, alias) => {
      reads.add(name);
      return identifiers.table(name, alias);
    },
  };
  // A period is stored as the day a read publishes for it, not as the text
  // the read decodes that day from.
  if (period && columns.viewDay)
    Object.assign(adapter, {
      period: { ...period, text: (day: Sql) => columns.viewDay!(day) },
    });
  const name = nameOf(view);
  const queries = new ViewBodyQueries(schema, adapter, view, columns);
  const operation = aggregated ? "groupBy" : "findMany";
  // The refusal of a query its source does not take names the view, not
  // only the read of the source that would have taken it.
  let admitted: Arguments;
  try {
    admitted = schema.admit(source, operation, query);
  } catch (cause) {
    refuse(
      name,
      "its source does not take",
      cause instanceof Error ? cause.message : String(cause)
    );
  }
  refuseRoot(name, admitted);
  let statement: Sql;
  try {
    statement =
      aggregated === undefined &&
      admitted.take === undefined &&
      admitted.distinct === undefined
        ? queries.select(source, admitted, undefined, UNORDERED).sql
        : queries.read(source, operation, admitted).query.sql;
  } catch (cause) {
    // What the read compiler refuses on this dialect (a time step outside
    // PostgreSQL) is refused with the view named.
    if (cause instanceof FeatureNotSupportedError)
      refuse(
        name,
        "this database cannot read",
        cause.message.replace(FINAL_STOP, "")
      );
    throw cause;
  }
  return {
    statement,
    shape: JSON.parse(
      JSON.stringify(queries.prepareProjection(view, {}).shape, asData)
    ),
    reads: [...reads],
  };
}
