/**
 * Find Common
 *
 * Shared logic for findFirst/findMany operations.
 * Handles cursor-based pagination and distinct.
 */

import { type Sql, sql } from "@sql";
import { buildOrderByParts } from "../builders/orderby-builder";
import { buildSelectWithAliases } from "../builders/select-builder";
import { buildWhere } from "../builders/where-builder";
import { getColumnName, getScalarFieldNames, getTableName } from "../context";
import { type QueryContext, QueryEngineError } from "../types";
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

/**
 * Options for buildFind
 */
export interface FindOptions {
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
  ctx: QueryContext,
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
  const columns = selectResult.sql;
  const columnAliases = selectResult.aliases;
  const lateralJoins = selectResult.lateralJoins;

  // Build FROM
  const from = adapter.identifiers.table(tableName, rootAlias);

  // Build WHERE with cursor conditions
  let where = buildWhere(ctx, args.where, rootAlias);

  if (pagination.cursorCondition) {
    where = where
      ? adapter.operators.and(where, pagination.cursorCondition)
      : pagination.cursorCondition;
  }

  // Build ORDER BY
  const orderByParts = buildOrderByParts(ctx, pagination.orderBy, rootAlias);

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
    ? buildDistinct(ctx, args.distinct, rootAlias)
    : undefined;

  // Assemble query parts
  const parts: Parameters<typeof adapter.assemble.select>[0] = {
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

  return adapter.assemble.select(parts);
}

/**
 * Build DISTINCT clause for find operations.
 *
 * PostgreSQL: DISTINCT ON (field1, field2, ...)
 * MySQL/SQLite: Simulated via ROW_NUMBER() in the adapter
 *
 * @param ctx - Query context
 * @param distinct - Array of field names for distinct
 * @param alias - Table alias
 * @returns SQL for DISTINCT clause
 */
function buildDistinct(
  ctx: QueryContext,
  distinct: string[],
  alias: string
): Sql | undefined {
  if (distinct.length === 0) return undefined;

  const { adapter } = ctx;

  // Validate distinct fields exist
  const scalarFields = getScalarFieldNames(ctx.model);
  for (const field of distinct) {
    if (!scalarFields.includes(field)) {
      throw new QueryEngineError(
        `Distinct field '${field}' not found on model '${ctx.model["~"].state.name}'`
      );
    }
  }

  // Build column list for distinct (resolve field names to column names)
  // The adapter will handle database-specific implementation
  const columns = distinct.map((field) => {
    const columnName = getColumnName(ctx.model, field);
    return adapter.identifiers.column(alias, columnName);
  });

  return sql.join(columns, ", ");
}
