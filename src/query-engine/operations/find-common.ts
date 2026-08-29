/**
 * Find Common
 *
 * Shared logic for findFirst/findMany operations.
 * Handles cursor-based pagination and distinct.
 */

import {
  assembleAdapterSelect,
  type QueryParts,
} from "@adapters/adapter-internals";
import { type Sql, sql } from "@sql";
import { buildDistinctColumns } from "../builders/distinct-builder";
import { buildOrderByParts } from "../builders/orderby-builder";
import { buildSelectWithAliases } from "../builders/select-builder";
import { buildWhere } from "../builders/where-builder";
import { getTableName } from "../context";
import type { QueryScope } from "../types";
import { buildNormalizedOrderBy } from "./cursor-order";
import { buildFindPagination } from "./find-pagination";

/**
 * Common find arguments
 */
export interface FindArgs {
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown> | Record<string, unknown>[];
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  cursor?: Record<string, unknown>;
  skip?: number;
  distinct?: string[];
  /** Add FOR UPDATE row locking (engine-internal, e.g. MySQL refetch flows) */
  forUpdate?: boolean;
}

export type FindFirstArgs = FindArgs;

export interface FindManyArgs extends FindArgs {
  /** Maximum number of records to return. */
  take?: number;
}

/** Internal SQL facts that refine a normal find without entering public input. */
export interface FindSqlOptions {
  /** A trusted predicate already built for this query's table reference. */
  predicate?: Sql;
  /** Projection expressions that already carry their result aliases. */
  additionalColumns?: readonly Sql[];
}

/**
 * Options for buildFind
 */
export interface FindOptions extends FindSqlOptions {
  /** Limit number of results (1 for findFirst, take value for findMany, undefined for no limit) */
  limit?: number | undefined;
}

/**
 * Build SQL for find operations (shared between findFirst and findMany)
 *
 * @param ctx - Query context
 * @param args - Find arguments
 * @param options - Find options
 * @returns SQL statement
 */
export function buildFind(
  ctx: QueryScope,
  args: FindArgs,
  options: FindOptions = {}
): Sql {
  const { adapter, rootAlias } = ctx;
  const tableName = getTableName(ctx.model);
  const pagination = buildFindPagination(ctx, args, options.limit, rootAlias);

  // Build SELECT columns using buildSelectWithAliases to get:
  // - columns SQL
  // - column aliases (for distinct)
  // - lateral joins (for databases supporting LATERAL)
  const selectResult = buildSelectWithAliases(
    ctx,
    args.select,
    args.include,
    rootAlias
  );
  const columns = options.additionalColumns?.length
    ? sql.join([selectResult.sql, ...options.additionalColumns], ", ")
    : selectResult.sql;
  const columnAliases = selectResult.aliases;
  const lateralJoins = selectResult.lateralJoins;

  // Build FROM
  const from = adapter.identifiers.table(tableName, rootAlias);

  // Build WHERE with cursor conditions
  let where = buildWhere(ctx, args.where, rootAlias);

  if (options.predicate) {
    where = where
      ? adapter.operators.and(where, options.predicate)
      : options.predicate;
  }

  if (pagination.cursorCondition) {
    where = where
      ? adapter.operators.and(where, pagination.cursorCondition)
      : pagination.cursorCondition;
  }

  // Build ORDER BY
  const orderByParts = pagination.normalizedOrder
    ? {
        orderBy: buildNormalizedOrderBy(ctx, pagination.normalizedOrder),
        joins: [],
      }
    : buildOrderByParts(ctx, pagination.orderBy, rootAlias);

  // Build LIMIT
  const limit =
    options.limit !== undefined
      ? adapter.literals.value(Math.abs(options.limit))
      : undefined;

  // Build OFFSET (skip)
  const offset =
    args.skip !== undefined ? adapter.literals.value(args.skip) : undefined;

  // Handle DISTINCT
  const distinct = args.distinct
    ? buildDistinctColumns(ctx, args.distinct, rootAlias)
    : undefined;

  // Assemble query parts
  const parts: QueryParts = {
    columns,
    from,
  };

  const joins = [...lateralJoins, ...orderByParts.joins];
  if (joins.length > 0) {
    parts.joins = joins;
  }

  if (distinct && columnAliases) {
    parts.distinct = distinct;
    parts.distinctColumnAliases = columnAliases;
  } else if (distinct) {
    parts.distinct = distinct;
  }
  if (where) parts.where = where;
  if (orderByParts.orderBy) parts.orderBy = orderByParts.orderBy;
  if (limit) parts.limit = limit;
  if (offset) parts.offset = offset;
  if (args.forUpdate) parts.forUpdate = true;

  return assembleAdapterSelect(adapter, parts);
}
