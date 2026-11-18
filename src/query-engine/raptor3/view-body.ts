/**
 * The body of a database view, for the migrations
 * (`docs/architecture/schema-views-plan.md` §3.1): the view's declared read,
 * compiled by the read compiler itself. {@link ViewBodyQueries} changes two
 * things of a read and nothing else: its root scalars are projected as
 * stored, under their column names, and its root states no order unless it
 * takes a window. Its documents (relations, `_count`, `_aggregate`) are
 * projected as a read carries them, so the client decodes a view's JSON
 * column with the decoder of the read that carried it.
 *
 * Only the migrations import this module: nothing the client or the engine
 * imports reaches it, so no application bundle carries it.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { SqlDialect } from "@drivers/types";
import { UnsupportedOperationError } from "@errors";
import type { Schema } from "@schema/hydration";
import type { AnyModel } from "@schema/model";
import { viewFacts } from "@schema/view/facts";
import type { Sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import { type PreparedProjection, refusesWhileDecoding } from "./shared/query";
import {
  type Arguments,
  EngineSchema,
  entries,
  type ResolvedSchemaViews,
} from "./shared/schema";
import { SqlQueries, type SqlSelectControls } from "./shared/sql-queries";
import { nameOf, tableOf } from "./shared/terms";

export interface ViewBodyContext {
  /** The schema the view and every model its query reads belong to. */
  readonly schema: Schema;
  /** The schema's resolved views, where the caller already holds them. */
  readonly resolved?: ResolvedSchemaViews;
  /** The dialect the body is written in: one text for every driver of it. */
  readonly dialect: SqlDialect;
  /** The estate's namespace: a PostgreSQL schema, a MySQL database. */
  readonly namespace?: string;
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

/**
 * The adapter of `dialect` under one fixed configuration, so that two drivers
 * of one dialect write one text: no shared relation bodies, no bound a
 * transport puts on a statement (D1's expression depth and compound terms,
 * Neki's relations), every tier a column of the schema may need.
 */
function fixedAdapter(
  dialect: SqlDialect,
  namespace?: string
): DatabaseAdapter {
  if (dialect === "sqlite") return new SQLiteAdapter();
  if (dialect === "mysql") return new MySQLAdapter(namespace);
  const adapter = new PostgresAdapter(namespace, true);
  adapter.capabilities.supportsVector = true;
  return adapter;
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
  /** The alias the root row is read under, set as the statement opens. */
  #root: string | undefined;

  constructor(schema: EngineSchema, adapter: DatabaseAdapter, view: string) {
    super(schema, adapter);
    this.#view = view;
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
  const { source, query } = viewFacts(view)!;
  const schema = new EngineSchema(context.schema, context.resolved);
  const adapter = fixedAdapter(context.dialect, context.namespace);
  // Every persistent table a lowering names goes through this one renderer.
  const reads = new Set<string>([tableOf(source)]);
  const { identifiers } = adapter;
  adapter.identifiers = {
    ...identifiers,
    table: (name, alias) => {
      reads.add(name);
      return identifiers.table(name, alias);
    },
  };
  const name = nameOf(view);
  const queries = new ViewBodyQueries(schema, adapter, name);
  // The refusal of a query its source does not take names the view, not
  // only the read of the source that would have taken it.
  let admitted: Arguments;
  try {
    admitted = schema.admit(source, "findMany", query);
  } catch (cause) {
    refuse(
      name,
      "its source does not take",
      cause instanceof Error ? cause.message : String(cause)
    );
  }
  refuseRoot(name, admitted);
  const statement =
    admitted.take === undefined && admitted.distinct === undefined
      ? queries.select(source, admitted, undefined, UNORDERED).sql
      : queries.read(source, "findMany", admitted).query.sql;
  return {
    statement,
    shape: JSON.parse(
      JSON.stringify(queries.prepareProjection(view, {}).shape, asData)
    ),
    reads: [...reads],
  };
}
