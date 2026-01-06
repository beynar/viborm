/**
 * Include Builder
 *
 * Builds nested relation subqueries with JSON aggregation.
 * - To-one: scalar subquery returning JSON object or null
 * - To-many: scalar subquery returning JSON array
 */

import { type Sql, sql } from "@sql";
import { createChildContext, getTableName } from "../context";
import type { QueryContext, RelationInfo } from "../types";
import { buildCorrelation } from "./correlation-utils";
import {
  buildManyToManyJoinParts,
  getManyToManyJoinInfo,
} from "./many-to-many-utils";
import { buildOrderBy } from "./orderby-builder";
import { buildSelect } from "./select-builder";
import { buildWhere } from "./where-builder";

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
  // Handle manyToMany specially - requires junction table
  if (relationInfo.type === "manyToMany") {
    return buildManyToManyInclude(ctx, relationInfo, includeValue, parentAlias);
  }

  const relatedAlias = ctx.nextAlias();
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    relatedAlias
  );

  // Extract include options
  const { select, include, where, orderBy, take, skip } = includeValue as {
    select?: Record<string, unknown>;
    include?: Record<string, unknown>;
    where?: Record<string, unknown>;
    orderBy?: Record<string, unknown> | Record<string, unknown>[];
    take?: number;
    skip?: number;
  };

  // Build the JSON object for selected fields (using asJson: true)
  const jsonExpr = buildSelect(childCtx, select, include, relatedAlias, {
    asJson: true,
  });

  // Build WHERE with correlation (throws if fields/references not defined)
  const correlation = buildCorrelation(
    ctx,
    relationInfo,
    parentAlias,
    relatedAlias
  );
  const innerWhere = buildWhere(childCtx, where, relatedAlias);

  const whereCondition = innerWhere
    ? ctx.adapter.operators.and(correlation, innerWhere)
    : correlation;

  // Build ORDER BY
  const orderBySql = buildOrderBy(childCtx, orderBy, relatedAlias);

  // Build the inner query
  const relatedTableName = getTableName(relationInfo.targetModel);
  const fromTable = ctx.adapter.identifiers.table(
    relatedTableName,
    relatedAlias
  );

  if (relationInfo.isToMany) {
    // To-many: aggregate into JSON array
    return buildToManySubquery(
      ctx,
      jsonExpr,
      fromTable,
      whereCondition,
      orderBySql,
      take,
      skip
    );
  }
  // To-one: single JSON object or null
  return buildToOneSubquery(ctx, jsonExpr, fromTable, whereCondition);
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

  // Alias for the JSON column in the inner query
  const jsonColAlias = "_json";
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

  // Build inner query that returns JSON objects with a named column
  const innerParts: Sql[] = [
    sql`SELECT ${aliasedJsonExpr}`,
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

  // Wrap with aggregation: SELECT COALESCE(json_agg(subAlias._json), '[]') FROM (innerQuery) subAlias
  const subAlias = ctx.nextAlias();
  const jsonColumn = adapter.identifiers.column(subAlias, jsonColAlias);
  return adapter.subqueries.scalar(
    sql`SELECT ${adapter.json.agg(jsonColumn)} FROM (${innerQuery}) ${adapter.identifiers.escape(subAlias)}`
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

/**
 * Build include for manyToMany relation using junction table.
 *
 * SQL pattern:
 * SELECT COALESCE(json_agg(t0), '[]') FROM (
 *   SELECT json_build_object('id', t.id, 'name', t.name)
 *   FROM junction_table jt, target_table t
 *   WHERE jt.sourceId = parent.id AND t.id = jt.targetId
 *   [AND inner_where]
 *   [ORDER BY ...]
 *   [LIMIT/OFFSET]
 * ) t0
 */
function buildManyToManyInclude(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>,
  parentAlias: string
): Sql {
  const { adapter } = ctx;

  const junctionAlias = ctx.nextAlias();
  const targetAlias = ctx.nextAlias();

  const joinInfo = getManyToManyJoinInfo(ctx, relationInfo);
  const { correlationCondition, joinCondition, fromClause } =
    buildManyToManyJoinParts(
      ctx,
      joinInfo,
      parentAlias,
      junctionAlias,
      targetAlias
    );

  // Create child context for target
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    targetAlias
  );

  // Extract include options
  const { select, include, where, orderBy, take, skip } = includeValue as {
    select?: Record<string, unknown>;
    include?: Record<string, unknown>;
    where?: Record<string, unknown>;
    orderBy?: Record<string, unknown> | Record<string, unknown>[];
    take?: number;
    skip?: number;
  };

  // Build the JSON object for selected fields
  const jsonExpr = buildSelect(childCtx, select, include, targetAlias, {
    asJson: true,
  });

  // Build inner where on target
  const innerWhere = buildWhere(childCtx, where, targetAlias);

  // Combine conditions
  const conditions: Sql[] = [correlationCondition, joinCondition];
  if (innerWhere) {
    conditions.push(innerWhere);
  }
  const whereCondition = adapter.operators.and(...conditions);

  // Build ORDER BY
  const orderBySql = buildOrderBy(childCtx, orderBy, targetAlias);

  // Alias for the JSON column in the inner query
  const jsonColAlias = "_json";
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

  // Build inner query
  const innerParts: Sql[] = [
    sql`SELECT ${aliasedJsonExpr}`,
    sql`FROM ${fromClause}`,
    sql`WHERE ${whereCondition}`,
  ];

  if (orderBySql) {
    innerParts.push(sql`ORDER BY ${orderBySql}`);
  }

  if (take !== undefined) {
    innerParts.push(sql`LIMIT ${adapter.literals.value(take)}`);
  }

  if (skip !== undefined) {
    innerParts.push(sql`OFFSET ${adapter.literals.value(skip)}`);
  }

  const innerQuery = sql.join(innerParts, " ");

  // Wrap with aggregation
  const subAlias = ctx.nextAlias();
  const jsonColumn = adapter.identifiers.column(subAlias, jsonColAlias);
  return adapter.subqueries.scalar(
    sql`SELECT ${adapter.json.agg(jsonColumn)} FROM (${innerQuery}) ${adapter.identifiers.escape(subAlias)}`
  );
}
