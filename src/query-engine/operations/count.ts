/**
 * Count Operation
 *
 * Builds SQL for count queries.
 * Returns the number of records matching the criteria.
 */

import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import { type Sql, sql } from "@sql";
import { getColumnName } from "../context";
import type { QueryScope } from "../types";
import { buildAggregateInputWindow } from "./aggregate-input";

interface CountArgs {
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown> | Record<string, unknown>[];
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
export function buildCount(ctx: QueryScope, args: CountArgs): Sql {
  const { adapter } = ctx;
  const input = buildAggregateInputWindow(
    ctx,
    args,
    getCountFieldNames(args.select)
  );

  // Assemble query parts
  const parts: Parameters<typeof adapter.assemble.select>[0] = {
    columns: buildCountColumns(ctx, args.select, input.alias),
    from: input.from,
  };

  return adapter.assemble.select(parts);
}

function getCountFieldNames(select?: Record<string, boolean>): string[] {
  if (!select) {
    return [];
  }

  return Object.entries(select)
    .filter(([field, include]) => field !== "_all" && include)
    .map(([field]) => field);
}

/**
 * Build count columns based on select input
 */
function buildCountColumns(
  ctx: QueryScope,
  select: Record<string, boolean> | undefined,
  alias: string
): Sql {
  const { adapter } = ctx;

  if (!select) {
    return adapter.identifiers.aliased(
      adapter.aggregates.count(),
      COUNT_RESULT_KEY
    );
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
    const column = adapter.identifiers.column(alias, columnName);
    const countExpr = adapter.aggregates.count(column);
    counts.push(adapter.identifiers.aliased(countExpr, field));
  }

  if (counts.length === 0) {
    return adapter.identifiers.aliased(
      adapter.aggregates.count(),
      COUNT_RESULT_KEY
    );
  }

  return sql.join(counts, ", ");
}
