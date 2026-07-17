/**
 * Delete Operation
 *
 * Builds SQL for delete mutations.
 */

import { type Sql, sql } from "@sql";
import { buildSelect } from "../builders/select-builder";
import { buildWhere } from "../builders/where-builder";
import { buildWhereUnique } from "../builders/where-unique-builder";
import { getTableName } from "../context";
import type { QueryScope } from "../types";

interface DeleteArgs {
  where: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
}

interface DeleteManyArgs {
  where?: Record<string, unknown>;
}

/**
 * Build SQL for delete operation (single record by unique key)
 *
 * @param ctx - Query context
 * @param args - Delete arguments
 * @returns SQL statement (DELETE with optional RETURNING)
 */
export function buildDelete(ctx: QueryScope, args: DeleteArgs): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Build WHERE from unique input (no alias for DELETE statements)
  const whereSql = buildWhereUnique(ctx, args.where, "");

  // Build DELETE
  const table = adapter.identifiers.escape(tableName);
  const deleteSql = adapter.mutations.delete(table, whereSql);

  // Build RETURNING clause if supported (no alias for DELETE RETURNING)
  const returningCols = buildSelect(ctx, args.select, args.include, "");
  const returningSql = adapter.mutations.returning(returningCols);

  // Combine DELETE with RETURNING
  if (returningSql.strings.join("").trim() === "") {
    // No RETURNING support (MySQL)
    return deleteSql;
  }

  return sql`${deleteSql} ${returningSql}`;
}

/**
 * Build SQL for deleteMany operation
 *
 * @param ctx - Query context
 * @param args - DeleteMany arguments
 * @returns SQL statement
 */
export function buildDeleteMany(ctx: QueryScope, args: DeleteManyArgs): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Build WHERE qualified by table name so relation-filter EXISTS subqueries
  // stay correlated (the unaliased DELETE target is addressable by its name).
  // mutationTable lets relation filters wrap subqueries that select from the
  // mutated table on dialects that reject that (MySQL error 1093).
  const whereSql = buildWhere(
    { ...ctx, mutationTable: tableName },
    args.where,
    tableName
  );

  // Build DELETE
  const table = adapter.identifiers.escape(tableName);
  return adapter.mutations.delete(table, whereSql);
}
