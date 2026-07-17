/**
 * Cursor total order
 *
 * Normalizes scalar ordering once so SQL ordering and cursor comparison share
 * the same direction, null placement, and deterministic tie-break vector.
 */

import { type Sql, sql } from "@sql";
import type { WhereUniqueEntry } from "../builders/where-unique-builder";
import { getColumnName, isScalarField } from "../context";
import { QueryEngineError, type QueryScope } from "../types";

export type OrderByInput =
  | Record<string, unknown>
  | Record<string, unknown>[]
  | undefined;

export type CursorOrderDirection = "asc" | "desc";
export type CursorNullPlacement = "first" | "last";

export interface NormalizedCursorOrder {
  field: string;
  expression: Sql;
  direction: CursorOrderDirection;
  nulls: CursorNullPlacement;
  isTieBreaker: boolean;
}

type ParsedOrder = {
  direction: CursorOrderDirection;
  nulls: CursorNullPlacement;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export function normalizeCursorOrder(
  ctx: QueryScope,
  orderBy: OrderByInput,
  cursorEntries: WhereUniqueEntry[] | undefined,
  take: number | undefined,
  alias: string
): NormalizedCursorOrder[] | undefined {
  if (!cursorEntries && take === undefined) {
    return undefined;
  }

  const requested = parseRequestedScalarOrder(ctx, orderBy, alias);
  if (!requested) {
    if (cursorEntries) {
      throw new QueryEngineError(
        "Cursor pagination supports direct scalar sort directions only; relation and vector-distance orderBy are not supported."
      );
    }
    return undefined;
  }

  const normalized = [...requested];
  const orderedFields = new Set(normalized.map(({ field }) => field));
  const identityFields = getCanonicalIdentityFields(ctx);
  if (identityFields.length === 0) {
    throw new QueryEngineError(
      "Paginated scalar ordering requires a primary model identifier."
    );
  }
  appendTieBreakers(ctx, normalized, orderedFields, identityFields, alias);

  if (cursorEntries) {
    appendTieBreakers(
      ctx,
      normalized,
      orderedFields,
      sortFieldsByModelKey(
        ctx,
        cursorEntries.map(({ fieldName }) => fieldName)
      ),
      alias
    );
  }

  return normalized;
}

export function reverseCursorOrder(
  order: NormalizedCursorOrder[]
): NormalizedCursorOrder[] {
  return order.map((key) => ({
    ...key,
    direction: key.direction === "asc" ? "desc" : "asc",
    nulls: key.nulls === "first" ? "last" : "first",
  }));
}

export function buildNormalizedOrderBy(
  ctx: QueryScope,
  order: NormalizedCursorOrder[]
): Sql | undefined {
  const orders = order.map((key) =>
    key.nulls === "first"
      ? ctx.adapter.orderBy.nullsFirst(key.expression, key.direction)
      : ctx.adapter.orderBy.nullsLast(key.expression, key.direction)
  );

  return orders.length > 0 ? sql.join(orders, ", ") : undefined;
}

function parseRequestedScalarOrder(
  ctx: QueryScope,
  orderBy: OrderByInput,
  alias: string
): NormalizedCursorOrder[] | undefined {
  if (!orderBy) {
    return [];
  }

  const normalized: NormalizedCursorOrder[] = [];
  const seen = new Set<string>();
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];

  for (const item of items) {
    for (const [field, value] of Object.entries(item)) {
      if (value === undefined || seen.has(field)) {
        continue;
      }

      if (!isScalarField(ctx.model, field)) {
        return undefined;
      }

      const parsed = parseScalarOrder(value);
      if (!parsed) {
        return undefined;
      }

      seen.add(field);
      normalized.push({
        field,
        expression: ctx.adapter.identifiers.column(
          alias,
          getColumnName(ctx.model, field)
        ),
        direction: parsed.direction,
        nulls: parsed.nulls,
        isTieBreaker: false,
      });
    }
  }

  return normalized;
}

function parseScalarOrder(value: unknown): ParsedOrder | undefined {
  if (value === "asc" || value === "desc") {
    return {
      direction: value,
      nulls: defaultNullPlacement(value),
    };
  }

  if (!isRecord(value) || value._distance !== undefined) {
    return undefined;
  }

  const direction = value.sort;
  if (direction !== "asc" && direction !== "desc") {
    return undefined;
  }

  const nulls = value.nulls;
  if (nulls !== undefined && nulls !== "first" && nulls !== "last") {
    return undefined;
  }

  return {
    direction,
    nulls: nulls ?? defaultNullPlacement(direction),
  };
}

function defaultNullPlacement(
  direction: CursorOrderDirection
): CursorNullPlacement {
  return direction === "asc" ? "last" : "first";
}

function appendTieBreakers(
  ctx: QueryScope,
  order: NormalizedCursorOrder[],
  orderedFields: Set<string>,
  fields: string[],
  alias: string
): void {
  for (const field of fields) {
    if (orderedFields.has(field)) {
      continue;
    }

    if (!isScalarField(ctx.model, field)) {
      throw new QueryEngineError(
        `Cursor tie-break field '${field}' must be a scalar field.`
      );
    }

    orderedFields.add(field);
    order.push({
      field,
      expression: ctx.adapter.identifiers.column(
        alias,
        getColumnName(ctx.model, field)
      ),
      direction: "asc",
      nulls: "last",
      isTieBreaker: true,
    });
  }
}

function getCanonicalIdentityFields(ctx: QueryScope): string[] {
  const state = ctx.model["~"].state;
  const scalarNames = Object.keys(state.scalars);
  const scalarId = scalarNames.find(
    (field) => state.scalars[field]?.["~"].state.isId === true
  );
  if (scalarId) {
    return [scalarId];
  }

  const compoundId = getFirstCompoundConstraint(state.compoundId);
  if (compoundId) {
    return sortFieldsByModelKey(ctx, Object.keys(compoundId.entries));
  }

  return [];
}

function getFirstCompoundConstraint(
  constraints: Record<string, { entries: Record<string, unknown> }> | undefined
): { entries: Record<string, unknown> } | undefined {
  if (!constraints) {
    return undefined;
  }

  for (const constraint of Object.values(constraints)) {
    return constraint;
  }

  return undefined;
}

function sortFieldsByModelKey(ctx: QueryScope, fields: string[]): string[] {
  const fieldSet = new Set(fields);
  return Object.keys(ctx.model["~"].state.scalars).filter((field) =>
    fieldSet.has(field)
  );
}
