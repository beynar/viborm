/**
 * Count Operation
 *
 * Builds SQL for count queries.
 * Returns the number of records matching the criteria.
 */

import { type Sql, sql } from "@sql";
import { buildWhere } from "../builders/where-builder";
import { getColumnName, getTableName } from "../context";
import type { QueryContext } from "../types";

interface CountArgs {
  where?: Record<string, unknown>;
  select?: Record<string, boolean>;
  cursor?: Record<string, unknown>;
  take?: number;
  skip?: number;
}

/**
 * Build SQL for count operation
 *
 * @param ctx - Query context
 * @param args - Count arguments
 * @returns SQL statement
 */
export function buildCount(ctx: QueryContext, args: CountArgs): Sql {
  const { adapter, rootAlias } = ctx;
  const tableName = getTableName(ctx.model);

  // Build count columns
  const columns = buildCountColumns(ctx, args.select);

  // Build FROM
  const from = adapter.identifiers.table(tableName, rootAlias);

  // Build WHERE
  const where = buildWhere(ctx, args.where, rootAlias);

  // Build LIMIT (take)
  const limit =
    args.take !== undefined ? adapter.literals.value(args.take) : undefined;

  // Build OFFSET (skip)
  const offset =
    args.skip !== undefined ? adapter.literals.value(args.skip) : undefined;

  // Assemble query parts
  const parts: Parameters<typeof adapter.assemble.select>[0] = {
    columns,
    from,
  };
  if (where) parts.where = where;
  if (limit) parts.limit = limit;
  if (offset) parts.offset = offset;

  return adapter.assemble.select(parts);
}

/**
 * Build count columns based on select input
 */
function buildCountColumns(
  ctx: QueryContext,
  select?: Record<string, boolean>
): Sql {
  const { adapter } = ctx;

  if (!select) {
    // Simple count all - adapter.result.parseResult normalizes database-specific column names
    return adapter.aggregates.count();
  }

  // Build count for specific fields
  const counts: Sql[] = [];

  if (select._all) {
    counts.push(
      adapter.identifiers.aliased(adapter.aggregates.count(), "_all")
    );
  }

  for (const [field, include] of Object.entries(select)) {
    if (field === "_all" || !include) continue;

    // Resolve field name to actual column name (handles .map() overrides)
    const columnName = getColumnName(ctx.model, field);
    const column = adapter.identifiers.column(ctx.rootAlias, columnName);
    const countExpr = adapter.aggregates.count(column);
    counts.push(adapter.identifiers.aliased(countExpr, field));
  }

  if (counts.length === 0) {
    return adapter.aggregates.count();
  }

  return sql.join(counts, ", ");
}
