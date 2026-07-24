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
import { QueryEngineError, type QueryScope } from "../types";
import { buildAggregateInputWindow } from "./aggregate-input";

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
export function buildAggregate(ctx: QueryScope, args: AggregateArgs): Sql {
  const { adapter } = ctx;

  // Build aggregate columns
  const input = buildAggregateInputWindow(
    ctx,
    args,
    getAggregateFieldNames(args)
  );
  const columns = buildAggregateColumns(ctx, args, input.alias);

  if (columns.length === 0) {
    throw new QueryEngineError(
      "Aggregate operation requires at least one aggregate field (_count, _avg, _sum, _min, _max)"
    );
  }

  // Assemble query
  const parts: Parameters<typeof adapter.assemble.select>[0] = {
    columns: sql.join(columns, ", "),
    from: input.from,
  };

  return adapter.assemble.select(parts);
}

function getAggregateFieldNames(args: AggregateArgs): string[] {
  const fields = new Set<string>();

  addCountFields(fields, args._count);
  addSelectedFields(fields, args._avg);
  addSelectedFields(fields, args._sum);
  addSelectedFields(fields, args._min);
  addSelectedFields(fields, args._max);

  return [...fields];
}

function addCountFields(
  fields: Set<string>,
  spec: true | Record<string, boolean> | undefined
): void {
  if (!spec || spec === true) {
    return;
  }

  for (const [field, include] of Object.entries(spec)) {
    if (field !== "_all" && include) {
      fields.add(field);
    }
  }
}

function addSelectedFields(
  fields: Set<string>,
  spec: Record<string, boolean> | undefined
): void {
  if (!spec) {
    return;
  }

  for (const [field, include] of Object.entries(spec)) {
    if (include) {
      fields.add(field);
    }
  }
}

/**
 * Build aggregate columns from args using shared helpers
 */
function buildAggregateColumns(
  ctx: QueryScope,
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
