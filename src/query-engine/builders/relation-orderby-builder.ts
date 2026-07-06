/**
 * Relation OrderBy Builder
 *
 * Builds relation order expressions for top-level SELECT queries.
 */

import type { Sql } from "@sql";
import { getColumnName, getTableName, isScalarField } from "../context";
import {
  type QueryContext,
  QueryEngineError,
  type RelationInfo,
} from "../types";
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

export function buildRelationOrders(
  ctx: QueryContext,
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
      relationAliases
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
  ctx: QueryContext,
  relationInfo: RelationInfo,
  orderBy: Record<string, unknown>,
  parentAlias: string,
  relationAliases: Map<string, RelationOrderAlias>
): Sql[] {
  const orders: Sql[] = [];
  const relatedAlias = getRelationOrderAlias(
    ctx,
    relationInfo,
    parentAlias,
    relationAliases
  ).alias;

  for (const [field, value] of Object.entries(orderBy)) {
    if (value === undefined) {
      continue;
    }

    if (!isScalarField(relationInfo.targetModel, field)) {
      throw new QueryEngineError(
        `Relation orderBy '${relationInfo.name}.${field}' must reference a scalar field.`
      );
    }

    const columnName = getColumnName(relationInfo.targetModel, field);
    const column = ctx.adapter.identifiers.column(relatedAlias, columnName);
    orders.push(buildSingleOrder(ctx, column, value));
  }

  if (orders.length === 0) {
    throw new QueryEngineError(
      `Relation orderBy '${relationInfo.name}' requires at least one scalar field.`
    );
  }

  return orders;
}

function getRelationOrderAlias(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  parentAlias: string,
  relationAliases: Map<string, RelationOrderAlias>
): RelationOrderAlias {
  const existing = relationAliases.get(relationInfo.name);
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
  relationAliases.set(relationInfo.name, entry);
  return entry;
}

function buildToManyRelationOrders(
  ctx: QueryContext,
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
