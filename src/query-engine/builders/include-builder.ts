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
import { buildCorrelation, getPrimaryKeyField } from "./correlation-utils";
import {
  getJunctionTableName,
  getJunctionFieldNames,
} from "@schema/relation/relation";

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
  parentAlias: string,
): Sql {
  // Handle manyToMany specially - requires junction table
  if (relationInfo.type === "manyToMany") {
    return buildManyToManyInclude(ctx, relationInfo, includeValue, parentAlias);
  }

  const relatedAlias = ctx.nextAlias();
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    relatedAlias,
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
    relatedAlias,
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
    relatedAlias,
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
      skip,
    );
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
  skip: number | undefined,
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
    sql`SELECT ${adapter.json.agg(adapter.identifiers.escape(subAlias))} FROM (${innerQuery}) ${adapter.identifiers.escape(subAlias)}`,
  );
}

/**
 * Build to-one relation subquery returning JSON object or null
 */
function buildToOneSubquery(
  ctx: QueryContext,
  jsonExpr: Sql,
  fromTable: Sql,
  where: Sql,
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
  parentAlias: string,
): Sql {
  const { adapter } = ctx;

  // Get model names for junction table resolution
  const sourceModelName = ctx.model["~"].names.ts ?? "unknown";
  const targetModelName = relationInfo.targetModel["~"].names.ts ?? "unknown";

  // Get junction table info
  const junctionTableName = getJunctionTableName(
    relationInfo.relation,
    sourceModelName,
    targetModelName,
  );
  const [sourceFieldName, targetFieldName] = getJunctionFieldNames(
    relationInfo.relation,
    sourceModelName,
    targetModelName,
  );

  // Get primary key fields
  const sourcePkField = getPrimaryKeyField(ctx.model);
  const targetPkField = getPrimaryKeyField(relationInfo.targetModel);

  // Create aliases
  const junctionAlias = ctx.nextAlias();
  const targetAlias = ctx.nextAlias();
  const targetTableName = getTableName(relationInfo.targetModel);

  // Create child context for target
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    targetAlias,
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

  // Build conditions:
  // 1. Correlation: jt.sourceId = parent.id
  const junctionSourceCol = adapter.identifiers.column(
    junctionAlias,
    sourceFieldName,
  );
  const parentPkCol = adapter.identifiers.column(parentAlias, sourcePkField);
  const correlationCondition = adapter.operators.eq(
    junctionSourceCol,
    parentPkCol,
  );

  // 2. Junction to target join: t.id = jt.targetId
  const targetPkCol = adapter.identifiers.column(targetAlias, targetPkField);
  const junctionTargetCol = adapter.identifiers.column(
    junctionAlias,
    targetFieldName,
  );
  const joinCondition = adapter.operators.eq(targetPkCol, junctionTargetCol);

  // 3. Inner where on target
  const innerWhere = buildWhere(childCtx, where, targetAlias);

  // Combine conditions
  const conditions: Sql[] = [correlationCondition, joinCondition];
  if (innerWhere) {
    conditions.push(innerWhere);
  }
  const whereCondition = adapter.operators.and(...conditions);

  // Build ORDER BY
  const orderBySql = buildOrderBy(childCtx, orderBy, targetAlias);

  // Build FROM clause with both tables
  const fromClause = sql`${adapter.identifiers.table(junctionTableName, junctionAlias)}, ${adapter.identifiers.table(targetTableName, targetAlias)}`;

  // Build inner query
  const innerParts: Sql[] = [
    sql`SELECT ${jsonExpr}`,
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
  return adapter.subqueries.scalar(
    sql`SELECT ${adapter.json.agg(adapter.identifiers.escape(subAlias))} FROM (${innerQuery}) ${adapter.identifiers.escape(subAlias)}`,
  );
}
