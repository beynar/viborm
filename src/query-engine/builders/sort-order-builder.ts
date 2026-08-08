/**
 * Sort Order Builder
 *
 * Builds a single ASC/DESC expression, including optional NULLS ordering.
 */

import type { Sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import { QueryEngineError, type QueryScope } from "../types";
import { buildVectorDistanceExpression } from "./vector-distance-builder";

type SortableScalarState = {
  type: string;
  dimension?: number | undefined;
};

type SortOrderField = {
  name: string;
  scalarState: SortableScalarState | undefined;
};

function buildVectorDistanceOrder(
  ctx: QueryScope,
  column: Sql,
  value: unknown,
  field: SortOrderField | undefined
): Sql {
  const distance = buildVectorDistanceExpression(
    ctx,
    column,
    value,
    field,
    "orderBy"
  );

  const sort = isRecord(value) ? value.sort : undefined;
  if (sort === undefined || sort === "asc") {
    return ctx.adapter.orderBy.asc(distance);
  }
  if (sort === "desc") {
    return ctx.adapter.orderBy.desc(distance);
  }

  throw new QueryEngineError(
    "Vector distance orderBy sort must be 'asc' or 'desc'."
  );
}

export function buildSingleOrder(
  ctx: QueryScope,
  column: Sql,
  value: unknown,
  field?: SortOrderField
): Sql {
  const { adapter } = ctx;

  if (typeof value === "string") {
    if (value === "asc") return adapter.orderBy.asc(column);
    if (value === "desc") return adapter.orderBy.desc(column);
    throw new QueryEngineError(`Unsupported sort direction '${value}'.`);
  }

  if (isRecord(value)) {
    if (value._distance !== undefined) {
      return buildVectorDistanceOrder(ctx, column, value._distance, field);
    }

    const sort = value.sort;
    const nulls = value.nulls;

    if (sort !== "asc" && sort !== "desc") {
      throw new QueryEngineError(
        "OrderBy object requires sort: 'asc' or 'desc'."
      );
    }

    if (nulls === "first") {
      return adapter.orderBy.nullsFirst(column, sort);
    }
    if (nulls === "last") {
      return adapter.orderBy.nullsLast(column, sort);
    }
    if (nulls !== undefined) {
      throw new QueryEngineError(
        "OrderBy object nulls must be 'first' or 'last'."
      );
    }

    return sort === "desc"
      ? adapter.orderBy.desc(column)
      : adapter.orderBy.asc(column);
  }

  throw new QueryEngineError("OrderBy value must be a sort direction object.");
}
