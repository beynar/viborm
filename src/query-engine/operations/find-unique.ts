/**
 * Find Unique Operation
 *
 * Builds SQL for findUnique queries.
 * Returns a single record by unique identifier or null.
 */

import { type Sql, sql } from "@sql";
import { buildSelectWithAliases } from "../builders/select-builder";
import { buildWhereUnique } from "../builders/where-builder";
import { getTableName } from "../context";
import type { QueryContext } from "../types";

interface FindUniqueArgs {
  where: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  /**
   * Add FOR UPDATE clause for row locking in transactions.
   * Used internally for transaction-based upserts to prevent race conditions.
   */
  forUpdate?: boolean;
}

/**
 * Build SQL for findUnique operation
 *
 * @param ctx - Query context
 * @param args - FindUnique arguments
 * @returns SQL statement
 */
export function buildFindUnique(ctx: QueryContext, args: FindUniqueArgs): Sql {
  const { adapter, rootAlias } = ctx;
  const tableName = getTableName(ctx.model);

  // Build SELECT columns
  const selectResult = buildSelectWithAliases(
    ctx,
    args.select,
    args.include,
    rootAlias
  );
  const columns = selectResult.sql;
  const lateralJoins = selectResult.lateralJoins;

  // Build FROM
  const from = adapter.identifiers.table(tableName, rootAlias);

  // Build WHERE from unique input
  const where = buildWhereUnique(ctx, args.where, rootAlias);

  // Build LIMIT (always 1 for findUnique)
  const limit = sql`1`;

  // Assemble query parts
  const parts: Parameters<typeof adapter.assemble.select>[0] = {
    columns,
    from,
  };
  if (lateralJoins.length > 0) {
    parts.joins = lateralJoins;
  }
  if (where) parts.where = where;
  parts.limit = limit;

  // Add FOR UPDATE for row locking in transactions
  if (args.forUpdate) {
    parts.forUpdate = true;
  }

  return adapter.assemble.select(parts);
}
