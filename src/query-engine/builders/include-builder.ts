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

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { type Sql, sql } from "@sql";
import { createChildContext, getTableName } from "../context";
import type { QueryContext, RelationInfo } from "../types";
import { buildCorrelation } from "./correlation-utils";
import {
  buildManyToManyJoinParts,
  getManyToManyJoinInfo,
} from "./many-to-many-utils";
import { buildOrderBy } from "./orderby-builder";
import { buildSelect, buildSelectWithAliases } from "./select-builder";
import { buildWhere } from "./where-builder";

// =============================================================================
// SHARED HELPERS (DRY)
// =============================================================================

/** Include options type for inline destructuring */
type IncludeOptions = {
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown> | Record<string, unknown>[];
  take?: number;
  skip?: number;
};

/**
 * Assemble a standard inner query:
 * SELECT selectExpr FROM from [joins...] WHERE where [ORDER BY orderBy] [LIMIT take] [OFFSET skip]
 *
 * @internal Exported for testing
 */
export function assembleInnerQuery(
  adapter: DatabaseAdapter,
  selectExpr: Sql,
  from: Sql,
  joins: Sql[] | undefined,
  where: Sql,
  orderBy: Sql | undefined,
  take: number | undefined,
  skip: number | undefined
): Sql {
  const parts: Sql[] = [
    adapter.clauses.select(selectExpr),
    adapter.clauses.from(from),
  ];

  if (joins && joins.length > 0) {
    parts.push(...joins);
  }

  parts.push(adapter.clauses.where(where));

  if (orderBy) {
    parts.push(adapter.clauses.orderBy(orderBy));
  }

  if (take !== undefined) {
    parts.push(adapter.clauses.limit(adapter.literals.value(take)));
  }

  if (skip !== undefined) {
    parts.push(adapter.clauses.offset(adapter.literals.value(skip)));
  }

  return sql.join(parts, " ");
}

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
 * Build an include (relation subquery with JSON aggregation)
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param includeValue - Include options (select, include, where, orderBy, take, skip)
 * @param parentAlias - Parent table alias
 * @param options - Include build options
 * @returns IncludeResult with column expression and optional lateral join
 */
export function buildInclude(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>,
  parentAlias: string,
  options: BuildIncludeOptions = {}
): IncludeResult {
  const requestedStrategy: IncludeStrategy = options.strategy ?? "auto";

  // Safety guard: empty parent alias is used in expression-only contexts like
  // INSERT/UPDATE/DELETE RETURNING. Those contexts cannot attach JOINs, so any
  // include must be built as a scalar subquery.
  if (parentAlias === "") {
    return buildSubqueryInclude(ctx, relationInfo, includeValue, parentAlias);
  }

  if (requestedStrategy === "subquery") {
    return buildSubqueryInclude(ctx, relationInfo, includeValue, parentAlias);
  }

  const canUseLateral = ctx.adapter.capabilities.supportsLateralJoins;
  if (canUseLateral) {
    return buildLateralInclude(ctx, relationInfo, includeValue, parentAlias);
  }

  // Fallback to correlated subquery approach
  return buildSubqueryInclude(ctx, relationInfo, includeValue, parentAlias);
}

/**
 * Build include using correlated subquery (original approach)
 * Works on all databases including SQLite.
 */
function buildSubqueryInclude(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>,
  parentAlias: string
): IncludeResult {
  // Handle manyToMany specially - requires junction table
  if (relationInfo.type === "manyToMany") {
    return {
      column: buildManyToManyInclude(
        ctx,
        relationInfo,
        includeValue,
        parentAlias
      ),
    };
  }

  const { adapter } = ctx;
  const { select, include, where, orderBy, take, skip } =
    includeValue as IncludeOptions;

  const relatedAlias = ctx.nextAlias();
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    relatedAlias
  );

  // Build the JSON object for selected fields (using asJson: true)
  const jsonExpr = buildSelect(childCtx, select, include, relatedAlias, {
    asJson: true,
  });

  // Build WHERE with correlation
  const correlation = buildCorrelation(
    ctx,
    relationInfo,
    parentAlias,
    relatedAlias
  );
  const innerWhere = buildWhere(childCtx, where, relatedAlias);
  const whereCondition = innerWhere
    ? adapter.operators.and(correlation, innerWhere)
    : correlation;

  // Build ORDER BY
  const orderBySql = buildOrderBy(childCtx, orderBy, relatedAlias);

  // Build FROM table
  const relatedTableName = getTableName(relationInfo.targetModel);
  const fromTable = adapter.identifiers.table(relatedTableName, relatedAlias);

  if (relationInfo.isToMany) {
    return {
      column: buildToManySubquery(
        ctx,
        jsonExpr,
        fromTable,
        whereCondition,
        orderBySql,
        take,
        skip,
        undefined
      ),
    };
  }
  return {
    column: buildToOneSubquery(
      ctx,
      jsonExpr,
      fromTable,
      whereCondition,
      undefined
    ),
  };
}

