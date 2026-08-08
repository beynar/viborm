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

import type { Sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import { createChildScope, getColumnName, getTableName } from "../context";
import { QueryEngineError, type QueryScope, type RelationInfo } from "../types";
import { buildCorrelation } from "./correlation-utils";
import {
  buildManyToManyJoinParts,
  getManyToManyJoinInfo,
} from "./many-to-many-utils";
import {
  hideMutationTarget,
  readsMutationTarget,
} from "./mutation-target-subquery";

export type BuildNestedWhere = (
  ctx: QueryScope,
  where: Record<string, unknown> | undefined
) => Sql | undefined;

/**
 * Build a relation filter (some, every, none, is, isNot)
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param filter - Filter object (may contain some/every/none or direct filter)
 * @returns SQL condition or undefined
 */
export function buildRelationFilterSql(
  buildNestedWhere: BuildNestedWhere,
  ctx: QueryScope,
  relationInfo: RelationInfo,
  filter: Record<string, unknown>
): Sql | undefined {
  const subqueries = new RelationFilterSubqueries(buildNestedWhere);
  // Schema validation normalizes { author: null } to { author: { is: null } }
  // So we never receive null directly here

  // Note: Schema validation may create objects with all keys present but undefined values.
  // We must check for !== undefined, not just "key in filter".

  // To-many relations use some/every/none (normalized by schema validation)
  if (relationInfo.isToMany) {
    const conditions: Sql[] = [];
    let hasOperator = false;

    if (filter.some !== undefined) {
      hasOperator = true;
      conditions.push(
        buildSomeFilter(
          subqueries,
          ctx,
          relationInfo,
          requireFilterObject(relationInfo, "some", filter.some)
        )
      );
    }
    if (filter.every !== undefined) {
      hasOperator = true;
      const condition = buildEveryFilter(
        subqueries,
        ctx,
        relationInfo,
        requireFilterObject(relationInfo, "every", filter.every)
      );
      if (condition) {
        conditions.push(condition);
      }
    }
    if (filter.none !== undefined) {
      hasOperator = true;
      conditions.push(
        buildNoneFilter(
          subqueries,
          ctx,
          relationInfo,
          requireFilterObject(relationInfo, "none", filter.none)
        )
      );
    }

    if (!hasOperator) {
      throw new QueryEngineError(
        `Relation filter '${relationInfo.name}' requires one of: some, every, none.`
      );
    }

    return ctx.adapter.operators.and(...conditions);
  }

  // To-one relations use is/isNot (normalized by schema validation)
  if (relationInfo.isToOne) {
    const conditions: Sql[] = [];
    let hasOperator = false;

    if (filter.is !== undefined) {
      hasOperator = true;
      const isValue = filter.is;
      if (isValue === null) {
        conditions.push(buildIsNullFilter(subqueries, ctx, relationInfo));
      } else {
        conditions.push(
          buildIsFilter(
            subqueries,
            ctx,
            relationInfo,
            requireFilterObject(relationInfo, "is", isValue)
          )
        );
      }
    }
    if (filter.isNot !== undefined) {
      hasOperator = true;
      const isNotValue = filter.isNot;
      if (isNotValue === null) {
        conditions.push(buildIsNotNullFilter(subqueries, ctx, relationInfo));
      } else {
        conditions.push(
          buildIsNotFilter(
            subqueries,
            ctx,
            relationInfo,
            requireFilterObject(relationInfo, "isNot", isNotValue)
          )
        );
      }
    }

    if (!hasOperator) {
      throw new QueryEngineError(
        `Relation filter '${relationInfo.name}' requires one of: is, isNot.`
      );
    }

    return ctx.adapter.operators.and(...conditions);
  }

  throw new QueryEngineError(
    `Unsupported relation filter '${relationInfo.name}'.`
  );
}

function requireFilterObject(
  relationInfo: RelationInfo,
  operator: string,
  value: unknown
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new QueryEngineError(
      `Relation filter '${relationInfo.name}.${operator}' requires an object.`
    );
  }
  return value;
}

/**
 * Build "some" filter: EXISTS (SELECT 1 FROM related WHERE correlation AND inner_where)
 */
function buildSomeFilter(
  subqueries: RelationFilterSubqueries,
  ctx: QueryScope,
  relationInfo: RelationInfo,
  innerWhere: Record<string, unknown> | undefined
): Sql {
  const subquery = subqueries.build(ctx, relationInfo, innerWhere, false);
  return ctx.adapter.filters.some(subquery);
}

