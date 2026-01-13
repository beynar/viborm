/**
 * Relation Filter Builder
 *
 * Builds EXISTS/NOT EXISTS subqueries for relation filters:
 * - some: EXISTS (any matching record)
 * - every: NOT EXISTS with negated condition (all must match)
 * - none: NOT EXISTS (no matching record)
 * - is: EXISTS for to-one (record matches)
 * - isNot: NOT EXISTS for to-one (record doesn't match)
 */

import { type Sql, sql } from "@sql";
import { createChildContext, getTableName } from "../context";
import type { QueryContext, RelationInfo } from "../types";
import { buildCorrelation } from "./correlation-utils";
import {
  buildManyToManyJoinParts,
  getManyToManyJoinInfo,
} from "./many-to-many-utils";
import { buildWhere } from "./where-builder";

/**
 * Build a relation filter (some, every, none, is, isNot)
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param filter - Filter object (may contain some/every/none or direct filter)
 * @param parentAlias - Parent table alias for correlation
 * @returns SQL condition or undefined
 */
export function buildRelationFilter(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  filter: Record<string, unknown>,
  parentAlias: string
): Sql | undefined {
  // Schema validation normalizes { author: null } to { author: { is: null } }
  // So we never receive null directly here

  // Note: Schema validation may create objects with all keys present but undefined values.
  // We must check for !== undefined, not just "key in filter".

  // To-many relations use some/every/none (normalized by schema validation)
  if (relationInfo.isToMany) {
    if (filter.some !== undefined) {
      return buildSomeFilter(
        ctx,
        relationInfo,
        filter.some as Record<string, unknown>,
        parentAlias
      );
    }
    if (filter.every !== undefined) {
      return buildEveryFilter(
        ctx,
        relationInfo,
        filter.every as Record<string, unknown>,
        parentAlias
      );
    }
    if (filter.none !== undefined) {
      return buildNoneFilter(
        ctx,
        relationInfo,
        filter.none as Record<string, unknown>,
        parentAlias
      );
    }
    // No fallback - schema validation guarantees explicit form
    return undefined;
  }

  // To-one relations use is/isNot (normalized by schema validation)
  if (relationInfo.isToOne) {
    if (filter.is !== undefined) {
      const isValue = filter.is;
      if (isValue === null) {
        return buildIsNullFilter(ctx, relationInfo, parentAlias);
      }
      return buildIsFilter(
        ctx,
        relationInfo,
        isValue as Record<string, unknown>,
        parentAlias
      );
    }
    if (filter.isNot !== undefined) {
      const isNotValue = filter.isNot;
      if (isNotValue === null) {
        return buildIsNotNullFilter(ctx, relationInfo, parentAlias);
      }
      return buildIsNotFilter(
        ctx,
        relationInfo,
        isNotValue as Record<string, unknown>,
        parentAlias
      );
    }
    // No fallback - schema validation guarantees explicit form
  }

  return undefined;
}

/**
 * Build "some" filter: EXISTS (SELECT 1 FROM related WHERE correlation AND inner_where)
 */
function buildSomeFilter(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  innerWhere: Record<string, unknown> | undefined,
  parentAlias: string
): Sql {
  const subquery = buildCorrelatedSubquery(
    ctx,
    relationInfo,
    innerWhere,
    parentAlias,
    false
  );
  return ctx.adapter.filters.some(subquery);
}

/**
 * Build "every" filter: NOT EXISTS (SELECT 1 FROM related WHERE correlation AND NOT(inner_where))
 * This means: there's no related record that does NOT match the condition
 */
function buildEveryFilter(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  innerWhere: Record<string, unknown> | undefined,
  parentAlias: string
): Sql {
  const subquery = buildCorrelatedSubquery(
    ctx,
    relationInfo,
    innerWhere,
    parentAlias,
    true
  );
  return ctx.adapter.filters.every(subquery);
}

/**
 * Build "none" filter: NOT EXISTS (SELECT 1 FROM related WHERE correlation AND inner_where)
 */
function buildNoneFilter(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  innerWhere: Record<string, unknown> | undefined,
  parentAlias: string
): Sql {
  const subquery = buildCorrelatedSubquery(
    ctx,
    relationInfo,
    innerWhere,
    parentAlias,
    false
  );
  return ctx.adapter.filters.none(subquery);
}

/**
 * Build "is" filter (to-one): EXISTS (SELECT 1 FROM related WHERE correlation AND inner_where)
 */