/**
 * Build include using LATERAL joins (PostgreSQL 9.3+, MySQL 8.0.14+)
 * More efficient than correlated subqueries.
 */
function buildLateralInclude(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>,
  parentAlias: string
): IncludeResult {
  // Handle manyToMany via dedicated lateral builder
  if (relationInfo.type === "manyToMany") {
    return buildManyToManyLateralInclude(
      ctx,
      relationInfo,
      includeValue,
      parentAlias
    );
  }

  const { adapter } = ctx;
  const { select, include, where, orderBy, take, skip } =
    includeValue as IncludeOptions;

  const relatedAlias = ctx.nextAlias();
  const lateralAlias = ctx.nextAlias();
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    relatedAlias
  );

  // Build the JSON object for selected fields AND collect nested lateral joins
  const selectResult = buildSelectWithAliases(
    childCtx,
    select,
    include,
    relatedAlias,
    { asJson: true }
  );
  const jsonExpr = selectResult.sql;
  const nestedJoins = selectResult.lateralJoins;

  // Build WHERE with correlation
  const correlation = buildCorrelation(
    ctx,
    relationInfo,
    parentAlias,
    relatedAlias
  );
  const innerWhere = buildWhere(childCtx, where, relatedAlias);
  const whereCondition = innerWhere
    ? adapter.operators.and(correlation, innerWhere)
    : correlation;

  // Build ORDER BY
  const orderBySql = buildOrderBy(childCtx, orderBy, relatedAlias);

  // Build FROM table
  const relatedTableName = getTableName(relationInfo.targetModel);
  const fromTable = adapter.identifiers.table(relatedTableName, relatedAlias);

  const resultColAlias = "_result";

  if (relationInfo.isToMany) {
    // To-many: build lateral subquery with JSON aggregation
    const jsonColAlias = "_json";
    const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

    // Build inner query using shared helper
    const innerQuery = assembleInnerQuery(
      adapter,
      aliasedJsonExpr,
      fromTable,
      nestedJoins.length > 0 ? nestedJoins : undefined,
      whereCondition,
      orderBySql,
      take,
      skip
    );

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
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, resultColAlias);
  const lateralSubquery = assembleInnerQuery(
    adapter,
    aliasedJsonExpr,
    fromTable,
    nestedJoins.length > 0 ? nestedJoins : undefined,
    whereCondition,
    undefined,
    1, // LIMIT 1 for to-one
    undefined
  );

  const lateralJoin = adapter.joins.lateralLeft(lateralSubquery, lateralAlias);
  const column = adapter.identifiers.column(lateralAlias, resultColAlias);

  return { column, lateralJoin };
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
  joins: Sql[] | undefined
): Sql {
  const { adapter } = ctx;

  const jsonColAlias = "_json";
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

  // Build inner query using shared helper
  const innerQuery = assembleInnerQuery(
    adapter,
    aliasedJsonExpr,
    fromTable,
    joins,
    where,
    orderBy,
    take,
    skip
  );

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
  ctx: QueryContext,
  jsonExpr: Sql,
  fromTable: Sql,
  where: Sql,
  joins: Sql[] | undefined
): Sql {
  const { adapter } = ctx;

  // Build query using shared helper with LIMIT 1
  const query = assembleInnerQuery(
    adapter,
    jsonExpr,
    fromTable,
    joins,
    where,
    undefined, // no ORDER BY
    1, // LIMIT 1
    undefined // no OFFSET
  );

  return adapter.subqueries.scalar(query);
}

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
function buildManyToManyLateralInclude(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>,
  parentAlias: string
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

  // Build JSON expression and collect nested lateral joins
  const selectResult = buildSelectWithAliases(
    childCtx,
    select,
    include,
    targetAlias,
    { asJson: true }
  );
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

  // Build ORDER BY
  const orderBySql = buildOrderBy(childCtx, orderBy, targetAlias);

  // Build inner query using shared helper
  const jsonColAlias = "_json";
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

  const innerQuery = assembleInnerQuery(
    adapter,
    aliasedJsonExpr,
    fromClause,
    nestedJoins.length > 0 ? nestedJoins : undefined,
    whereCondition,
    orderBySql,
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
function buildManyToManyInclude(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>,
  parentAlias: string
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

  // Build inner query using shared helper
  const jsonColAlias = "_json";
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

  const innerQuery = assembleInnerQuery(
    adapter,
    aliasedJsonExpr,
    fromClause,
    undefined, // no joins for subquery variant
    whereCondition,
    orderBySql,
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
