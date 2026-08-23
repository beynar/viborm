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
import { createChildScope } from "../context";
import type { QueryScope, RelationRef } from "../types";
import {
  buildManyToManyInclude,
  buildManyToManyLateralInclude,
  buildSingularJunctionInclude,
} from "./include-many-to-many";
import { assembleInnerQuery, type IncludeOptions } from "./include-query";
import {
  buildNestedReadWindow,
  type NestedReadWindow,
} from "./nested-read-window";
import { buildRelationTraversal } from "./relation-traversal";
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
  relationRef: RelationRef,
  includeValue: Record<string, unknown>
): IncludeResult {
  // The one classification, which also spends this include's target (and, for a
  // junction, junction) alias — the dedicated junction builder takes it from here.
  const traversal = buildRelationTraversal(ctx, relationRef, ctx.rootAlias);
  if (traversal.kind === "junction") {
    // CARDINALITY BEFORE ROUTE. Every junction traversal used to go straight to
    // the to-many aggregation; a singular inverse over a collection member walks
    // the same junction and returns one row or null, and the to-one branches
    // below read `traversal.relation()`, which a junction traversal does not
    // expose. So the singular junction leaf is its own route, taken here.
    if (traversal.cardinality() === "one") {
      return {
        column: buildSingularJunctionInclude(
          buildNestedSelection,
          ctx,
          relationRef,
          includeValue,
          traversal
        ),
      };
    }
    return {
      column: buildManyToManyInclude(
        buildNestedSelection,
        ctx,
        relationRef,
        includeValue,
        traversal
      ),
    };
  }

  const { adapter } = ctx;
  const options = includeValue as IncludeOptions;
  const { select, include, where } = options;

  const relatedAlias = traversal.targetAlias;
  const childCtx = createChildScope(ctx, relationRef.targetModel, relatedAlias);

  // Build the JSON object for selected fields (using asJson: true)
  const jsonExpr = buildNestedSelection(childCtx, select, include).sql;

  // Correlation and FROM source, from the one traversal
  const baseConditions = traversal.conditions();
  const fromTable = traversal.from();

  if (traversal.relation().cardinality === "many") {
    const window = buildNestedReadWindow(
      childCtx,
      options,
      relatedAlias,
      baseConditions
    );
    return {
      column: buildToManySubquery(ctx, jsonExpr, fromTable, window),
    };
  }
  const conditions = [...baseConditions];
  const innerWhere = buildWhere(childCtx, where, relatedAlias);
  if (innerWhere) {
    conditions.push(innerWhere);
  }
  return {
    column: buildToOneSubquery(
      ctx,
      jsonExpr,
      fromTable,
      adapter.operators.and(...conditions)
    ),
  };
}

/**
 * Build include using LATERAL joins (PostgreSQL 9.3+, MySQL 8.0.14+)
 * More efficient than correlated subqueries.
 */
export function buildLateralInclude(
  buildNestedSelection: BuildNestedSelection,
  ctx: QueryScope,
  relationRef: RelationRef,
  includeValue: Record<string, unknown>
): IncludeResult {
  // The one classification, ahead of the lateral alias: the traversal's aliases
  // come first, exactly as the junction builder's prologue allocated them.
  const traversal = buildRelationTraversal(ctx, relationRef, ctx.rootAlias);
  if (traversal.kind === "junction") {
    if (traversal.cardinality() === "one") {
      return {
        column: buildSingularJunctionInclude(
          buildNestedSelection,
          ctx,
          relationRef,
          includeValue,
          traversal
        ),
      };
    }
    // A polymorphic MEMBER table takes the correlated route on every adapter,
    // matching the direct collection read (decision D3). Its integrity guard
    // wraps the projected value in the OUTER select, where the lateral form's
    // own aliases are already in scope — the two cannot share alias names, and
    // the correlated form has no such conflict because both subqueries are
    // siblings.
    if (traversal.membership().polymorphicMember) {
      return {
        column: buildManyToManyInclude(
          buildNestedSelection,
          ctx,
          relationRef,
          includeValue,
          traversal
        ),
      };
    }
    return buildManyToManyLateralInclude(
      buildNestedSelection,
      ctx,
      relationRef,
      includeValue,
      traversal
    );
  }

  const { adapter } = ctx;
  const options = includeValue as IncludeOptions;
  const { select, include, where } = options;

  const relatedAlias = traversal.targetAlias;
  const lateralAlias = ctx.nextAlias();
  const childCtx = createChildScope(ctx, relationRef.targetModel, relatedAlias);

  // Build the JSON object for selected fields AND collect nested lateral joins
  const selectResult = buildNestedSelection(childCtx, select, include);
  const jsonExpr = selectResult.sql;
  const nestedJoins = selectResult.lateralJoins;

  // Correlation and FROM source, from the one traversal
  const baseConditions = traversal.conditions();
  const fromTable = traversal.from();

  const resultColAlias = "_result";

  if (traversal.relation().cardinality === "many") {
    const window = buildNestedReadWindow(
      childCtx,
      options,
      relatedAlias,
      baseConditions
    );
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
  const conditions = [...baseConditions];
  const innerWhere = buildWhere(childCtx, where, relatedAlias);
  if (innerWhere) {
    conditions.push(innerWhere);
  }
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, resultColAlias);
  const lateralSubquery = assembleInnerQuery(adapter, {
    selectExpr: aliasedJsonExpr,
    from: fromTable,
    joins: nestedJoins,
    where: adapter.operators.and(...conditions),
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
