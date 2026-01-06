/**
 * Many-to-Many Junction Utilities
 *
 * Shared logic for building M2M join conditions.
 * Used by: select-builder, relation-filter-builder, include-builder
 */

import {
  getJunctionFieldNames,
  getJunctionTableName,
} from "@schema/relation/helpers";
import { type Sql, sql } from "@sql";
import { getTableName } from "../context";
import type { QueryContext, RelationInfo } from "../types";
import { getPrimaryKeyField } from "./correlation-utils";

/**
 * Junction table metadata for a many-to-many relation
 */
export interface ManyToManyJoinInfo {
  junctionTableName: string;
  sourceFieldName: string;
  targetFieldName: string;
  sourcePkField: string;
  targetPkField: string;
  targetTableName: string;
}

/**
 * Get junction table metadata for a many-to-many relation
 */
export function getManyToManyJoinInfo(
  ctx: QueryContext,
  relationInfo: RelationInfo
): ManyToManyJoinInfo {
  const sourceModelName = ctx.model["~"].names.ts ?? "unknown";
  const targetModelName = relationInfo.targetModel["~"].names.ts ?? "unknown";

  const junctionTableName = getJunctionTableName(
    relationInfo.relation,
    sourceModelName,
    targetModelName
  );
  const [sourceFieldName, targetFieldName] = getJunctionFieldNames(
    relationInfo.relation,
    sourceModelName,
    targetModelName
  );

  const sourcePkField = getPrimaryKeyField(ctx.model);
  const targetPkField = getPrimaryKeyField(relationInfo.targetModel);
  const targetTableName = getTableName(relationInfo.targetModel);

  return {
    junctionTableName,
    sourceFieldName,
    targetFieldName,
    sourcePkField,
    targetPkField,
    targetTableName,
  };
}

/**
 * Build the standard M2M join conditions
 *
 * @returns correlationCondition: jt.sourceId = parent.id
 * @returns joinCondition: target.id = jt.targetId
 * @returns fromClause: junction_table jt, target_table t
 */
export function buildManyToManyJoinParts(
  ctx: QueryContext,
  joinInfo: ManyToManyJoinInfo,
  parentAlias: string,
  junctionAlias: string,
  targetAlias: string
): {
  correlationCondition: Sql;
  joinCondition: Sql;
  fromClause: Sql;
} {
  const { adapter } = ctx;
  const {
    junctionTableName,
    sourceFieldName,
    targetFieldName,
    sourcePkField,
    targetPkField,
    targetTableName,
  } = joinInfo;

  // 1. Correlation: jt.sourceId = parent.id
  const junctionSourceCol = adapter.identifiers.column(
    junctionAlias,
    sourceFieldName
  );
  const parentPkCol = adapter.identifiers.column(parentAlias, sourcePkField);
  const correlationCondition = adapter.operators.eq(
    junctionSourceCol,
    parentPkCol
  );

  // 2. Join: target.id = jt.targetId
  const targetPkCol = adapter.identifiers.column(targetAlias, targetPkField);
  const junctionTargetCol = adapter.identifiers.column(
    junctionAlias,
    targetFieldName
  );
  const joinCondition = adapter.operators.eq(targetPkCol, junctionTargetCol);

  // 3. FROM clause
  const fromClause = sql`${adapter.identifiers.table(junctionTableName, junctionAlias)}, ${adapter.identifiers.table(targetTableName, targetAlias)}`;

  return { correlationCondition, joinCondition, fromClause };
}
