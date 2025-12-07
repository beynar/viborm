/**
 * Find Unique Operation
 *
 * Builds SQL for findUnique queries.
 * Returns a single record by unique identifier or null.
 */

import { sql, Sql } from "@sql";
import type { QueryContext } from "../types";
import { getTableName } from "../context";
import { buildSelect } from "../builders/select-builder";
import { buildWhereUnique } from "../builders/where-builder";

interface FindUniqueArgs {
  where: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
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
  const columns = buildSelect(ctx, args.select, args.include, rootAlias);

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
  if (where) parts.where = where;
  parts.limit = limit;

  return adapter.assemble.select(parts);
}
