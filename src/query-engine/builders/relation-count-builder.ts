/**
 * Relation Count Builder
 *
 * Builds correlated COUNT subqueries for relation projections and ordering.
 */

import { type Sql, sql } from "@sql";
import { createChildScope, getTableName } from "../context";
import { QueryEngineError, type QueryScope, type RelationInfo } from "../types";
import { buildCorrelation } from "./correlation-utils";
import {
  buildManyToManyJoinParts,
  getManyToManyJoinInfo,
} from "./many-to-many-utils";
import { buildWhere } from "./where-builder";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const getWhereConfig = (
  config: unknown
): Record<string, unknown> | undefined => {
  if (!(isRecord(config) && "where" in config)) {
    return undefined;
  }

  if (!isRecord(config.where)) {
    throw new QueryEngineError("Relation count where clause must be an object");
  }

  return config.where;
};

/**
 * Build a COUNT subquery for a relation.
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param config - true or { where: ... }
 * @param parentAlias - Parent table alias
 * @returns SQL for COUNT subquery
 */
export function buildRelationCount(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  config: unknown,
  parentAlias: string
): Sql {
  if (relationInfo.type === "manyToMany") {
    return buildManyToManyCount(ctx, relationInfo, config, parentAlias);
  }

  const { adapter } = ctx;
  const targetAlias = ctx.nextAlias();
  const targetTableName = getTableName(relationInfo.targetModel);
  const targetTable = adapter.identifiers.table(targetTableName, targetAlias);
  const correlation = buildCorrelation(
    ctx,
    relationInfo,
    parentAlias,
    targetAlias
  );

  let whereCondition = correlation;

  const rawWhere = getWhereConfig(config);
  if (rawWhere) {
    const childCtx = createChildScope(
      ctx,
      relationInfo.targetModel,
      targetAlias
    );
    const innerWhere = buildWhere(childCtx, rawWhere, targetAlias);
    if (innerWhere) {
      whereCondition = adapter.operators.and(correlation, innerWhere);
    }
  }

  return adapter.subqueries.scalar(
    sql.join(
      [
        adapter.clauses.select(adapter.aggregates.count()),
        adapter.clauses.from(targetTable),
        adapter.clauses.where(whereCondition),
      ],
      " "
    )
  );
}

function buildManyToManyCount(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  config: unknown,
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

  const conditions: Sql[] = [correlationCondition, joinCondition];

  const rawWhere = getWhereConfig(config);
  if (rawWhere) {
    const childCtx = createChildScope(
      ctx,
      relationInfo.targetModel,
      targetAlias
    );
    const innerWhere = buildWhere(childCtx, rawWhere, targetAlias);
    if (innerWhere) {
      conditions.push(innerWhere);
    }
  }

  const whereCondition = adapter.operators.and(...conditions);

  return adapter.subqueries.scalar(
    sql.join(
      [
        adapter.clauses.select(adapter.aggregates.count()),
        adapter.clauses.from(fromClause),
        adapter.clauses.where(whereCondition),
      ],
      " "
    )
  );
}
