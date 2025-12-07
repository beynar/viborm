/**
 * Update Operation
 *
 * Builds SQL for update mutations.
 * Returns the updated record.
 */

import { sql, Sql } from "@sql";
import type { QueryContext } from "../types";
import { getTableName } from "../context";
import { buildSet } from "../builders/set-builder";
import { buildWhereUnique, buildWhere } from "../builders/where-builder";
import { buildSelect } from "../builders/select-builder";

interface UpdateArgs {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
}

interface UpdateManyArgs {
  where?: Record<string, unknown>;
  data: Record<string, unknown>;
}

/**
 * Build SQL for update operation (single record by unique key)
 *
 * @param ctx - Query context
 * @param args - Update arguments
 * @returns SQL statement (UPDATE with optional RETURNING)
 */
export function buildUpdate(ctx: QueryContext, args: UpdateArgs): Sql {
  const { adapter, rootAlias } = ctx;
  const tableName = getTableName(ctx.model);

  // Build SET clause
  const setSql = buildSet(ctx, args.data);

  // Build WHERE from unique input
  const whereSql = buildWhereUnique(ctx, args.where, rootAlias);

  // Build UPDATE
  const table = adapter.identifiers.escape(tableName);
  const updateSql = adapter.mutations.update(table, setSql, whereSql);

  // Build RETURNING clause if supported
  const returningCols = buildSelect(ctx, args.select, args.include, rootAlias);
  const returningSql = adapter.mutations.returning(returningCols);

  // Combine UPDATE with RETURNING
  if (returningSql.strings.join("").trim() === "") {
    // No RETURNING support (MySQL)
    return updateSql;
  }

  return sql`${updateSql} ${returningSql}`;
}

/**
 * Build SQL for updateMany operation
 *
 * @param ctx - Query context
 * @param args - UpdateMany arguments
 * @returns SQL statement
 */
export function buildUpdateMany(ctx: QueryContext, args: UpdateManyArgs): Sql {
  const { adapter, rootAlias } = ctx;
  const tableName = getTableName(ctx.model);

  // Build SET clause
  const setSql = buildSet(ctx, args.data);

  // Build WHERE (optional for updateMany)
  const whereSql = buildWhere(ctx, args.where, rootAlias);

  // Build UPDATE
  const table = adapter.identifiers.escape(tableName);
  return adapter.mutations.update(table, setSql, whereSql);
}

