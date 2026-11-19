/**
 * Views on SurrealDB (`docs/architecture/schema-views-plan.md` §2.7): a table
 * the database computes, `DEFINE TABLE <view> AS SELECT … FROM <source> WHERE
 * …`, which it keeps current for every write to its source (measured on
 * SurrealDB 4.0: a create, an update and a delete reach it at once, and a view
 * on a view follows).
 *
 * The database follows writes to the source table and to nothing else: a link
 * traversal or a subquery parses there and goes stale (a later change to the
 * linked row is never applied), and `ORDER BY`, `LIMIT` and `START` do not
 * parse. So a view here is its source's own fields, filtered on its own
 * fields: anything else is refused with the view named.
 *
 * Each row keeps its source record's id under the view's table (`v:p1` for
 * `t:p1`, an array id whole), so the body selects `id` and each projected
 * field by the name it is stored under: a view's field holds exactly what its
 * source's holds, and a read of the view asks for it by that name
 * (`SurrealQueries.keyOrder`).
 *
 * The filter is lowered by the read backend that answers `findMany` on the
 * source, taken from the SurrealDB driver the migration is bound to, and its
 * bound values are written as SurrealQL literals. It asks first that the row
 * is there: the database reads it of a deleted row too. Nothing here imports that
 * driver or its SDK: every dialect's migrations load this module, and the SDK
 * is an optional peer.
 *
 * An aggregated view (`by`) is `SELECT <by fields>, <aggregates> FROM
 * <source> [WHERE …] GROUP BY <by fields>`, which the database keeps current
 * for every write to its source, a group that empties going with its last
 * row (measured on SurrealDB 4.0). Its row is a group, idded by the list of
 * the values it groups by, in `by` order (`v:[1, 'EUR']`), so a read finds
 * each grouped field in the id. A key or a link of the source is a record
 * there, and the group is by its key's value (`record::id(…)`), which is
 * what the view's column holds and what a table's column naming the view's
 * key holds; the server groups by an expression's alias. An integer is an
 * int there, as a record's integer key is, so that a lookup by its value
 * finds the group's record: a field of `s.int()` is stored as an i32, which
 * a record id holds apart (a nullable one is left as stored: `<int>` refuses
 * NONE, and the view then has no key to look up).
 */

