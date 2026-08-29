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

  if (parts.orderBy) {
    fragments.push(sql`ORDER BY ${parts.orderBy}`);
  }

  appendLimitOffset(fragments, parts.limit, parts.offset, options.noLimitValue);
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
 * Simulate `SELECT DISTINCT ON` using ROW_NUMBER() window functions.
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
 *     ROW_NUMBER() OVER (PARTITION BY distinct_cols ORDER BY order_cols) AS _rn,
 *     ROW_NUMBER() OVER (ORDER BY order_cols) AS _ord  -- only when ORDER BY present
 *   FROM table
 *   WHERE ...
 * ) AS _distinct_subquery
 * WHERE _rn = 1
 * ORDER BY _ord
 * LIMIT ... OFFSET ...
 *
 * The outer ORDER BY uses the precomputed _ord rank because the user's
 * ORDER BY references inner table aliases (and relation-order joins) that
 * are out of scope outside the subquery.
 */
export const assembleDistinctOnEmulation = (
  parts: QueryParts,
  distinct: Sql,
  escapeIdentifier: (name: string) => Sql,
  noLimitValue?: Sql
): Sql => {
  // ORDER BY for ROW_NUMBER() - use provided orderBy or default to distinct columns
  const rowNumberOrder = parts.orderBy || distinct;

  const selectColumns: Sql[] = [
    parts.columns,
    sql`ROW_NUMBER() OVER (PARTITION BY ${distinct} ORDER BY ${rowNumberOrder}) AS ${escapeIdentifier("_rn")}`,
  ];

  if (parts.orderBy) {
    selectColumns.push(
      sql`ROW_NUMBER() OVER (ORDER BY ${parts.orderBy}) AS ${escapeIdentifier("_ord")}`
    );
  }

  // Inner query with ROW_NUMBER()
  const innerFragments: Sql[] = [
    sql`SELECT ${sql.join(selectColumns, ", ")}`,
    sql`FROM ${parts.from}`,
  ];

  if (parts.joins && parts.joins.length > 0) {
    innerFragments.push(...parts.joins);
  }

  if (parts.where) {
    innerFragments.push(sql`WHERE ${parts.where}`);
  }

  if (parts.groupBy) {
    innerFragments.push(sql`GROUP BY ${parts.groupBy}`);
  }

  if (parts.having) {
    innerFragments.push(sql`HAVING ${parts.having}`);
  }

  const innerQuery = sql.join(innerFragments, " ");

  // Build outer SELECT - use explicit column aliases to exclude _rn/_ord
  let outerSelect: Sql;
  if (parts.distinctColumnAliases && parts.distinctColumnAliases.length > 0) {
    const aliasColumns = parts.distinctColumnAliases.map((alias) =>
      escapeIdentifier(alias)
    );
    outerSelect = sql`SELECT ${sql.join(aliasColumns, ", ")} FROM (${innerQuery}) AS ${escapeIdentifier("_distinct_subquery")}`;
  } else {
    // Fallback to SELECT * (includes _rn/_ord)
    outerSelect = sql`SELECT * FROM (${innerQuery}) AS ${escapeIdentifier("_distinct_subquery")}`;
  }

  // Outer query that filters for first row of each partition
  const outerFragments: Sql[] = [
    outerSelect,
    sql`WHERE ${escapeIdentifier("_rn")} = 1`,
  ];

  if (parts.orderBy) {
    outerFragments.push(sql`ORDER BY ${escapeIdentifier("_ord")}`);
  }

  appendLimitOffset(outerFragments, parts.limit, parts.offset, noLimitValue);

  return sql.join(outerFragments, " ");
};
