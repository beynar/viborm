/**
 * Aggregate Operation
 *
 * Builds SQL for aggregate queries.
 * Supports _count, _avg, _sum, _min, _max aggregations.
 */

import { type Sql, sql } from "@sql";
import {
  buildAggregateColumn,
  buildCountAggregate,
} from "../builders/aggregate-utils";
import { buildWhere } from "../builders/where-builder";
import { getTableName } from "../context";
import { QueryEngineError, type QueryContext } from "../types";

/**
 * Aggregate arguments
 */
export interface AggregateArgs {
  where?: Record<string, unknown>;
  cursor?: Record<string, unknown>;
  take?: number;
  skip?: number;
  orderBy?: Record<string, unknown> | Record<string, unknown>[];
  _count?: true | Record<string, boolean>;
  _avg?: Record<string, boolean>;
  _sum?: Record<string, boolean>;
  _min?: Record<string, boolean>;
  _max?: Record<string, boolean>;
}

/**
 * Build SQL for aggregate operation
 *
 * @param ctx - Query context
 * @param args - Aggregate arguments
 * @returns SQL statement
 */
export function buildAggregate(ctx: QueryContext, args: AggregateArgs): Sql {
  const { adapter, rootAlias } = ctx;
  const tableName = getTableName(ctx.model);

  // Build aggregate columns
  const columns = buildAggregateColumns(ctx, args, rootAlias);

  if (columns.length === 0) {
    throw new QueryEngineError(
      "Aggregate operation requires at least one aggregate field (_count, _avg, _sum, _min, _max)"
    );
  }

  // Build FROM
  const from = adapter.identifiers.table(tableName, rootAlias);

  // Build WHERE
  const where = buildWhere(ctx, args.where, rootAlias);

  // Build LIMIT/OFFSET (for cursor-based pagination)
  const limit =
    args.take !== undefined ? adapter.literals.value(args.take) : undefined;
  const offset =
    args.skip !== undefined ? adapter.literals.value(args.skip) : undefined;

  // Assemble query
  const parts: Parameters<typeof adapter.assemble.select>[0] = {
    columns: sql.join(columns, ", "),
    from,
  };

  if (where) parts.where = where;
  if (limit) parts.limit = limit;
  if (offset) parts.offset = offset;

  return adapter.assemble.select(parts);
}

/**
 * Build aggregate columns from args using shared helpers
 */
function buildAggregateColumns(
  ctx: QueryContext,
  args: AggregateArgs,
  alias: string
): Sql[] {
  const columns: Sql[] = [];

  // Build _count aggregates
  if (args._count) {
    const countCol = buildCountAggregate(ctx, args._count, alias);
    if (countCol) columns.push(countCol);
  }

  // Build _avg aggregates
  if (args._avg) {
    const avgCol = buildAggregateColumn(ctx, args._avg, alias, "avg");
    if (avgCol) columns.push(avgCol);
  }

  // Build _sum aggregates
  if (args._sum) {
    const sumCol = buildAggregateColumn(ctx, args._sum, alias, "sum");
    if (sumCol) columns.push(sumCol);
  }

  // Build _min aggregates
  if (args._min) {
    const minCol = buildAggregateColumn(ctx, args._min, alias, "min");
    if (minCol) columns.push(minCol);
  }

  // Build _max aggregates
  if (args._max) {
    const maxCol = buildAggregateColumn(ctx, args._max, alias, "max");
    if (maxCol) columns.push(maxCol);
  }

  return columns;
}