/**
 * Build "every" filter: NOT EXISTS (SELECT 1 FROM related WHERE correlation AND NOT(inner_where))
 * This means: there's no related record that does NOT match the condition
 */
function buildEveryFilter(
  subqueries: RelationFilterSubqueries,
  ctx: QueryScope,
  relationInfo: RelationInfo,
  innerWhere: Record<string, unknown> | undefined
): Sql | undefined {
  const subquery = subqueries.build(ctx, relationInfo, innerWhere, true);
  if (!subquery) {
    return undefined;
  }
  return ctx.adapter.filters.every(subquery);
}

/**
 * Build "none" filter: NOT EXISTS (SELECT 1 FROM related WHERE correlation AND inner_where)
 */
function buildNoneFilter(
  subqueries: RelationFilterSubqueries,
  ctx: QueryScope,
  relationInfo: RelationInfo,
  innerWhere: Record<string, unknown> | undefined
): Sql {
  const subquery = subqueries.build(ctx, relationInfo, innerWhere, false);
  return ctx.adapter.filters.none(subquery);
}

/**
 * Build "is" filter (to-one): EXISTS (SELECT 1 FROM related WHERE correlation AND inner_where)
 */
function buildIsFilter(
  subqueries: RelationFilterSubqueries,
  ctx: QueryScope,
  relationInfo: RelationInfo,
  innerWhere: Record<string, unknown>
): Sql {
  const subquery = subqueries.build(ctx, relationInfo, innerWhere, false);
  return ctx.adapter.filters.is(subquery);
}

/**
 * Build "isNot" filter (to-one): NOT EXISTS (SELECT 1 FROM related WHERE correlation AND inner_where)
 */
function buildIsNotFilter(
  subqueries: RelationFilterSubqueries,
  ctx: QueryScope,
  relationInfo: RelationInfo,
  innerWhere: Record<string, unknown>
): Sql {
  const subquery = subqueries.build(ctx, relationInfo, innerWhere, false);
  return ctx.adapter.filters.isNot(subquery);
}

/**
 * Build FK column references for a to-one relation, mapped to actual column names.
 * Returns undefined when the relation does not hold the FK.
 */
function buildFkColumns(
  ctx: QueryScope,
  relationInfo: RelationInfo
): Sql[] | undefined {
  const fkFields = relationInfo.fields;
  if (!fkFields || fkFields.length === 0) {
    return undefined;
  }
  return fkFields.map((field) =>
    ctx.adapter.identifiers.column(
      ctx.rootAlias,
      getColumnName(ctx.model, field)
    )
  );
}

/**
 * Build "is null" filter for to-one: any FK column IS NULL.
 *
 * OR, not AND: a partially-null compound FK can never match a related row,
 * so Prisma treats it as relation-is-null. This is also the exact complement
 * of buildIsNotNullFilter's AND(IS NOT NULL).
 */
function buildIsNullFilter(
  subqueries: RelationFilterSubqueries,
  ctx: QueryScope,
  relationInfo: RelationInfo
): Sql {
  const fkColumns = buildFkColumns(ctx, relationInfo);
  if (fkColumns) {
    const conditions = fkColumns.map((column) =>
      ctx.adapter.operators.isNull(column)
    );
    return conditions.length === 1
      ? conditions[0]!
      : ctx.adapter.operators.or(...conditions);
  }

  // Fallback: NOT EXISTS subquery
  const subquery = subqueries.build(ctx, relationInfo, undefined, false);
  return ctx.adapter.operators.notExists(subquery);
}

/**
 * Build "is not null" filter for to-one: all FK columns IS NOT NULL
 */
function buildIsNotNullFilter(
  subqueries: RelationFilterSubqueries,
  ctx: QueryScope,
  relationInfo: RelationInfo
): Sql {
  const fkColumns = buildFkColumns(ctx, relationInfo);
  if (fkColumns) {
    const conditions = fkColumns.map((column) =>
      ctx.adapter.operators.isNotNull(column)
    );
    return conditions.length === 1
      ? conditions[0]!
      : ctx.adapter.operators.and(...conditions);
  }

  // Fallback: EXISTS subquery
  const subquery = subqueries.build(ctx, relationInfo, undefined, false);
  return ctx.adapter.operators.exists(subquery);
}

/**
 * Build a correlated subquery for relation filters
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param innerWhere - Inner where conditions (optional)
 * @param negateInner - Whether to negate the inner where (for "every")
 */
class RelationFilterSubqueries {
  private readonly buildNestedWhere: BuildNestedWhere;

