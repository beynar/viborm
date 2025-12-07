/**
 * Include Builder
 *
 * Builds nested relation subqueries with JSON aggregation.
 * - To-one: scalar subquery returning JSON object or null
 * - To-many: scalar subquery returning JSON array
 */

import { sql, Sql } from "@sql";
import type { QueryContext, RelationInfo } from "../types";
import { createChildContext, getTableName } from "../context";
import { buildSelect } from "./select-builder";
import { buildWhere } from "./where-builder";
import { buildOrderBy } from "./orderby-builder";
import { buildCorrelation } from "./correlation-utils";

/**
 * Build an include (relation subquery with JSON aggregation)
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param includeValue - Include options (select, include, where, orderBy, take, skip)
 * @param parentAlias - Parent table alias
 * @returns SQL for the relation subquery
 */
export function buildInclude(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>,
  parentAlias: string
): Sql {
  const relatedAlias = ctx.nextAlias();
  const childCtx = createChildContext(ctx, relationInfo.targetModel, relatedAlias);

  // Extract include options
  const {
    select,
    include,
    where,
    orderBy,
    take,
    skip,
  } = includeValue as {
    select?: Record<string, unknown>;
    include?: Record<string, unknown>;
    where?: Record<string, unknown>;
    orderBy?: Record<string, unknown> | Record<string, unknown>[];
    take?: number;
    skip?: number;
  };

  // Build the JSON object for selected fields (using asJson: true)
  const jsonExpr = buildSelect(childCtx, select, include, relatedAlias, { asJson: true });

  // Build WHERE with correlation (throws if fields/references not defined)
  const correlation = buildCorrelation(ctx, relationInfo, parentAlias, relatedAlias);
  const innerWhere = buildWhere(childCtx, where, relatedAlias);

  const whereCondition = innerWhere
    ? ctx.adapter.operators.and(correlation, innerWhere)
    : correlation;

  // Build ORDER BY
  const orderBySql = buildOrderBy(childCtx, orderBy, relatedAlias);

  // Build the inner query
  const relatedTableName = getTableName(relationInfo.targetModel);
  const fromTable = ctx.adapter.identifiers.table(relatedTableName, relatedAlias);

  if (relationInfo.isToMany) {
    // To-many: aggregate into JSON array
    return buildToManySubquery(ctx, jsonExpr, fromTable, whereCondition, orderBySql, take, skip);
  } else {
    // To-one: single JSON object or null
    return buildToOneSubquery(ctx, jsonExpr, fromTable, whereCondition);
  }
}

/**
 * Build to-many relation subquery with JSON aggregation
 */
function buildToManySubquery(
  ctx: QueryContext,
  jsonExpr: Sql,
  fromTable: Sql,
  where: Sql,
  orderBy: Sql | undefined,
  take: number | undefined,
  skip: number | undefined
): Sql {
  const { adapter } = ctx;

  // Build inner query that returns JSON objects
  const innerParts: Sql[] = [
    sql`SELECT ${jsonExpr}`,
    sql`FROM ${fromTable}`,
    sql`WHERE ${where}`,
  ];

  if (orderBy) {
    innerParts.push(sql`ORDER BY ${orderBy}`);
  }

  if (take !== undefined) {
    innerParts.push(sql`LIMIT ${adapter.literals.value(take)}`);
  }

  if (skip !== undefined) {
    innerParts.push(sql`OFFSET ${adapter.literals.value(skip)}`);
  }

  const innerQuery = sql.join(innerParts, " ");

  // Wrap with aggregation: SELECT COALESCE(json_agg(alias), '[]') FROM (innerQuery) alias
  const subAlias = ctx.nextAlias();
  return adapter.subqueries.scalar(
    sql`SELECT ${adapter.json.agg(adapter.identifiers.escape(subAlias))} FROM (${innerQuery}) ${adapter.identifiers.escape(subAlias)}`
  );
}

/**
 * Build to-one relation subquery returning JSON object or null
 */
function buildToOneSubquery(
  ctx: QueryContext,
  jsonExpr: Sql,
  fromTable: Sql,
  where: Sql
): Sql {
  const { adapter } = ctx;

  // Build query: SELECT json_object FROM table WHERE ... LIMIT 1
  const query = sql`SELECT ${jsonExpr} FROM ${fromTable} WHERE ${where} LIMIT 1`;

  return adapter.subqueries.scalar(query);
}
