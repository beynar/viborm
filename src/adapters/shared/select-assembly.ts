import { Sql, sql } from "@sql";
import type { QueryParts } from "../adapter-query-parts";

interface SelectAssemblyOptions {
  forUpdate: "append" | "omit";
  /** LIMIT value meaning "no limit", for dialects that reject OFFSET without LIMIT */
  noLimitValue?: Sql;
}

/**
 * A statement's clauses, each word before its operand, as ONE fragment: a
 * fragment per clause and their join were up to seven more for every SELECT
 * the engine assembles, each made here and walked again where the statement
 * is rendered (2 % to 4 % of a read's client CPU).
 */
interface Clauses {
  readonly strings: string[];
  readonly values: Sql[];
}

const clause = (into: Clauses, word: string, operand: Sql): void => {
  into.strings.push(word);
  into.values.push(operand);
};

/**
 * A SELECT's clauses, begun with room for the ones it takes next. A list of
 * two members that takes a third by `push` is copied into a store of
 * nineteen: 240 bytes more for every SELECT the engine assembles, seven of
 * them in a read of two relation levels. The lists are written longer and cut
 * back, which keeps their store, so a WHERE, an ORDER BY, a LIMIT and an
 * OFFSET land in place.
 */
const begun = (first: string, second: string, a: Sql, b: Sql): Clauses => {
  const strings = [first, second, "", "", "", "", "", ""];
  const values = [a, b, a, a, a, a];
  strings.length = 2;
  values.length = 2;
  return { strings, values };
};

const closed = (clauses: Clauses, last = ""): Sql => {
  clauses.strings.push(last);
  return new Sql(clauses.strings, clauses.values);
};

/** `distinctOn`: the columns of PostgreSQL's `DISTINCT ON`, where the page is one. */
export const assembleSelectQuery = (
  parts: QueryParts,
  options: SelectAssemblyOptions,
  distinctOn?: Sql
): Sql => {
  const query: Clauses = distinctOn
    ? {
        strings: ["SELECT DISTINCT ON (", ") ", " FROM "],
        values: [distinctOn, parts.columns, parts.from],
      }
    : begun("SELECT ", " FROM ", parts.columns, parts.from);

  appendFilterParts(query, parts);

  if (parts.orderBy) {
    clause(query, " ORDER BY ", parts.orderBy);
  }

  appendLimitOffset(query, parts.limit, parts.offset, options.noLimitValue);

  return closed(
    query,
    options.forUpdate === "append" && parts.forUpdate ? " FOR UPDATE" : ""
  );
};

/** Joins, WHERE, GROUP BY and HAVING: shared by the plain and the emulated-DISTINCT select. */
const appendFilterParts = (into: Clauses, parts: QueryParts): void => {
  if (parts.joins) {
    for (const join of parts.joins) clause(into, " ", join);
  }

  if (parts.where) {
    clause(into, " WHERE ", parts.where);
  }

  if (parts.groupBy) {
    clause(into, " GROUP BY ", parts.groupBy);
  }

  if (parts.having) {
    clause(into, " HAVING ", parts.having);
  }
};

const appendLimitOffset = (
  into: Clauses,
  limit: Sql | undefined,
  offset: Sql | undefined,
  noLimitValue: Sql | undefined
): void => {
  if (limit) {
    clause(into, " LIMIT ", limit);
  } else if (offset && noLimitValue) {
    // Dialects like MySQL/SQLite have no bare OFFSET; emit their "no limit" sentinel
    clause(into, " LIMIT ", noLimitValue);
  }

  if (offset) {
    clause(into, " OFFSET ", offset);
  }
};

/**
 * Simulate `SELECT DISTINCT ON` using one ROW_NUMBER() window.
 *
 * Used by MySQL/SQLite (no DISTINCT ON support) and by PostgreSQL when an
 * ORDER BY is present: DISTINCT ON would require the ORDER BY to lead with
 * the distinct columns, which changes result ordering. This emulation keeps
 * Prisma semantics — rows are ordered by the user's ORDER BY, then the first
 * row of each distinct group is kept, preserving that order.
 *
 * Generates:
 * SELECT col1, col2, ... FROM (
 *   SELECT columns,
 *     order_term_1 AS _ord0, ...  -- only when ORDER BY present
 *     ROW_NUMBER() OVER (PARTITION BY distinct_cols ORDER BY order_cols) AS _rn
 *   FROM table
 *   WHERE ...
 * ) AS _distinct_subquery
 * WHERE _rn = 1
 * ORDER BY _ord0, ...
 * LIMIT ... OFFSET ...
 *
 * The outer ORDER BY reads the projected `_ordN` terms because the user's
 * ORDER BY references inner table aliases (and relation-order joins) that
 * are out of scope outside the subquery. Ordering the kept rows by those
 * values (and not by a second window ranking every row) spares one sort.
 */
export const assembleDistinctOnEmulation = (
  parts: QueryParts,
  distinct: Sql,
  escapeIdentifier: (name: string) => Sql,
  noLimitValue?: Sql
): Sql => {
  // ORDER BY for ROW_NUMBER() - use provided orderBy or default to distinct columns
  const rowNumberOrder = parts.distinctOrderBy ?? parts.orderBy ?? distinct;
  const order = parts.distinctOrder;

  const selectColumns: Sql[] = [parts.columns];
  if (order) {
    selectColumns.push(order.keys);
  }
  selectColumns.push(
    sql`ROW_NUMBER() OVER (PARTITION BY ${distinct} ORDER BY ${rowNumberOrder}) AS ${escapeIdentifier("_rn")}`
  );

  // Inner query with ROW_NUMBER()
  const inner: Clauses = {
    strings: ["SELECT ", " FROM "],
    values: [sql.join(selectColumns, ", "), parts.from],
  };

  appendFilterParts(inner, parts);

  const innerQuery = closed(inner);

  // Outer query that filters for first row of each partition. It names the
  // output columns so _rn/_ordN stay inside: every engine DISTINCT carrier
  // states its aliases.
  const aliasColumns = parts.distinctColumnAliases!.map(escapeIdentifier);
  const outer: Clauses = {
    strings: [""],
    values: [
      sql`SELECT ${sql.join(aliasColumns, ", ")} FROM (${innerQuery}) AS ${escapeIdentifier("_distinct_subquery")} WHERE ${escapeIdentifier("_rn")} = 1`,
    ],
  };

  if (order) {
    clause(outer, " ORDER BY ", order.orderBy);
  }

  appendLimitOffset(outer, parts.limit, parts.offset, noLimitValue);

  return closed(outer);
};