import type { AnyDriver } from "@drivers/driver";
import { quantized } from "@drivers/surrealdb/quantized";
import type { SurrealQueries } from "@drivers/surrealdb/queries";
import { UnsupportedOperationError } from "@errors";
import type {
  PreparedPredicate,
  Queries,
} from "@query-engine/raptor3/shared/query";
import { engineBackend } from "@query-engine/raptor3/shared/query-backend";
import {
  type Arguments,
  EngineSchema,
} from "@query-engine/raptor3/shared/schema";
import { nameOf, tableOf } from "@query-engine/raptor3/shared/terms";
import type { AnyModel } from "@schema/model";
import {
  type ViewAggregate,
  type ViewColumnOrigin,
  viewFacts,
} from "@schema/view/facts";
import { Sql, sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import type { ViewBodyWriter } from "../base";

/** Why a view here reads its source's own fields and nothing else. */
const STALE =
  "SurrealDB keeps a view current for writes to its source table only, so what it reads of another table would go stale";
/** Why a view here holds every row of its query, in no order. */
const UNORDERED =
  "SurrealDB keeps no order and no window in a view (ORDER BY, LIMIT and START do not parse in DEFINE TABLE … AS)";

/** Why a view here holds no filter of its groups. */
const UNFILTERED =
  "SurrealDB keeps a view's groups current from its source's rows and has no filter of the groups themselves (no HAVING); filter them in a view over this one";
/** Why a view here groups by fields and not by periods. */
const NO_STEP = "groupBy reads no time step on SurrealDB, so no view holds one";
/** Why a view here holds no sum or average of doubles. */
const DRIFT =
  "SurrealDB keeps a view's sum by adding and subtracting each write, which on doubles drifts from the sum groupBy reads (0.1 + 0.2 + 0.3 - 0.2 is not 0.1 + 0.3)";
/** Why a view here holds no aggregate of a record. */
const RECORD =
  "a key or a link is a record there, which a view's math reads as no number";
/** Why a view here holds a least or greatest value of numbers and dateTimes only. */
const EXTREMES =
  "SurrealDB keeps a view's least and greatest values current for numbers (math::min, math::max) and dateTimes (time::min, time::max) only";

/** What a refusal says an aggregate of a value does. */
const VERBS: Readonly<Record<Exclude<ViewAggregate, "_count">, string>> = {
  _sum: "sums",
  _avg: "averages",
  _min: "takes the least",
  _max: "takes the greatest",
};

/** A query clause a view cannot hold on SurrealDB, and why, named with the view. */
function refuse(clause: string, view: string, reason: string): never {
  throw new UnsupportedOperationError(
    `View '${view}' cannot be created from a query that ${clause}: ${reason}.`,
    { meta: { model: view, feature: clause, dialect: "surrealql" } }
  );
}

/** What a view's query may not say at its root here, read off its admitted form. */
function refuseRoot(view: string, query: Arguments): void {
  if (query.cursor !== undefined)
    refuse("pages from a cursor", view, "a paging anchor is not a row set");
  if (query.take !== undefined) refuse("takes a window", view, UNORDERED);
  if (query.skip !== undefined) refuse("skips rows", view, UNORDERED);
  if (query.orderBy !== undefined) refuse("orders its rows", view, UNORDERED);
  if (query.distinct !== undefined)
    refuse(
      "keeps one row per distinct value",
      view,
      "a view on SurrealDB holds one row per row of its source"
    );
}

/**
 * Refuses a filter that is not the source's own fields compared with plain
 * values: a relation (or any read of another table) would go stale, and a
 * caller's SQL fragment has no literal.
 */
function refuseFilter(view: string, predicate: PreparedPredicate): void {
  switch (predicate.kind) {
    case "and":
    case "or":
      for (const inner of predicate.predicates) refuseFilter(view, inner);
      return;
    case "not":
      refuseFilter(view, predicate.predicate);
      return;
    case "always":
      return;
    case "operation": {
      const operands = [
        ...(predicate.operand ? [predicate.operand] : []),
        ...(predicate.operands ?? []),
      ];
      if (
        predicate.value instanceof Sql ||
        operands.some(
          (operand) =>
            operand.kind === "sql" ||
            operand.kind === "parameter" ||
            (operand.kind === "value" && operand.value instanceof Sql)
        )
      )
        refuse(
          "filters with an SQL fragment",
          view,
          "a view's query holds plain values, which its migration writes as literals"
        );
      return;
    }
    default:
      refuse("filters through a relation", view, STALE);
  }
}

/**
 * One column of an aggregated view's group, as the database keeps it current
 * for every write to its source: `count`, `math::sum`, `math::mean`,
 * `math::min`, `math::max`, `time::min` and `time::max`, and expressions over
 * them (measured on SurrealDB 4.0). Each is what groupBy reads on the source,
 * so the view's row decodes what groupBy answers: a sum of bigints and their
 * average are kept in a decimal, which no write carries past 64 bits (an int
 * would refuse the write that does); an average of decimals lands on the
 * field's scale as groupBy's does; a group of no value is NULL, where the
 * database's sum is 0 and its average NaN.
 */
function aggregateOf(
  view: string,
  source: AnyModel,
  low: SurrealQueries["lowering"],
  { field, aggregate }: ViewColumnOrigin
): Sql {
  if (field === undefined) return sql.raw("count()");
  const column = low.physical(source, field);
  if (aggregate === "_count") return sql`count(${column} != NONE)`;
  const verb = VERBS[aggregate!];
  if (low.isRecord(source, field))
    refuse(`${verb} '${field}', which holds a record`, view, RECORD);
  const state = source["~"].state.scalars[field]!["~"].state;
  const { type } = state;
  let value: Sql;
  if (aggregate === "_min" || aggregate === "_max") {
    const least = aggregate === "_min";
    if (type === "datetime")
      value = sql`${sql.raw(least ? "time::min" : "time::max")}(${column})`;
    else if (
      type === "int" ||
      type === "bigint" ||
      type === "number" ||
      type === "decimal"
    )
      value = sql`${sql.raw(least ? "math::min" : "math::max")}(${column})`;
    else
      refuse(
        `${verb} '${field}', which is no number and no dateTime`,
        view,
        EXTREMES
      );
  } else {
    if (type === "number") refuse(`${verb} the double '${field}'`, view, DRIFT);
    // A bigint is summed as a decimal, past an int's range. An unset one
    // stays unset, which the sum skips, where `<decimal>` of it would fail
    // every write that leaves the field unset (measured).
    const operand =
      type === "bigint"
        ? sql`<${sql.raw(state.nullable ? "option<decimal>" : "decimal")}> ${column}`
        : column;
    value =
      aggregate === "_sum"
        ? sql`math::sum(${operand})`
        : quantized(state, sql`math::mean(${operand})`);
  }
  return state.nullable
    ? sql`(IF count(${column} != NONE) = 0 { NULL } ELSE { ${value} })`
    : value;
}

/**
 * The type a grouped column is cast to, so that a group is named by the
 * value a lookup binds: an int, whatever holds it, and a decimal or an
 * instant read `fromRecord`, whose key is that value's text.
 */
function keyCastOf(type: string, fromRecord: boolean): string | undefined {
  if (type === "int" || type === "bigint") return "int";
  return fromRecord && (type === "decimal" || type === "datetime")
    ? type
    : undefined;
}

/** What a refusal of a value names it by. */
const kindOf = (value: unknown): string => {
  if (Array.isArray(value)) return "array";
  if (typeof value === "object" && value !== null)
    return value.constructor?.name ?? "object";
  return typeof value;
};

function refuseValue(
  value: unknown,
  why = "no read of SurrealDB binds one"
): never {
  const kind = kindOf(value);
  throw new UnsupportedOperationError(
    `A view body binds a value of kind "${kind}", which has no SurrealQL literal: ${why}.`,
    { meta: { dialect: "surrealql", feature: "view literal", type: kind } }
  );
}

/**
 * The SDK's own brand of one of its values: what its `instanceof` and its
 * encoder test, in the global symbol registry, so that no copy of the SDK has
 * to be imported to read it.
 */
const branded = (value: object, kind: string): boolean =>
  (value as Record<symbol, unknown>)[Symbol.for(`surrealdb.${kind}`)] === true;

/** A UTF-16 surrogate without its pair: the SDK sends U+FFFD for it, and a literal cannot spell it. */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** The integers the SDK sends as integers: past them, a float. */
const LARGEST_INTEGER = 2 ** 53;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/**
 * A string's SurrealQL spelling: its JSON text, whose escapes SurrealQL reads
 * as JSON does (a line break included, so no statement spans two lines).
 */
function text(value: string): string {
  if (LONE_SURROGATE.test(value))
    refuseValue(value, "it holds a lone UTF-16 surrogate");
  return JSON.stringify(value);
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A number as the SDK encodes it: an integer up to 2^53, a float otherwise
 * (negative zero and a larger integer included, `f` making them one).
 */
function number(value: unknown): string {
  if (typeof value !== "number") return refuseValue(value);
  if (!Number.isFinite(value)) return refuseValue(value, "it is not finite");
  if (Object.is(value, -0)) return "-0f";
  if (Number.isInteger(value) && Math.abs(value) > LARGEST_INTEGER)
    return `${value}f`;
  return String(value);
}

/**
 * The SurrealQL literal that reads as the value the SDK sends for `value`
 * (its encoder's replacer, `surrealdb` 2.2), each measured equal to the bound
 * value on SurrealDB 4.0: `NONE` and `NULL`, an integer or a float, an `int`
 * within 64 bits, `s"…"`, `d"…"`, `b"<hex>"`, `<decimal>dec`, `r"<record>"`
 * in the SDK's own spelling of a record id, `(x, y)`, and arrays and records
 * of those. Any other value is refused: no read of the driver binds it.
 */
function literal(value: unknown): string {
  if (value === null) return "NULL";
  if (value === undefined) return "NONE";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return `s${text(value)}`;
  if (typeof value === "number") return number(value);
  if (typeof value === "bigint")
    return value >= I64_MIN && value <= I64_MAX
      ? String(value)
      : refuseValue(value, "a SurrealDB int holds 64 bits");
  if (typeof value !== "object") return refuseValue(value);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      return refuseValue(value, "it is not an instant");
    return `d${JSON.stringify(value.toISOString())}`;
  }
  // A Node `Buffer` too: the SDK sends every `Uint8Array` as bytes.
  if (value instanceof Uint8Array) return `b"${hex(value)}"`;
  if (branded(value, "Decimal")) return `${String(value)}dec`;
  if (branded(value, "RecordId")) return `r${text(String(value))}`;
  if (branded(value, "GeometryPoint")) {
    const { point } = value as { readonly point?: readonly unknown[] };
    return `(${number(point?.[0])}, ${number(point?.[1])})`;
  }
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  const prototype = Object.getPrototypeOf(value);
  if (
    isRecord(value) &&
    !branded(value, "Value") &&
    (prototype === Object.prototype || prototype === null)
  )
    return `{ ${Object.entries(value)
      .map(([key, member]) => `${text(key)}: ${literal(member)}`)
      .join(", ")} }`;
  return refuseValue(value);
}

/** `statement` as parameter-free SurrealQL: each bound value written as its literal. */
function inlined(statement: Sql): string {
  const { strings, values } = Sql.peek(statement);
  let written = strings[0]!;
  for (const [index, value] of values.entries())
    written += literal(value) + strings[index + 1]!;
  return written;
}

/**
 * Leaves as JSON data, as `viewBody` writes a view's shape: a scalar object is
 * the leaf's declaring scalar, which the leaf's other members already state;
 * a set of enum values is listed.
 */
function asData(this: unknown, key: string, value: unknown): unknown {
  if (key === "scalar" && isRecord(this) && this.kind === "scalar")
    return undefined;
  return value instanceof Set ? [...value] : value;
}

/** Whether the bound driver's `Queries` are SurrealDB's: their reads have a lowering. */
const lowers = (queries: Queries): queries is SurrealQueries =>
  "lowering" in queries;

/**
 * SurrealDB's view writer, over the SurrealDB driver the migration is bound
 * to: `SELECT id, <fields> FROM <source> [WHERE …]`, the filter lowered as a
 * read of the source lowers it. `identifier` writes a table's name as the
 * migration driver's DDL does.
 */
export function surrealViewWriter(
  driver: AnyDriver | undefined,
  identifier: (name: string) => string
): ViewBodyWriter {
  return {
    write(context, view) {
      const { source, query, columns, documents, aggregated } =
        viewFacts(view)!;
      const schema = new EngineSchema(context.schema, context.resolved);
      const name = nameOf(view);
      const queries =
        driver?.backend &&
        new (engineBackend(driver.backend).queries)(schema, driver.adapter);
      if (!(queries && lowers(queries)))
        throw new UnsupportedOperationError(
          `View '${name}' is written by the read backend of the SurrealDB driver it is migrated with, and this migration is bound to none.`,
          { meta: { model: name, feature: "view", dialect: "surrealql" } }
        );
      // The refusal of a query its source does not take names the view, not
      // only the read of the source that would have taken it.
      let admitted: Arguments;
      try {
        admitted = schema.admit(
          source,
          aggregated ? "groupBy" : "findMany",
          query
        );
      } catch (cause) {
        refuse(
          "its source does not take",
          name,
          cause instanceof Error ? cause.message : String(cause)
        );
      }
      refuseRoot(name, admitted);
      if (admitted.having !== undefined)
        refuse("keeps the groups a having holds", name, UNFILTERED);
      // A relation, `_count` and `_aggregate` are documents read of other rows.
      const [document] = documents;
      if (document !== undefined)
        refuse(`selects '${document}' through a relation`, name, STALE);
      const low = queries.lowering;
      const keys = queries.keyOrder(view);
      const grouped: Sql[] = [];
      const fields = aggregated
        ? Object.entries(aggregated.origins).map(([column, origin]) => {
            if (origin.step !== undefined)
              refuse("groups by a time step", name, NO_STEP);
            const alias = sql.raw(identifier(column));
            if (origin.aggregate !== undefined)
              return sql`${aggregateOf(name, source, low, origin)} AS ${alias}`;
            const stored = low.physical(source, origin.field!);
            const { type, nullable } = aggregated.scalars[column]!["~"].state;
            // A group is named by values: a key's or a link's, not its
            // record. An unset link names none, where `record::id` of it
            // would fail every write that leaves the link unset (measured).
            const key = sql`record::id(${stored})`;
            const held = low.isRecord(source, origin.field!)
              ? nullable
                ? sql`(IF ${stored} { ${key} })`
                : key
              : stored;
            // An int column is stored as an i32, which a record id holds
            // apart from the int a lookup by value names, and a record's
            // key that is a decimal or an instant is its text, which a
            // lookup by value does not name either; a cast refuses an unset
            // value, which its `option` keeps.
            const cast = keyCastOf(type, held !== stored);
            const value = cast
              ? sql`<${sql.raw(nullable ? `option<${cast}>` : cast)}> ${held}`
              : held;
            grouped.push(alias);
            return value.toStatement() === alias.toStatement()
              ? value
              : sql`${value} AS ${alias}`;
          })
        : [
            sql.raw("id"),
            ...columns
              .filter((field) => !keys.includes(field))
              .map((field) => low.physical(source, field)),
          ];
      const predicate =
        admitted.where === undefined
          ? undefined
          : queries.prepareSelector(source, admitted.where).predicate;
      if (predicate !== undefined) refuseFilter(name, predicate);
      // The database reads a view's filter of a deleted row too, every field
      // of it NONE: a function refusing NONE there fails the delete (measured).
      // The filter holds of a row that is there.
      const filter =
        predicate === undefined
          ? sql.raw("")
          : sql` WHERE id != NONE AND (${low.predicate(predicate, true)})`;
      const grouping = grouped.length
        ? sql` GROUP BY ${sql.join(grouped, ", ")}`
        : sql.raw("");
      return {
        sql: inlined(
          sql`SELECT ${sql.join(fields, ", ")} FROM ${sql.raw(identifier(tableOf(source)))}${filter}${grouping}`
        ),
        shape: JSON.parse(
          JSON.stringify(queries.prepareProjection(view, {}).shape, asData)
        ),
        reads: [tableOf(source)],
      };
    },
  };
}
