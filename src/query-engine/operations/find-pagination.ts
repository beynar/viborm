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
import { getColumnName, getTableName, isScalarField } from "../context";
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
    // Any orderBy is allowed with a cursor (Prisma parity). When it does not
    // line up with the cursor field(s), buildCursorCondition falls back to a
    // keyset row-value comparison against the cursor row's order values.
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

/**
 * The cursor's single/compound-tuple fast path applies only when the orderBy
 * is exactly the cursor field(s) in cursor order — then the cursor's own input
 * values drive the comparison. Otherwise we need the keyset path.
 */
function orderByMatchesCursorFields(
  cursorEntries: WhereUniqueEntry[],
  orderBy: OrderByInput
): boolean {
  if (!orderBy) {
    return true;
  }
  const cursorFields = cursorEntries.map(({ fieldName }) => fieldName);
  const orderFields = getOrderByFields(orderBy);

  if (orderFields.length !== cursorFields.length) {
    return false;
  }

  return orderFields.every((field, i) => field === cursorFields[i]);
}

function getOrderByFields(orderBy: OrderByInput): string[] {
  if (!orderBy) {
    return [];
  }
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

  // Keyset path: the orderBy is not the cursor field(s), so compare the
  // ordered columns against the cursor row's order values (Prisma parity).
  if (!orderByMatchesCursorFields(cursorEntries, orderBy)) {
    return buildKeysetCursor(ctx, cursorEntries, orderBy, alias);
  }

  if (cursorEntries.length === 1) {
    const { fieldName, value } = cursorEntries[0]!;
    return buildSingleFieldCursor(ctx, fieldName, value, orderBy, alias);
  }

  return buildCompoundCursor(ctx, cursorEntries, orderBy, alias);
}

/**
 * Build a keyset (row-value) cursor comparison over an arbitrary orderBy.
 *
 * For orderBy (o1 d1, o2 d2, …), rows at-or-after the cursor row C are:
 *   (o1 ⋈1 c1)
 *   OR (o1 = c1 AND o2 ⋈2 c2)
 *   OR … OR (o1 = c1 AND … AND o_{n-1} = c_{n-1} AND on ⋈n cn)
 *   OR (o1 = c1 AND … AND on = cn)              -- inclusive of the cursor row
 * where ⋈i is `>` for asc / `<` for desc. Each ci is the cursor row's value
 * for that column: the cursor's own input value when the column is a cursor
 * field, otherwise a scalar subquery selecting it from the cursor row.
 */
function buildKeysetCursor(
  ctx: QueryContext,
  cursorEntries: WhereUniqueEntry[],
  orderBy: OrderByInput,
  alias: string
): Sql {
  const { adapter } = ctx;
  const fields = getOrderByFields(orderBy);
  const cursorValues = new Map(
    cursorEntries.map(({ fieldName, value }) => [fieldName, value])
  );

  const cols: Sql[] = [];
  const values: Sql[] = [];
  const directions: ("asc" | "desc")[] = [];
  for (const field of fields) {
    if (!isScalarField(ctx.model, field)) {
      throw new QueryEngineError(
        `Cursor pagination orderBy field '${field}' must be a scalar field.`
      );
    }
    cols.push(
      adapter.identifiers.column(alias, getColumnName(ctx.model, field))
    );
    values.push(cursorRowValue(ctx, cursorEntries, cursorValues, field));
    directions.push(getFieldDirection(field, orderBy));
  }

  const orTerms: Sql[] = [];
  for (let i = 0; i < fields.length; i++) {
    const andParts: Sql[] = [];
    for (let j = 0; j < i; j++) {
      andParts.push(adapter.operators.eq(cols[j]!, values[j]!));
    }
    const strict =
      directions[i] === "desc" ? adapter.operators.lt : adapter.operators.gt;
    andParts.push(strict(cols[i]!, values[i]!));
    orTerms.push(
      andParts.length === 1 ? andParts[0]! : adapter.operators.and(...andParts)
    );
  }

  // Inclusive of the cursor row itself (Prisma includes it unless skipped).
  const allEqual = cols.map((col, i) => adapter.operators.eq(col, values[i]!));
  orTerms.push(adapter.operators.and(...allEqual));

  return adapter.operators.or(...orTerms);
}

/**
 * The cursor row's value for one order column: the cursor input value when the
 * column is itself a cursor field, otherwise an uncorrelated scalar subquery
 * fetching it from the cursor row (identified by the unique cursor condition).
 */
function cursorRowValue(
  ctx: QueryContext,
  cursorEntries: WhereUniqueEntry[],
  cursorValues: Map<string, unknown>,
  field: string
): Sql {
  if (cursorValues.has(field)) {
    return scalarValueLiteral(ctx, field, cursorValues.get(field));
  }

  const { adapter } = ctx;
  const subAlias = ctx.nextAlias();
  const from = adapter.identifiers.table(getTableName(ctx.model), subAlias);
  const column = adapter.identifiers.column(
    subAlias,
    getColumnName(ctx.model, field)
  );
  const whereConditions = cursorEntries.map(({ fieldName, value }) =>
    adapter.operators.eq(
      adapter.identifiers.column(subAlias, getColumnName(ctx.model, fieldName)),
      scalarValueLiteral(ctx, fieldName, value)
    )
  );
  const select = adapter.assemble.select({
    columns: column,
    from,
    where: adapter.operators.and(...whereConditions),
    limit: adapter.literals.value(1),
  });
  return sql`(${select})`;
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
