/**
 * Sort Order Builder
 *
 * Builds a single ASC/DESC expression, including optional NULLS ordering.
 */

import type { Sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import { QueryEngineError, type QueryScope } from "../types";
import { buildDistanceExpression } from "./distance-builder";

type SortableScalarState = {
  type: string;
  dimension?: number | undefined;
};

type SortOrderField = {
  name: string;
  scalarState: SortableScalarState | undefined;
};

function buildDistanceOrder(
  ctx: QueryScope,
  column: Sql,
  value: unknown,
  field: SortOrderField | undefined
): Sql {
  const distance = buildDistanceExpression(
    ctx,
    column,
    value,
    field,
    "orderBy"
  );

  const sort = isRecord(value) ? value.sort : undefined;
  if (field?.scalarState?.type === "point") {
    if (sort === undefined || sort === "asc") {
      return ctx.adapter.orderBy.nullsLast(distance, "asc");
    }
    if (sort === "desc") {
      return ctx.adapter.orderBy.nullsLast(distance, "desc");
    }
    throw new QueryEngineError(
      "GeoPoint distance orderBy sort must be 'asc' or 'desc'."
    );
  }
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
      return buildDistanceOrder(ctx, column, value._distance, field);
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
