/**
 * Sort Order Builder
 *
 * Builds a single ASC/DESC expression, including optional NULLS ordering.
 */

import type { Sql } from "@sql";
import { type QueryContext, QueryEngineError } from "../types";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export function buildSingleOrder(
  ctx: QueryContext,
  column: Sql,
  value: unknown
): Sql {
  const { adapter } = ctx;

  if (typeof value === "string") {
    if (value === "asc") return adapter.orderBy.asc(column);
    if (value === "desc") return adapter.orderBy.desc(column);
    throw new QueryEngineError(`Unsupported sort direction '${value}'.`);
  }

  if (isRecord(value)) {
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
