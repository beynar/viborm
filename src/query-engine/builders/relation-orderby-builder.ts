/**
 * Relation OrderBy Builder
 *
 * Builds relation order expressions for top-level SELECT queries.
 */

import type { Sql } from "@sql";
import {
  createChildScope,
  getColumnName,
  getRelationInfo,
  getTableName,
  isRelation,
  isScalarField,
} from "../context";
import { QueryEngineError, type QueryScope, type RelationInfo } from "../types";
import { buildCorrelation } from "./correlation-utils";
import { buildRelationCount } from "./relation-count-builder";
import { buildSingleOrder } from "./sort-order-builder";

export interface RelationOrderAlias {
  alias: string;
  join: Sql;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const MAX_RELATION_ORDER_DEPTH = 3;

export function buildRelationOrders(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  value: unknown,
  parentAlias: string,
  relationAliases: Map<string, RelationOrderAlias>
): Sql[] {
  if (!isRecord(value)) {
    throw new QueryEngineError(
      `Relation orderBy '${relationInfo.name}' must be an object.`
    );
  }

  if (relationInfo.isToOne) {
    return buildToOneRelationOrders(
      ctx,
      relationInfo,
      value,
      parentAlias,
      relationAliases,
      relationInfo.name,
      1
    );
  }

  if (relationInfo.isToMany) {
    return buildToManyRelationOrders(ctx, relationInfo, value, parentAlias);
  }

  throw new QueryEngineError(
    `Unsupported relation orderBy '${relationInfo.name}'.`
  );
}

function buildToOneRelationOrders(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  orderBy: Record<string, unknown>,
  parentAlias: string,
  relationAliases: Map<string, RelationOrderAlias>,
  relationPath: string,
  depth: number
): Sql[] {
  if (depth > MAX_RELATION_ORDER_DEPTH) {
    throw new QueryEngineError(
      `Relation orderBy path '${relationPath}' exceeds maximum depth of ${MAX_RELATION_ORDER_DEPTH} relation hops.`
    );
  }

  const orders: Sql[] = [];
  const relatedAlias = getRelationOrderAlias(
    ctx,
    relationInfo,
    parentAlias,
    relationAliases,
    relationPath
  ).alias;
  const targetCtx = createChildScope(
    ctx,
    relationInfo.targetModel,
    relatedAlias
  );

  for (const [field, value] of Object.entries(orderBy)) {
    if (value === undefined) {
      continue;
    }

    const fieldPath = `${relationPath}.${field}`;

    if (isRelation(relationInfo.targetModel, field)) {
      const nestedRelationInfo = getRelationInfo(targetCtx, field);
      if (!nestedRelationInfo) {
        throw new QueryEngineError(
          `Unknown relation orderBy field '${fieldPath}'.`
        );
      }

      if (nestedRelationInfo.isToMany) {
        throw new QueryEngineError(
          `Relation orderBy '${fieldPath}' cannot order through a to-many relation; use '_count'.`
        );
      }

      if (!nestedRelationInfo.isToOne) {
        throw new QueryEngineError(
          `Unsupported relation orderBy '${fieldPath}'.`
        );
      }

      if (!isRecord(value)) {
        throw new QueryEngineError(
          `Relation orderBy '${fieldPath}' must be an object.`
        );
      }

      orders.push(
        ...buildToOneRelationOrders(
          targetCtx,
          nestedRelationInfo,
          value,
          relatedAlias,
          relationAliases,
          fieldPath,
          depth + 1
        )
      );
      continue;
    }

    if (!isScalarField(relationInfo.targetModel, field)) {
      throw new QueryEngineError(
        `Unknown relation orderBy field '${fieldPath}'.`
      );
    }

    const columnName = getColumnName(relationInfo.targetModel, field);
    const column = ctx.adapter.identifiers.column(relatedAlias, columnName);
    const scalar = relationInfo.targetModel["~"].state.scalars[field];
    orders.push(
      buildSingleOrder(ctx, column, value, {
        name: fieldPath,
        scalarState: scalar?.["~"].state,
      })
    );
  }

  if (orders.length === 0) {
    throw new QueryEngineError(
      `Relation orderBy '${relationPath}' requires at least one scalar field.`
    );
  }

  return orders;
}

function getRelationOrderAlias(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  parentAlias: string,
  relationAliases: Map<string, RelationOrderAlias>,
  relationPath: string
): RelationOrderAlias {
  const existing = relationAliases.get(relationPath);
  if (existing) {
    return existing;
  }

  const relatedAlias = ctx.nextAlias();
  const relatedTableName = getTableName(relationInfo.targetModel);
  const relatedTable = ctx.adapter.identifiers.table(
    relatedTableName,
    relatedAlias
  );
  const condition = buildCorrelation(
    ctx,
    relationInfo,
    parentAlias,
    relatedAlias
  );
  const join = ctx.adapter.joins.left(relatedTable, condition);
  const entry = { alias: relatedAlias, join };
  relationAliases.set(relationPath, entry);
  return entry;
}

function buildToManyRelationOrders(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  orderBy: Record<string, unknown>,
  parentAlias: string
): Sql[] {
  const definedEntries = Object.entries(orderBy).filter(
    ([, value]) => value !== undefined
  );

  if (definedEntries.length === 0) {
    throw new QueryEngineError(
      `Relation orderBy '${relationInfo.name}' requires _count.`
    );
  }

  for (const [field] of definedEntries) {
    if (field !== "_count") {
      throw new QueryEngineError(
        `Relation orderBy '${relationInfo.name}.${field}' is not supported. Use '${relationInfo.name}._count' instead.`
      );
    }
  }

  const countOrder = orderBy._count;
  if (countOrder !== "asc" && countOrder !== "desc") {
    throw new QueryEngineError(
      `Relation orderBy '${relationInfo.name}._count' must be 'asc' or 'desc'.`
    );
  }

  const countSql = buildRelationCount(ctx, relationInfo, true, parentAlias);
  return [buildSingleOrder(ctx, countSql, countOrder)];
}
