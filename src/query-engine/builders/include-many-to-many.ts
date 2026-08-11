import { type Sql, sql } from "@sql";
import { createChildScope } from "../context";
import type { QueryScope, RelationInfo } from "../types";
import type { BuildNestedSelection, IncludeResult } from "./include-builder";
import { assembleInnerQuery, type IncludeOptions } from "./include-query";
import { buildNestedReadWindow } from "./nested-read-window";
import type { JunctionRelationTraversal } from "./relation-traversal";

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
  includeValue: Record<string, unknown>,
  traversal: JunctionRelationTraversal
): IncludeResult {
  const { adapter } = ctx;
  const options = includeValue as IncludeOptions;
  const { select, include } = options;

  // The junction and target aliases are the traversal's; the lateral wrap is this
  // builder's own and follows them.
  const { targetAlias } = traversal;
  const lateralAlias = ctx.nextAlias();

  const baseConditions = traversal.conditions();
  const fromClause = traversal.from();

  // Create child context for target
  const childCtx = createChildScope(ctx, relationInfo.targetModel, targetAlias);

  // Build JSON expression and collect nested lateral joins
  const selectResult = buildNestedSelection(childCtx, select, include);
  const jsonExpr = selectResult.sql;
  const nestedJoins = selectResult.lateralJoins;

  // Correlation, junction join, relation filter, cursor and window in one place
  const window = buildNestedReadWindow(
    childCtx,
    options,
    targetAlias,
    baseConditions
  );
  const innerJoins = [...nestedJoins, ...window.joins];

  // Build inner query using shared helper
  const jsonColAlias = "_json";
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

  const innerQuery = assembleInnerQuery(adapter, {
    selectExpr: aliasedJsonExpr,
    from: fromClause,
    joins: innerJoins,
    where: window.where,
    orderBy: window.orderBy,
    take: window.limit,
    skip: window.offset,
    distinct: window.distinct,
    distinctColumnAliases: [jsonColAlias],
  });

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
  includeValue: Record<string, unknown>,
  traversal: JunctionRelationTraversal
): Sql {
  const { adapter } = ctx;
  const options = includeValue as IncludeOptions;
  const { select, include } = options;

  const { targetAlias } = traversal;
  const baseConditions = traversal.conditions();
  const fromClause = traversal.from();

  // Create child context for target
  const childCtx = createChildScope(ctx, relationInfo.targetModel, targetAlias);

  // Build the JSON object for selected fields
  const jsonExpr = buildNestedSelection(childCtx, select, include).sql;

  // Correlation, junction join, relation filter, cursor and window in one place
  const window = buildNestedReadWindow(
    childCtx,
    options,
    targetAlias,
    baseConditions
  );

  // Build inner query using shared helper
  const jsonColAlias = "_json";
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

  const innerQuery = assembleInnerQuery(adapter, {
    selectExpr: aliasedJsonExpr,
    from: fromClause,
    joins: window.joins,
    where: window.where,
    orderBy: window.orderBy,
    take: window.limit,
    skip: window.offset,
    distinct: window.distinct,
    distinctColumnAliases: [jsonColAlias],
  });

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
