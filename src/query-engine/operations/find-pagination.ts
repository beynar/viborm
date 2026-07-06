/**
 * Find pagination
 *
 * Cursor conditions, default cursor ordering, and negative take query planning.
 */

import { type Sql, sql } from "@sql";
import { scalarValueLiteral } from "../builders/values-builder";
import {
  getWhereUniqueEntries,
  type WhereUniqueEntry,
} from "../builders/where-unique-builder";
import { getColumnName } from "../context";
import { type QueryContext, QueryEngineError } from "../types";

type OrderByInput =
  | Record<string, unknown>
  | Record<string, unknown>[]
  | undefined;

export interface FindPaginationArgs {
  orderBy?: Record<string, unknown> | Record<string, unknown>[];
  cursor?: Record<string, unknown>;
  skip?: number;
}

export interface FindPaginationPlan {
  orderBy: OrderByInput;
  cursorCondition: Sql | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export function buildFindPagination(
  ctx: QueryContext,
  args: FindPaginationArgs,
  take: number | undefined,
  alias: string
): FindPaginationPlan {
  validatePaginationValues(take, args.skip);

  const cursorEntries = args.cursor
    ? getWhereUniqueEntries(ctx, args.cursor)
    : undefined;
  const isBackwardPagination = take !== undefined && take < 0;
  const logicalOrderBy = getLogicalOrderBy(
    ctx,
    cursorEntries,
    args.orderBy,
    isBackwardPagination
  );
  const orderBy = isBackwardPagination
    ? reverseOrderBy(logicalOrderBy)
    : logicalOrderBy;

  return {
    orderBy,
    cursorCondition: cursorEntries
      ? buildCursorCondition(ctx, cursorEntries, orderBy, alias)
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

function getLogicalOrderBy(
  ctx: QueryContext,
  cursorEntries: WhereUniqueEntry[] | undefined,
  orderBy: OrderByInput,
  isBackwardPagination: boolean
): OrderByInput {
  if (cursorEntries && orderBy) {
    assertCursorOrderByMatches(cursorEntries, orderBy);
    return orderBy;
  }

  if (cursorEntries) {
    return orderByFromFields(cursorEntries.map(({ fieldName }) => fieldName));
  }

  if (orderBy) {
    return orderBy;
  }

  if (isBackwardPagination) {
    return getDefaultUniqueOrderBy(ctx);
  }

  return orderBy;
}

function assertCursorOrderByMatches(
  cursorEntries: WhereUniqueEntry[],
  orderBy: Record<string, unknown> | Record<string, unknown>[]
): void {
  const cursorFields = cursorEntries.map(({ fieldName }) => fieldName);
  const orderFields = getOrderByFields(orderBy);

  if (orderFields.length !== cursorFields.length) {
    throw new QueryEngineError(
      "Cursor pagination orderBy must use exactly the cursor field(s)."
    );
  }

  for (let i = 0; i < cursorFields.length; i++) {
    if (orderFields[i] !== cursorFields[i]) {
      throw new QueryEngineError(
        "Cursor pagination orderBy must use cursor field(s) in cursor order."
      );
    }
  }
}

function getOrderByFields(
  orderBy: Record<string, unknown> | Record<string, unknown>[]
): string[] {
  const fields: string[] = [];
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];

  for (const item of items) {
    for (const [field, value] of Object.entries(item)) {
      if (value !== undefined) {
        fields.push(field);
      }
    }
  }

  return fields;
}

function orderByFromFields(fields: string[]): Record<string, "asc">[] {
  return fields.map((field) => ({ [field]: "asc" }));
}

function getDefaultUniqueOrderBy(ctx: QueryContext): Record<string, "asc">[] {
  const uniqueFields = Object.keys(ctx.model["~"].state.uniques);
  if (uniqueFields.length > 0) {
    return orderByFromFields([uniqueFields[0]!]);
  }

  const compoundFields = getFirstCompoundUniqueScalarMap(ctx);
  if (compoundFields.length > 0) {
    return orderByFromFields(compoundFields);
  }

  throw new QueryEngineError(
    "Negative take requires orderBy or a unique model identifier."
  );
}

function getFirstCompoundUniqueScalarMap(ctx: QueryContext): string[] {
  const state = ctx.model["~"].state;
  const compoundConstraint =
    getFirstCompoundConstraint(state.compoundId) ??
    getFirstCompoundConstraint(state.compoundUniques);

  if (!compoundConstraint) {
    return [];
  }

  return Object.keys(compoundConstraint.entries);
}

function getFirstCompoundConstraint(
  constraints: Record<string, { entries: Record<string, unknown> }> | undefined
): { entries: Record<string, unknown> } | undefined {
  if (!constraints) {
    return undefined;
  }

  const firstKey = Object.keys(constraints)[0];
  return firstKey ? constraints[firstKey] : undefined;
}

function reverseOrderBy(orderBy: OrderByInput): OrderByInput {
  if (!orderBy) {
    return undefined;
  }

  if (Array.isArray(orderBy)) {
    return orderBy.map(reverseOrderByItem);
  }

  return reverseOrderByItem(orderBy);
}

function reverseOrderByItem(
  orderBy: Record<string, unknown>
): Record<string, unknown> {
  const reversed: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(orderBy)) {
    reversed[field] = reverseSortValue(value);
  }

  return reversed;
}

function reverseSortValue(value: unknown): unknown {
  if (value === "asc") {
    return "desc";
  }

  if (value === "desc") {
    return "asc";
  }

  if (isRecord(value)) {
    if (value.sort === "asc") {
      return { ...value, sort: "desc" };
    }
    if (value.sort === "desc") {
      return { ...value, sort: "asc" };
    }
    return reverseOrderByItem(value);
  }

  return value;
}

function buildCursorCondition(
  ctx: QueryContext,
  cursorEntries: WhereUniqueEntry[],
  orderBy: OrderByInput,
  alias: string
): Sql {
  for (const { fieldName, value } of cursorEntries) {
    if (value === null) {
      throw new QueryEngineError(
        `Cursor field '${fieldName}' cannot be null. ` +
          "Cursor must point to a specific record."
      );
    }
  }

  if (cursorEntries.length === 1) {
    const { fieldName, value } = cursorEntries[0]!;
    return buildSingleFieldCursor(ctx, fieldName, value, orderBy, alias);
  }

  return buildCompoundCursor(ctx, cursorEntries, orderBy, alias);
}

function buildSingleFieldCursor(
  ctx: QueryContext,
  cursorField: string,
  cursorValue: unknown,
  orderBy: OrderByInput,
  alias: string
): Sql {
  const { adapter } = ctx;
  const columnName = getColumnName(ctx.model, cursorField);
  const column = adapter.identifiers.column(alias, columnName);
  const value = scalarValueLiteral(ctx, cursorField, cursorValue);
  const direction = getFieldDirection(cursorField, orderBy);

  if (direction === "desc") {
    return adapter.operators.lte(column, value);
  }
  return adapter.operators.gte(column, value);
}

function buildCompoundCursor(
  ctx: QueryContext,
  cursorEntries: WhereUniqueEntry[],
  orderBy: OrderByInput,
  alias: string
): Sql {
  const { adapter } = ctx;
  const directions = cursorEntries.map(({ fieldName }) =>
    getFieldDirection(fieldName, orderBy)
  );
  const firstDirection = directions[0];
  const hasMixedDirections = directions.some((d) => d !== firstDirection);

  if (hasMixedDirections) {
    throw new QueryEngineError(
      "Compound cursor with mixed sort directions (asc/desc) is not supported. " +
        "Either use a single-field cursor or ensure all orderBy fields use the same direction."
    );
  }

  const columns = cursorEntries.map(({ fieldName }) => {
    const columnName = getColumnName(ctx.model, fieldName);
    return adapter.identifiers.column(alias, columnName);
  });
  const values = cursorEntries.map(({ fieldName, value }) =>
    scalarValueLiteral(ctx, fieldName, value)
  );
  const columnTuple = sql`(${sql.join(columns, ", ")})`;
  const valueTuple = sql`(${sql.join(values, ", ")})`;

  if (firstDirection === "desc") {
    return adapter.operators.lte(columnTuple, valueTuple);
  }
  return adapter.operators.gte(columnTuple, valueTuple);
}

function getFieldDirection(
  field: string,
  orderBy: OrderByInput
): "asc" | "desc" {
  if (!orderBy) return "asc";

  const orderByArray = Array.isArray(orderBy) ? orderBy : [orderBy];

  for (const order of orderByArray) {
    if (field in order) {
      const direction = order[field];

      if (typeof direction === "string") {
        if (direction === "desc") {
          return "desc";
        }
        return "asc";
      }

      if (isRecord(direction)) {
        if (direction.sort === "desc") {
          return "desc";
        }
        return "asc";
      }

      return "asc";
    }
  }

  return "asc";
}
