import { type Sql, sql } from "@sql";
import type { QueryParts } from "../adapter-query-parts";

interface SelectAssemblyOptions {
  forUpdate: "append" | "omit";
  /** LIMIT value meaning "no limit", for dialects that reject OFFSET without LIMIT */
  noLimitValue?: Sql;
}

export const assembleSelectQuery = (
  selectClause: Sql,
  parts: QueryParts,
  options: SelectAssemblyOptions
): Sql => {
  const fragments: Sql[] = [selectClause, sql`FROM ${parts.from}`];

  appendSelectParts(fragments, parts, options);

  if (options.forUpdate === "append" && parts.forUpdate) {
    fragments.push(sql.raw`FOR UPDATE`);
  }

  return sql.join(fragments, " ");
};

const appendSelectParts = (
  fragments: Sql[],
  parts: QueryParts,
  options: SelectAssemblyOptions
): void => {
  appendFilterParts(fragments, parts);

  if (parts.orderBy) {
    fragments.push(sql`ORDER BY ${parts.orderBy}`);
  }

  appendLimitOffset(fragments, parts.limit, parts.offset, options.noLimitValue);
};

/** Joins, WHERE, GROUP BY and HAVING: shared by the plain and the emulated-DISTINCT select. */
const appendFilterParts = (fragments: Sql[], parts: QueryParts): void => {
  if (parts.joins && parts.joins.length > 0) {
    fragments.push(...parts.joins);
  }

  if (parts.where) {
    fragments.push(sql`WHERE ${parts.where}`);
  }

  if (parts.groupBy) {
    fragments.push(sql`GROUP BY ${parts.groupBy}`);
  }

  if (parts.having) {
    fragments.push(sql`HAVING ${parts.having}`);
  }
};

const appendLimitOffset = (
  fragments: Sql[],
  limit: Sql | undefined,
  offset: Sql | undefined,
  noLimitValue: Sql | undefined
): void => {
  if (limit) {
    fragments.push(sql`LIMIT ${limit}`);
  } else if (offset && noLimitValue) {
    // Dialects like MySQL/SQLite have no bare OFFSET; emit their "no limit" sentinel
    fragments.push(sql`LIMIT ${noLimitValue}`);
  }

  if (offset) {
    fragments.push(sql`OFFSET ${offset}`);
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
  const innerFragments: Sql[] = [
    sql`SELECT ${sql.join(selectColumns, ", ")}`,
    sql`FROM ${parts.from}`,
  ];

  appendFilterParts(innerFragments, parts);

  const innerQuery = sql.join(innerFragments, " ");

  // Outer query that filters for first row of each partition. It names the
  // output columns so _rn/_ordN stay inside: every engine DISTINCT carrier
  // states its aliases.
  const aliasColumns = parts.distinctColumnAliases!.map(escapeIdentifier);
  const outerFragments: Sql[] = [
    sql`SELECT ${sql.join(aliasColumns, ", ")} FROM (${innerQuery}) AS ${escapeIdentifier("_distinct_subquery")}`,
    sql`WHERE ${escapeIdentifier("_rn")} = 1`,
  ];

  if (order) {
    outerFragments.push(sql`ORDER BY ${order.orderBy}`);
  }

  appendLimitOffset(outerFragments, parts.limit, parts.offset, noLimitValue);

  return sql.join(outerFragments, " ");
};
