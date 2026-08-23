/**
 * OrderBy Builder
 *
 * Builds ORDER BY clauses from orderBy input.
 */

import { type Sql, sql } from "@sql";
import {
  getColumnName,
  isScalarField,
  isVariantRelation,
  lookupRelation,
  variantCarrier,
} from "../context";
import {
  isVariantRowCarrier,
  QueryEngineError,
  type QueryScope,
} from "../types";
import { assertExactDecimalOperation } from "./decimal-portability";
import {
  buildPolymorphicRelationOrders,
  buildRelationOrders,
  type RelationOrderAlias,
} from "./relation-orderby-builder";
import { buildSingleOrder } from "./sort-order-builder";

export interface OrderByParts {
  orderBy: Sql | undefined;
  joins: Sql[];
}

/**
 * Build ORDER BY clause and relation joins for SELECT queries.
 */
export function buildOrderByParts(
  ctx: QueryScope,
  orderBy: Record<string, unknown> | Record<string, unknown>[] | undefined,
  alias: string
): OrderByParts {
  return buildOrderByInternal(ctx, orderBy, alias, true);
}

function buildOrderByInternal(
  ctx: QueryScope,
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
        const relationRef = lookupRelation(ctx, field);
        if (relationRef) {
          if (!allowRelationOrder) {
            throw new QueryEngineError(
              `Relation orderBy '${field}' is not supported in this context.`
            );
          }
          orders.push(
            ...buildRelationOrders(
              ctx,
              relationRef,
              value,
              alias,
              relationAliases
            )
          );
          continue;
        }
        if (isVariantRelation(ctx, field)) {
          if (!allowRelationOrder) {
            throw new QueryEngineError(
              `Relation orderBy '${field}' is not supported in this context.`
            );
          }
          const polymorphic = variantCarrier(ctx, field);
          // A row-held polymorphic slot adds NO root ordering (plan §7.4), so it
          // stays the unknown key it has always been; only a collection's
          // `_count` reaches the order surface.
          if (!polymorphic || isVariantRowCarrier(polymorphic)) {
            throw new QueryEngineError(`Unknown orderBy field '${field}'.`);
          }
          orders.push(
            ...buildPolymorphicRelationOrders(ctx, polymorphic, value, alias)
          );
          continue;
        }
        throw new QueryEngineError(`Unknown orderBy field '${field}'.`);
      }

      // Ordering a decimal is exact only where the dialect has an exact decimal
      // type. On SQLite the column holds canonical TEXT, whose byte order is
      // NOT numeric order ("9" sorts after "10"), and the cast that would fix
      // that goes through a double — so the sort is refused, not approximated.
      assertExactDecimalOperation(ctx, field, "orderBy");

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
