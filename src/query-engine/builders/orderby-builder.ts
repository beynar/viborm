/**
 * OrderBy Builder
 *
 * Builds ORDER BY clauses from orderBy input.
 */

import { type Sql, sql } from "@sql";
import {
  getColumnName,
  getRelationInfo,
  isRelation,
  isScalarField,
} from "../context";
import { type QueryContext, QueryEngineError } from "../types";
import {
  buildRelationOrders,
  type RelationOrderAlias,
} from "./relation-orderby-builder";
import { buildSingleOrder } from "./sort-order-builder";

export interface OrderByParts {
  orderBy: Sql | undefined;
  joins: Sql[];
}

/**
 * Build ORDER BY clause
 *
 * @param ctx - Query context
 * @param orderBy - OrderBy input (object or array of objects)
 * @param alias - Current table alias
 * @returns SQL for ORDER BY or undefined if no ordering
 */
export function buildOrderBy(
  ctx: QueryContext,
  orderBy: Record<string, unknown> | Record<string, unknown>[] | undefined,
  alias: string
): Sql | undefined {
  return buildOrderByInternal(ctx, orderBy, alias, false).orderBy;
}

/**
 * Build ORDER BY clause and relation joins for SELECT queries.
 */
export function buildOrderByParts(
  ctx: QueryContext,
  orderBy: Record<string, unknown> | Record<string, unknown>[] | undefined,
  alias: string
): OrderByParts {
  return buildOrderByInternal(ctx, orderBy, alias, true);
}

function buildOrderByInternal(
  ctx: QueryContext,
  orderBy: Record<string, unknown> | Record<string, unknown>[] | undefined,
  alias: string,
  allowRelationOrder: boolean
): OrderByParts {
  if (!orderBy) {
    return { orderBy: undefined, joins: [] };
  }

  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  const orders: Sql[] = [];
  const relationAliases = new Map<string, RelationOrderAlias>();

  for (const item of items) {
    for (const [field, value] of Object.entries(item)) {
      if (value === undefined) {
        continue;
      }

      if (!isScalarField(ctx.model, field)) {
        if (isRelation(ctx.model, field)) {
          if (!allowRelationOrder) {
            throw new QueryEngineError(
              `Relation orderBy '${field}' is not supported in this context.`
            );
          }
          const relationInfo = getRelationInfo(ctx, field);
          if (!relationInfo) {
            throw new QueryEngineError(`Unknown orderBy field '${field}'.`);
          }
          orders.push(
            ...buildRelationOrders(
              ctx,
              relationInfo,
              value,
              alias,
              relationAliases
            )
          );
          continue;
        }
        throw new QueryEngineError(`Unknown orderBy field '${field}'.`);
      }

      // Resolve field name to actual column name (handles .map() overrides)
      const columnName = getColumnName(ctx.model, field);
      const column = ctx.adapter.identifiers.column(alias, columnName);
      const scalar = ctx.model["~"].state.scalars[field];
      orders.push(
        buildSingleOrder(ctx, column, value, {
          name: field,
          scalarState: scalar?.["~"].state,
        })
      );
    }
  }

  if (orders.length === 0) {
    return {
      orderBy: undefined,
      joins: [...relationAliases.values()].map((entry) => entry.join),
    };
  }

  return {
    orderBy: sql.join(orders, ", "),
    joins: [...relationAliases.values()].map((entry) => entry.join),
  };
}
