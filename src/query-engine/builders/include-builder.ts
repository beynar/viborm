/**
 * Include Builder
 *
 * Builds nested relation subqueries with JSON aggregation.
 * Supports two strategies:
 * - Correlated subqueries (works on all databases)
 * - LATERAL joins (PostgreSQL 9.3+, MySQL 8.0.14+) - more efficient
 *
 * The strategy is chosen based on adapter.capabilities.supportsLateralJoins
 */

import { type Sql, sql } from "@sql";
import { createChildScope, getTableName } from "../context";
import type { QueryScope, RelationInfo } from "../types";
import { buildCorrelation } from "./correlation-utils";
import {
  buildManyToManyInclude,
  buildManyToManyLateralInclude,
} from "./include-many-to-many";
import { assembleInnerQuery, type IncludeOptions } from "./include-query";
import {
  buildNestedReadWindow,
  type NestedReadWindow,
} from "./nested-read-window";
import { buildWhere } from "./where-builder";

export { assembleInnerQuery } from "./include-query";

// =============================================================================
// SHARED HELPERS (DRY)
// =============================================================================

/**
 * Result of building an include.
 *
 * For correlated subqueries:
 * - column: The scalar subquery expression
 * - lateralJoin: undefined
 *
 * For lateral joins:
 * - column: Reference to the column in the lateral alias (e.g., "t1"."posts")
 * - lateralJoin: The JOIN LATERAL clause to add to the query
 */
export interface IncludeResult {
  /** The SQL expression to use in the SELECT clause */
  column: Sql;
  /** Optional lateral join clause to add to the FROM clause */
  lateralJoin?: Sql;
}

export interface NestedSelectionResult {
  sql: Sql;
  lateralJoins: Sql[];
}

export type BuildNestedSelection = (
  ctx: QueryScope,
  select: Record<string, unknown> | undefined,
  include: Record<string, unknown> | undefined
) => NestedSelectionResult;

export type IncludeStrategy = "auto" | "subquery" | "lateral";

export interface BuildIncludeOptions {
  /**
   * Strategy to use for building the include.
   *
   * - auto: Use LATERAL when adapter supports it, otherwise correlated subquery
   * - subquery: Always use correlated subquery (safe in any expression context)
   * - lateral: Prefer LATERAL when supported, otherwise fall back to subquery
   */
  strategy?: IncludeStrategy;
}

/**
 * Build include using correlated subquery (original approach)
 * Works on all databases including SQLite.
 */
export function buildSubqueryInclude(
  buildNestedSelection: BuildNestedSelection,
  ctx: QueryScope,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>
): IncludeResult {
  // Handle manyToMany specially - requires junction table
  if (relationInfo.type === "manyToMany") {
    return {
      column: buildManyToManyInclude(
        buildNestedSelection,
        ctx,
        relationInfo,
        includeValue
      ),
    };
  }

  const { adapter } = ctx;
  const options = includeValue as IncludeOptions;
  const { select, include, where } = options;

  const relatedAlias = ctx.nextAlias();
  const childCtx = createChildScope(
    ctx,
    relationInfo.targetModel,
    relatedAlias
  );

  // Build the JSON object for selected fields (using asJson: true)
  const jsonExpr = buildNestedSelection(childCtx, select, include).sql;

  // Build WHERE with correlation
  const correlation = buildCorrelation(
    ctx,
    relationInfo,
    ctx.rootAlias,
    relatedAlias
  );

  // Build FROM table
  const relatedTableName = getTableName(relationInfo.targetModel);
  const fromTable = adapter.identifiers.table(relatedTableName, relatedAlias);

  if (relationInfo.isToMany) {
    const window = buildNestedReadWindow(childCtx, options, relatedAlias, [
      correlation,
    ]);
    return {
      column: buildToManySubquery(ctx, jsonExpr, fromTable, window),
    };
  }
  const innerWhere = buildWhere(childCtx, where, relatedAlias);
  const whereCondition = innerWhere
    ? adapter.operators.and(correlation, innerWhere)
    : correlation;
  return {
    column: buildToOneSubquery(ctx, jsonExpr, fromTable, whereCondition),
  };
}

/**
 * Build include using LATERAL joins (PostgreSQL 9.3+, MySQL 8.0.14+)
 * More efficient than correlated subqueries.
 */
