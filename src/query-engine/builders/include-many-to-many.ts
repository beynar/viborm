import { type Sql, sql } from "@sql";
import { createChildScope } from "../context";
import type { QueryScope, RelationInfo } from "../types";
import type { BuildNestedSelection, IncludeResult } from "./include-builder";
import { assembleInnerQuery, type IncludeOptions } from "./include-query";
import {
  buildManyToManyJoinParts,
  getManyToManyJoinInfo,
} from "./many-to-many-utils";
import { buildOrderByParts } from "./orderby-builder";
import { buildWhere } from "./where-builder";

/**
 * Build include for manyToMany relation using LATERAL join.
 *
 * Strategy:
 * LEFT JOIN LATERAL (
 *   SELECT json_agg(inner._json) AS _result
 *   FROM (
 *     SELECT json_expr AS _json
 *     FROM junction jt, target t [nestedJoins...]
 *     WHERE correlation AND join AND [innerWhere]
 *     [ORDER/LIMIT/OFFSET]
 *   ) inner
 * ) lateralAlias ON TRUE
 */
export function buildManyToManyLateralInclude(
  buildNestedSelection: BuildNestedSelection,
  ctx: QueryScope,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>
): IncludeResult {
  const { adapter } = ctx;
  const { select, include, where, orderBy, take, skip } =
    includeValue as IncludeOptions;

  const junctionAlias = ctx.nextAlias();
  const targetAlias = ctx.nextAlias();
  const lateralAlias = ctx.nextAlias();

  const joinInfo = getManyToManyJoinInfo(ctx, relationInfo);
  const { correlationCondition, joinCondition, fromClause } =
    buildManyToManyJoinParts(
      ctx,
      joinInfo,
      ctx.rootAlias,
      junctionAlias,
      targetAlias
    );

  // Create child context for target
  const childCtx = createChildScope(ctx, relationInfo.targetModel, targetAlias);

  // Build JSON expression and collect nested lateral joins
  const selectResult = buildNestedSelection(childCtx, select, include);
  const jsonExpr = selectResult.sql;
  const nestedJoins = selectResult.lateralJoins;

  // Build inner where on target
  const innerWhere = buildWhere(childCtx, where, targetAlias);

  // Combine conditions
  const conditions: Sql[] = [correlationCondition, joinCondition];
  if (innerWhere) {
    conditions.push(innerWhere);
  }
  const whereCondition = adapter.operators.and(...conditions);

  const orderByParts = buildOrderByParts(childCtx, orderBy, targetAlias);
  const innerJoins = [...nestedJoins, ...orderByParts.joins];

  // Build inner query using shared helper
  const jsonColAlias = "_json";
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

  const innerQuery = assembleInnerQuery(
    adapter,
    aliasedJsonExpr,
    fromClause,
    innerJoins.length > 0 ? innerJoins : undefined,
    whereCondition,
    orderByParts.orderBy,
    take,
    skip
  );

  // Wrap with aggregation inside the lateral subquery
  const innerAlias = ctx.nextAlias();
  const jsonColumn = adapter.identifiers.column(innerAlias, jsonColAlias);
  const aggExpr = adapter.json.agg(jsonColumn);
  const resultColAlias = "_result";
  const aliasedAggExpr = adapter.identifiers.aliased(aggExpr, resultColAlias);

  const lateralSubquery = sql.join(
    [
      adapter.clauses.select(aliasedAggExpr),
      adapter.clauses.from(
        sql`(${innerQuery}) ${adapter.identifiers.escape(innerAlias)}`
      ),
    ],
    " "
  );
  const lateralJoin = adapter.joins.lateralLeft(lateralSubquery, lateralAlias);
  const column = adapter.identifiers.column(lateralAlias, resultColAlias);

  return { column, lateralJoin };
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
export function buildManyToManyInclude(
  buildNestedSelection: BuildNestedSelection,
  ctx: QueryScope,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>
): Sql {
  const { adapter } = ctx;
  const { select, include, where, orderBy, take, skip } =
    includeValue as IncludeOptions;

  const junctionAlias = ctx.nextAlias();
  const targetAlias = ctx.nextAlias();

  const joinInfo = getManyToManyJoinInfo(ctx, relationInfo);
  const { correlationCondition, joinCondition, fromClause } =
    buildManyToManyJoinParts(
      ctx,
      joinInfo,
      ctx.rootAlias,
      junctionAlias,
      targetAlias
    );

  // Create child context for target
  const childCtx = createChildScope(ctx, relationInfo.targetModel, targetAlias);

  // Build the JSON object for selected fields
  const jsonExpr = buildNestedSelection(childCtx, select, include).sql;

  // Build inner where on target
  const innerWhere = buildWhere(childCtx, where, targetAlias);

  // Combine conditions
  const conditions: Sql[] = [correlationCondition, joinCondition];
  if (innerWhere) {
    conditions.push(innerWhere);
  }
  const whereCondition = adapter.operators.and(...conditions);

  const orderByParts = buildOrderByParts(childCtx, orderBy, targetAlias);

  // Build inner query using shared helper
  const jsonColAlias = "_json";
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

  const innerQuery = assembleInnerQuery(
    adapter,
    aliasedJsonExpr,
    fromClause,
    orderByParts.joins.length > 0 ? orderByParts.joins : undefined,
    whereCondition,
    orderByParts.orderBy,
    take,
    skip
  );

  // Wrap with aggregation
  const subAlias = ctx.nextAlias();
  const jsonColumn = adapter.identifiers.column(subAlias, jsonColAlias);
  return adapter.subqueries.scalar(
    sql.join(
      [
        adapter.clauses.select(adapter.json.agg(jsonColumn)),
        adapter.clauses.from(
          sql`(${innerQuery}) ${adapter.identifiers.escape(subAlias)}`
        ),
      ],
      " "
    )
  );
}
