/**
 * Find pagination
 *
 * Validates pagination values, chooses the total scalar order used by cursor
 * traversal, and preserves relation-order fallback for non-cursor windows.
 */

import type { Sql } from "@sql";
import {
  getWhereUniqueEntries,
  type WhereUniqueEntry,
} from "../builders/where-unique-builder";
import { QueryEngineError, type QueryScope } from "../types";
import { buildCursorCondition } from "./cursor-condition";
import {
  type NormalizedCursorOrder,
  normalizeCursorOrder,
  type OrderByInput,
  reverseCursorOrder,
} from "./cursor-order";

export interface FindPaginationArgs {
  orderBy?: Record<string, unknown> | Record<string, unknown>[];
  cursor?: Record<string, unknown>;
  skip?: number;
}

export interface FindPaginationPlan {
  orderBy: OrderByInput;
  normalizedOrder: NormalizedCursorOrder[] | undefined;
  cursorCondition: Sql | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export function buildFindPagination(
  ctx: QueryScope,
  args: FindPaginationArgs,
  take: number | undefined,
  alias: string
): FindPaginationPlan {
  validatePaginationValues(take, args.skip);

  const cursorEntries = args.cursor
    ? getWhereUniqueEntries(ctx, args.cursor)
    : undefined;
  const isBackward = take !== undefined && take < 0;
  const logicalOrder = normalizeCursorOrder(
    ctx,
    args.orderBy,
    cursorEntries,
    take,
    alias
  );
  const normalizedOrder =
    logicalOrder && isBackward
      ? reverseCursorOrder(logicalOrder)
      : logicalOrder;
  const fallbackOrder = normalizedOrder
    ? undefined
    : reverseFallbackOrder(args.orderBy, isBackward);

  return {
    orderBy: fallbackOrder,
    normalizedOrder,
    cursorCondition: cursorEntries
      ? buildRequiredCursorCondition(ctx, cursorEntries, normalizedOrder)
      : undefined,
  };
}

function validatePaginationValues(
  take: number | undefined,
  skip: number | undefined
): void {
  if (take !== undefined && !Number.isInteger(take)) {
    throw new QueryEngineError("Pagination take must be an integer.");
  }

  if (skip !== undefined && !Number.isInteger(skip)) {
    throw new QueryEngineError("Pagination skip must be an integer.");
  }

  if (skip !== undefined && skip < 0) {
    throw new QueryEngineError(
      "Pagination skip must be greater than or equal to 0."
    );
  }
}

function buildRequiredCursorCondition(
  ctx: QueryScope,
  cursorEntries: WhereUniqueEntry[],
  normalizedOrder: NormalizedCursorOrder[] | undefined
): Sql {
  if (!normalizedOrder) {
    throw new QueryEngineError(
      "Cursor pagination requires a scalar total order."
    );
  }

  return buildCursorCondition(ctx, cursorEntries, normalizedOrder);
}

function reverseFallbackOrder(
  orderBy: OrderByInput,
  isBackward: boolean
): OrderByInput {
  if (!(isBackward && orderBy)) {
    return orderBy;
  }

  if (Array.isArray(orderBy)) {
    return orderBy.map(reverseFallbackOrderItem);
  }

  return reverseFallbackOrderItem(orderBy);
}

function reverseFallbackOrderItem(
  orderBy: Record<string, unknown>
): Record<string, unknown> {
  const reversed: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(orderBy)) {
    reversed[field] = reverseFallbackSortValue(value);
  }

  return reversed;
}

function reverseFallbackSortValue(value: unknown): unknown {
  if (value === "asc") {
    return "desc";
  }
  if (value === "desc") {
    return "asc";
  }
  if (!isRecord(value)) {
    return value;
  }

  const reversedNulls = reverseNullPlacement(value.nulls);
  if (value.sort === "asc" || value.sort === "desc") {
    return {
      ...value,
      sort: value.sort === "asc" ? "desc" : "asc",
      ...(reversedNulls ? { nulls: reversedNulls } : {}),
    };
  }

  return reverseFallbackOrderItem(value);
}

function reverseNullPlacement(value: unknown): "first" | "last" | undefined {
  if (value === "first") {
    return "last";
  }
  if (value === "last") {
    return "first";
  }
  return undefined;
}