export function buildLateralInclude(
  buildNestedSelection: BuildNestedSelection,
  ctx: QueryScope,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>
): IncludeResult {
  // Handle manyToMany via dedicated lateral builder
  if (relationInfo.type === "manyToMany") {
    return buildManyToManyLateralInclude(
      buildNestedSelection,
      ctx,
      relationInfo,
      includeValue
    );
  }

  const { adapter } = ctx;
  const options = includeValue as IncludeOptions;
  const { select, include, where } = options;

  const relatedAlias = ctx.nextAlias();
  const lateralAlias = ctx.nextAlias();
  const childCtx = createChildScope(
    ctx,
    relationInfo.targetModel,
    relatedAlias
  );

  // Build the JSON object for selected fields AND collect nested lateral joins
  const selectResult = buildNestedSelection(childCtx, select, include);
  const jsonExpr = selectResult.sql;
  const nestedJoins = selectResult.lateralJoins;

  // Build WHERE with correlation
  const correlation = buildCorrelation(
    ctx,
    relationInfo,
    ctx.rootAlias,
    relatedAlias
  );

  // Build FROM table
  const relatedTableName = getTableName(relationInfo.targetModel);
  const fromTable = adapter.identifiers.table(relatedTableName, relatedAlias);

  const resultColAlias = "_result";

  if (relationInfo.isToMany) {
    const window = buildNestedReadWindow(childCtx, options, relatedAlias, [
      correlation,
    ]);
    const innerJoins = [...nestedJoins, ...window.joins];

    // To-many: build lateral subquery with JSON aggregation
    const jsonColAlias = "_json";
    const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

    // Build inner query using shared helper
    const innerQuery = assembleInnerQuery(adapter, {
      selectExpr: aliasedJsonExpr,
      from: fromTable,
      joins: innerJoins,
      where: window.where,
      orderBy: window.orderBy,
      take: window.limit,
      skip: window.offset,
      distinct: window.distinct,
      distinctColumnAliases: [jsonColAlias],
    });

    // Build the lateral subquery that aggregates to JSON array
    const innerAlias = ctx.nextAlias();
    const jsonColumn = adapter.identifiers.column(innerAlias, jsonColAlias);
    const aggExpr = adapter.json.agg(jsonColumn);
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
    const lateralJoin = adapter.joins.lateralLeft(
      lateralSubquery,
      lateralAlias
    );
    const column = adapter.identifiers.column(lateralAlias, resultColAlias);

    return { column, lateralJoin };
  }

  // To-one: build lateral subquery returning single JSON object or null
  const innerWhere = buildWhere(childCtx, where, relatedAlias);
  const whereCondition = innerWhere
    ? adapter.operators.and(correlation, innerWhere)
    : correlation;
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, resultColAlias);
  const lateralSubquery = assembleInnerQuery(adapter, {
    selectExpr: aliasedJsonExpr,
    from: fromTable,
    joins: nestedJoins,
    where: whereCondition,
    take: 1, // LIMIT 1 for to-one
  });

  const lateralJoin = adapter.joins.lateralLeft(lateralSubquery, lateralAlias);
  const column = adapter.identifiers.column(lateralAlias, resultColAlias);

  return { column, lateralJoin };
}

/**
 * Build to-many relation subquery with JSON aggregation
 */
function buildToManySubquery(
  ctx: QueryScope,
  jsonExpr: Sql,
  fromTable: Sql,
  window: NestedReadWindow
): Sql {
  const { adapter } = ctx;

  const jsonColAlias = "_json";
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

  // Build inner query using shared helper
  const innerQuery = assembleInnerQuery(adapter, {
    selectExpr: aliasedJsonExpr,
    from: fromTable,
    joins: window.joins,
    where: window.where,
    orderBy: window.orderBy,
    take: window.limit,
    skip: window.offset,
    distinct: window.distinct,
    distinctColumnAliases: [jsonColAlias],
  });

  // Wrap with aggregation: SELECT COALESCE(json_agg(subAlias._json), '[]') FROM (innerQuery) subAlias
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

/**
 * Build to-one relation subquery returning JSON object or null
 */
function buildToOneSubquery(
  ctx: QueryScope,
  jsonExpr: Sql,
  fromTable: Sql,
  where: Sql
): Sql {
  const { adapter } = ctx;

  // Build query using shared helper with LIMIT 1
  const query = assembleInnerQuery(adapter, {
    selectExpr: jsonExpr,
    from: fromTable,
    where,
    take: 1, // LIMIT 1
  });

  return adapter.subqueries.scalar(query);
}