function buildIsFilter(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  innerWhere: Record<string, unknown>,
  parentAlias: string
): Sql {
  const subquery = buildCorrelatedSubquery(
    ctx,
    relationInfo,
    innerWhere,
    parentAlias,
    false
  );
  return ctx.adapter.filters.is(subquery);
}

/**
 * Build "isNot" filter (to-one): NOT EXISTS (SELECT 1 FROM related WHERE correlation AND inner_where)
 */
function buildIsNotFilter(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  innerWhere: Record<string, unknown>,
  parentAlias: string
): Sql {
  const subquery = buildCorrelatedSubquery(
    ctx,
    relationInfo,
    innerWhere,
    parentAlias,
    false
  );
  return ctx.adapter.filters.isNot(subquery);
}

/**
 * Build "is null" filter for to-one: FK IS NULL
 */
function buildIsNullFilter(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  parentAlias: string
): Sql {
  // For to-one relations, check if the FK field is null
  const fkField = relationInfo.fields?.[0];
  if (fkField) {
    const column = ctx.adapter.identifiers.column(parentAlias, fkField);
    return ctx.adapter.operators.isNull(column);
  }

  // Fallback: NOT EXISTS subquery
  const subquery = buildCorrelatedSubquery(
    ctx,
    relationInfo,
    undefined,
    parentAlias,
    false
  );
  return ctx.adapter.operators.notExists(subquery);
}

/**
 * Build "is not null" filter for to-one: FK IS NOT NULL
 */
function buildIsNotNullFilter(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  parentAlias: string
): Sql {
  // For to-one relations, check if the FK field is not null
  const fkField = relationInfo.fields?.[0];
  if (fkField) {
    const column = ctx.adapter.identifiers.column(parentAlias, fkField);
    return ctx.adapter.operators.isNotNull(column);
  }

  // Fallback: EXISTS subquery
  const subquery = buildCorrelatedSubquery(
    ctx,
    relationInfo,
    undefined,
    parentAlias,
    false
  );
  return ctx.adapter.operators.exists(subquery);
}

/**
 * Build a correlated subquery for relation filters
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param innerWhere - Inner where conditions (optional)
 * @param parentAlias - Parent table alias
 * @param negateInner - Whether to negate the inner where (for "every")
 */
function buildCorrelatedSubquery(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  innerWhere: Record<string, unknown> | undefined,
  parentAlias: string,
  negateInner: boolean
): Sql {
  const { adapter } = ctx;

  // Handle manyToMany specially - requires junction table
  if (relationInfo.type === "manyToMany") {
    return buildManyToManySubquery(
      ctx,
      relationInfo,
      innerWhere,
      parentAlias,
      negateInner
    );
  }

  const relatedAlias = ctx.nextAlias();
  const relatedTableName = getTableName(relationInfo.targetModel);

  // Build correlation condition (throws if fields/references not defined)
  const correlation = buildCorrelation(
    ctx,
    relationInfo,
    parentAlias,
    relatedAlias
  );

  // Build inner where condition
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    relatedAlias
  );
  let innerCondition = buildWhere(childCtx, innerWhere, relatedAlias);

  // Negate inner condition for "every" filter
  if (negateInner && innerCondition) {
    innerCondition = adapter.operators.not(innerCondition);
  }

  // Combine correlation and inner condition
  const conditions: Sql[] = [correlation];
  if (innerCondition) {
    conditions.push(innerCondition);
  }

  const whereClause = adapter.operators.and(...conditions);

  // Build the subquery: SELECT 1 FROM related WHERE ...
  return adapter.subqueries.existsCheck(
    adapter.identifiers.table(relatedTableName, relatedAlias),
    whereClause
  );
}

/**
 * Build a correlated subquery for manyToMany relation filters.
 *
 * SQL pattern:
 * SELECT 1 FROM junction_table jt, target_table t
 * WHERE jt.sourceId = parent.id AND t.id = jt.targetId AND [inner conditions on t]
 */
function buildManyToManySubquery(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  innerWhere: Record<string, unknown> | undefined,
  parentAlias: string,
  negateInner: boolean
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

  // Build inner where on target
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    targetAlias
  );
  let innerCondition = buildWhere(childCtx, innerWhere, targetAlias);

  // Negate inner condition for "every" filter
  if (negateInner && innerCondition) {
    innerCondition = adapter.operators.not(innerCondition);
  }

  const conditions: Sql[] = [correlationCondition, joinCondition];
  if (innerCondition) {
    conditions.push(innerCondition);
  }

  const whereClause = adapter.operators.and(...conditions);

  return adapter.subqueries.existsCheck(fromClause, whereClause);
}
