/**
 * Aggregate input window
 *
 * Builds the rowset that count/aggregate consume when pagination is present.
 */

import { type Sql, sql } from "@sql";
import { buildOrderByParts } from "../builders/orderby-builder";
import { buildWhere } from "../builders/where-builder";
import { getColumnName, getTableName } from "../context";
import type { QueryScope } from "../types";
import { buildNormalizedOrderBy } from "./cursor-order";
import { buildFindPagination } from "./find-pagination";

export interface AggregateInputArgs {
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown> | Record<string, unknown>[];
  cursor?: Record<string, unknown>;
  skip?: number;
  take?: number;
}

export interface AggregateInputWindow {
  from: Sql;
  alias: string;
}

export function buildAggregateInputWindow(
  ctx: QueryScope,
  args: AggregateInputArgs,
  fieldNames: Iterable<string>
): AggregateInputWindow {
  const { adapter, rootAlias } = ctx;
  const inputAlias = "aggregate_input";
  const tableName = getTableName(ctx.model);
  const pagination = buildFindPagination(ctx, args, args.take, rootAlias);

  let where = buildWhere(ctx, args.where, rootAlias);
  if (pagination.cursorCondition) {
    where = where
      ? adapter.operators.and(where, pagination.cursorCondition)
      : pagination.cursorCondition;
  }

  const orderByParts = pagination.normalizedOrder
    ? {
        orderBy: buildNormalizedOrderBy(ctx, pagination.normalizedOrder),
        joins: [],
      }
    : buildOrderByParts(ctx, pagination.orderBy, rootAlias);
  const innerParts: Parameters<typeof adapter.assemble.select>[0] = {
    columns: buildInputColumns(ctx, fieldNames, rootAlias),
    from: adapter.identifiers.table(tableName, rootAlias),
  };

  if (orderByParts.joins.length > 0) {
    innerParts.joins = orderByParts.joins;
  }
  if (where) innerParts.where = where;
  if (orderByParts.orderBy) innerParts.orderBy = orderByParts.orderBy;
  if (args.take !== undefined) {
    innerParts.limit = adapter.literals.value(Math.abs(args.take));
  }
  if (args.skip !== undefined) {
    innerParts.offset = adapter.literals.value(args.skip);
  }

  return {
    from: adapter.subqueries.correlate(
      adapter.assemble.select(innerParts),
      inputAlias
    ),
    alias: inputAlias,
  };
}

function buildInputColumns(
  ctx: QueryScope,
  fieldNames: Iterable<string>,
  alias: string
): Sql {
  const { adapter } = ctx;
  const columns: Sql[] = [];

  for (const fieldName of new Set(fieldNames)) {
    const columnName = getColumnName(ctx.model, fieldName);
    columns.push(
      adapter.identifiers.aliased(
        adapter.identifiers.column(alias, columnName),
        columnName
      )
    );
  }

  if (columns.length === 0) {
    return adapter.identifiers.aliased(adapter.raw("1"), "_row");
  }

  return sql.join(columns, ", ");
}