  constructor(buildNestedWhere: BuildNestedWhere) {
    this.buildNestedWhere = buildNestedWhere;
  }

  build(
    ctx: QueryScope,
    relationInfo: RelationInfo,
    innerWhere: Record<string, unknown> | undefined,
    negateInner: false
  ): Sql;
  build(
    ctx: QueryScope,
    relationInfo: RelationInfo,
    innerWhere: Record<string, unknown> | undefined,
    negateInner: true
  ): Sql | undefined;
  build(
    ctx: QueryScope,
    relationInfo: RelationInfo,
    innerWhere: Record<string, unknown> | undefined,
    negateInner: boolean
  ): Sql | undefined {
    const { adapter } = ctx;

    // Handle manyToMany specially - requires junction table
    if (relationInfo.type === "manyToMany") {
      return this.buildManyToMany(ctx, relationInfo, innerWhere, negateInner);
    }

    const relatedAlias = ctx.nextAlias();

    // Build inner where condition
    const childCtx = createChildScope(
      ctx,
      relationInfo.targetModel,
      relatedAlias
    );
    let innerCondition = this.buildNestedWhere(childCtx, innerWhere);

    // Negate inner condition for "every" filter
    if (negateInner) {
      if (!innerCondition) {
        return undefined;
      }
      innerCondition = adapter.operators.not(innerCondition);
    }

    const relatedTableName = getTableName(relationInfo.targetModel);

    // Build correlation condition (throws if fields/references not defined)
    const correlation = buildCorrelation(
      ctx,
      relationInfo,
      ctx.rootAlias,
      relatedAlias
    );

    // Combine correlation and inner condition
    const conditions: Sql[] = [correlation];
    if (innerCondition) {
      conditions.push(innerCondition);
    }

    const whereClause = adapter.operators.and(...conditions);

    // Build the subquery: SELECT 1 FROM related WHERE ...
    const subquery = adapter.subqueries.existsCheck(
      adapter.identifiers.table(relatedTableName, relatedAlias),
      whereClause
    );
    return this.wrapMutationTarget(ctx, subquery, [relatedTableName]);
  }

  /**
   * Hide a relation-filter subquery that selects from the table currently being
   * mutated behind a derived table (MySQL error 1093). The rule and the wrap live
   * in {@link file://../builders/mutation-target-subquery.ts}, which the to-one
   * `connect` lookup in an UPDATE's `SET` shares — the subquery already sits
   * inside an `EXISTS (…)` here, so no parentheses are added.
   */
  private wrapMutationTarget(
    ctx: QueryScope,
    subquery: Sql,
    tables: string[]
  ): Sql {
    return readsMutationTarget(ctx, tables)
      ? hideMutationTarget(ctx, subquery)
      : subquery;
  }

  /**
   * Build a correlated subquery for manyToMany relation filters.
   *
   * SQL pattern:
   * SELECT 1 FROM junction_table jt, target_table t
   * WHERE jt.sourceId = parent.id AND t.id = jt.targetId AND [inner conditions on t]
   */
  private buildManyToMany(
    ctx: QueryScope,
    relationInfo: RelationInfo,
    innerWhere: Record<string, unknown> | undefined,
    negateInner: boolean
  ): Sql | undefined {
    const { adapter } = ctx;

    const junctionAlias = ctx.nextAlias();
    const targetAlias = ctx.nextAlias();

    // Build inner where on target
    const childCtx = createChildScope(
      ctx,
      relationInfo.targetModel,
      targetAlias
    );
    let innerCondition = this.buildNestedWhere(childCtx, innerWhere);

    // Negate inner condition for "every" filter
    if (negateInner) {
      if (!innerCondition) {
        return undefined;
      }
      innerCondition = adapter.operators.not(innerCondition);
    }

    const joinInfo = getManyToManyJoinInfo(ctx, relationInfo);
    const { correlationCondition, joinCondition, fromClause } =
      buildManyToManyJoinParts(
        ctx,
        joinInfo,
        ctx.rootAlias,
        junctionAlias,
        targetAlias
      );

    const conditions: Sql[] = [correlationCondition, joinCondition];
    if (innerCondition) {
      conditions.push(innerCondition);
    }

    const whereClause = adapter.operators.and(...conditions);

    const subquery = adapter.subqueries.existsCheck(fromClause, whereClause);
    return this.wrapMutationTarget(ctx, subquery, [
      joinInfo.junctionTableName,
      joinInfo.targetTableName,
    ]);
  }
}
