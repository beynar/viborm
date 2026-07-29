/**
 * Nested read window
 *
 * One place that turns a relation's read args (`where`/`orderBy`/`take`/`skip`)
 * into the WHERE / ORDER BY / LIMIT / OFFSET of the relation subquery.
 *
 * It runs the *same* pipeline the top level runs in `buildFind`
 * (`buildFindPagination` + `buildNormalizedOrderBy`), so nested pagination
 * cannot drift from top-level pagination: the same total scalar order with the
 * same identity tie-breakers, the same negative-`take` inversion (order flipped
 * in SQL, absolute limit, logical order restored on the result), the same
 * dialect-neutral cursor condition, and the same relation-order fallback when
 * the requested order is not a direct scalar sort.
 */

import type { Sql } from "@sql";
import { buildNormalizedOrderBy } from "../operations/cursor-order";
import { buildFindPagination } from "../operations/find-pagination";
import type { QueryScope } from "../types";
import { buildDistinctColumns } from "./distinct-builder";
import type { IncludeOptions } from "./include-query";
import { buildOrderByParts } from "./orderby-builder";
import { buildWhere } from "./where-builder";

export interface NestedReadWindow {
  /** Correlation, relation filter and cursor condition, combined. */
  where: Sql;
  orderBy: Sql | undefined;
  joins: Sql[];
  /** Absolute row limit — a negative `take` is executed as a reversed window. */
  limit: number | undefined;
  offset: number | undefined;
  /** DISTINCT columns, deduplicating the ordered rows before the window */
  distinct: Sql | undefined;
}

/**
 * @param ctx - Child scope on the related model
 * @param options - The relation's read args
 * @param alias - Alias of the related table inside the subquery
 * @param baseConditions - Correlation (and junction join) conditions
 */
export function buildNestedReadWindow(
  ctx: QueryScope,
  options: IncludeOptions,
  alias: string,
  baseConditions: readonly Sql[]
): NestedReadWindow {
  const { adapter } = ctx;
  const { where, orderBy, cursor, take, skip, distinct } = options;
  const pagination = buildFindPagination(
    ctx,
    { orderBy, cursor, skip },
    take,
    alias
  );

  const conditions: Sql[] = [...baseConditions];
  const innerWhere = buildWhere(ctx, where, alias);
  if (innerWhere) {
    conditions.push(innerWhere);
  }
  // The cursor row is located once (by its own unique key) and compared against
  // every candidate row of THIS parent's window, so the same cursor pages each
  // parent independently — and a cursor that matches no row leaves an empty
  // window, Prisma's semantics.
  if (pagination.cursorCondition) {
    conditions.push(pagination.cursorCondition);
  }

  const orderByParts = pagination.normalizedOrder
    ? {
        orderBy: buildNormalizedOrderBy(ctx, pagination.normalizedOrder),
        joins: [] as Sql[],
      }
    : buildOrderByParts(ctx, pagination.orderBy, alias);

  return {
    where: adapter.operators.and(...conditions),
    orderBy: orderByParts.orderBy,
    joins: orderByParts.joins,
    limit: take === undefined ? undefined : Math.abs(take),
    offset: skip,
    // Prisma order of application: distinct keeps the first row of each group in
    // the ordered rows, then take/skip window the deduplicated set — which is
    // what the adapter's DISTINCT assembly does (LIMIT/OFFSET are applied to the
    // outer, already-deduplicated query).
    distinct: distinct ? buildDistinctColumns(ctx, distinct, alias) : undefined,
  };
}
