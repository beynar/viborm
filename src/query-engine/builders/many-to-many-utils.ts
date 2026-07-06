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
import { createChildContext, getColumnName, getTableName } from "../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../types";
import { getRequiredSinglePrimaryKeyField } from "./correlation-utils";
import { buildScalarSqlValue } from "./values-builder";
import { buildWhereUnique } from "./where-unique-builder";

/**
 * Junction table metadata for a many-to-many relation
 */
export interface ManyToManyJoinInfo {
  junctionTableName: string;
  sourceFieldName: string;
  targetFieldName: string;
  /** PK field name (TS) on the source model */
  sourcePkField: string;
  /** PK field name (TS) on the target model */
  targetPkField: string;
  /** Actual PK column name (post-.map()) on the source model */
  sourcePkColumn: string;
  /** Actual PK column name (post-.map()) on the target model */
  targetPkColumn: string;
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

  const sourcePkField = getRequiredSinglePrimaryKeyField(ctx.model);
  const targetPkField = getRequiredSinglePrimaryKeyField(
    relationInfo.targetModel
  );
  const sourcePkColumn = getColumnName(ctx.model, sourcePkField);
  const targetPkColumn = getColumnName(relationInfo.targetModel, targetPkField);
  const targetTableName = getTableName(relationInfo.targetModel);

  return {
    junctionTableName,
    sourceFieldName,
    targetFieldName,
    sourcePkField,
    targetPkField,
    sourcePkColumn,
    targetPkColumn,
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
    sourcePkColumn,
    targetPkColumn,
    targetTableName,
  } = joinInfo;

  // 1. Correlation: jt.sourceId = parent.id
  const junctionSourceCol = adapter.identifiers.column(
    junctionAlias,
    sourceFieldName
  );
  const parentPkCol = adapter.identifiers.column(parentAlias, sourcePkColumn);
  const correlationCondition = adapter.operators.eq(
    junctionSourceCol,
    parentPkCol
  );

  // 2. Join: target.id = jt.targetId
  const targetPkCol = adapter.identifiers.column(targetAlias, targetPkColumn);
  const junctionTargetCol = adapter.identifiers.column(
    junctionAlias,
    targetFieldName
  );
  const joinCondition = adapter.operators.eq(targetPkCol, junctionTargetCol);

  // 3. FROM clause
  const fromClause = sql`${adapter.identifiers.table(junctionTableName, junctionAlias)}, ${adapter.identifiers.table(targetTableName, targetAlias)}`;

  return { correlationCondition, joinCondition, fromClause };
}

// ============================================================
// JUNCTION WRITE BUILDERS
// Shared by the transaction and batch nested-write engines.
// ============================================================

/**
 * Resolve the parent's PK value (typed by the parent PK scalar) for junction
 * row writes. Parent rows come either as input data (TS field keys) or raw
 * driver rows (column keys), and in the batch engine the value may be a
 * batch reference — buildScalarSqlValue lowers all of these.
 */
export function buildJunctionParentValue(
  ctx: QueryContext,
  joinInfo: ManyToManyJoinInfo,
  parentData: Record<string, unknown>,
  relationName: string
): Sql {
  const raw =
    parentData[joinInfo.sourcePkField] ?? parentData[joinInfo.sourcePkColumn];
  if (raw === undefined || raw === null) {
    throw new NestedWriteError(
      `Cannot write many-to-many relation '${relationName}': parent record is missing primary key field '${joinInfo.sourcePkField}'.`,
      relationName
    );
  }
  return buildScalarSqlValue(ctx, ctx.model, joinInfo.sourcePkField, raw);
}

/**
 * Resolve a target record's PK value for junction row writes.
 */
export function buildJunctionTargetValue(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  targetRecord: Record<string, unknown>,
  relationName: string
): Sql {
  const raw =
    targetRecord[joinInfo.targetPkField] ??
    targetRecord[joinInfo.targetPkColumn];
  if (raw === undefined || raw === null) {
    throw new NestedWriteError(
      `Cannot write many-to-many relation '${relationName}': target record is missing primary key field '${joinInfo.targetPkField}'.`,
      relationName
    );
  }
  return buildScalarSqlValue(
    ctx,
    relationInfo.targetModel,
    joinInfo.targetPkField,
    raw
  );
}

/**
 * INSERT a junction row, ignoring duplicates (connect is idempotent — the
 * junction PK (source, target) makes a repeat connect a no-op conflict).
 */
export function buildJunctionInsert(
  ctx: QueryContext,
  joinInfo: ManyToManyJoinInfo,
  parentValue: Sql,
  targetValue: Sql
): Sql {
  const { adapter } = ctx;
  const table = adapter.identifiers.escape(joinInfo.junctionTableName);
  const { prefix, suffix } = adapter.mutations.skipDuplicates();
  const insertSql = adapter.mutations.insert(
    table,
    [joinInfo.sourceFieldName, joinInfo.targetFieldName],
    [[parentValue, targetValue]],
    prefix
  );
  return sql`${insertSql} ${suffix}`;
}

/** Condition: junction.source = parentValue (unqualified, for junction DML). */
export function buildJunctionSourceMatch(
  ctx: QueryContext,
  joinInfo: ManyToManyJoinInfo,
  parentValue: Sql
): Sql {
  return ctx.adapter.operators.eq(
    ctx.adapter.identifiers.escape(joinInfo.sourceFieldName),
    parentValue
  );
}

/** Condition: junction.target IN (values | subquery) (for junction DML). */
export function buildJunctionTargetIn(
  ctx: QueryContext,
  joinInfo: ManyToManyJoinInfo,
  targetValues: Sql
): Sql {
  return ctx.adapter.operators.in(
    ctx.adapter.identifiers.escape(joinInfo.targetFieldName),
    targetValues
  );
}

/**
 * Scalar subquery resolving a target row's PK from a where-unique input:
 * (SELECT target.pk FROM target WHERE <unique>)
 */
export function buildTargetPkSubquery(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  whereUnique: Record<string, unknown>
): Sql {
  const { adapter } = ctx;
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const whereClause = buildWhereUnique(
    childCtx,
    whereUnique,
    joinInfo.targetTableName
  );
  const pkCol = adapter.identifiers.column(
    joinInfo.targetTableName,
    joinInfo.targetPkColumn
  );
  return sql`(SELECT ${pkCol} FROM ${adapter.identifiers.escape(joinInfo.targetTableName)} WHERE ${whereClause})`;
}

/**
 * Condition on the target table: row is connected to the parent through the
 * junction: target.pk IN (SELECT junction.target FROM junction WHERE source = parent)
 */
export function buildJunctionMembership(
  ctx: QueryContext,
  joinInfo: ManyToManyJoinInfo,
  parentValue: Sql,
  targetTableOrAlias: string
): Sql {
  const { adapter } = ctx;
  const childPkCol = adapter.identifiers.column(
    targetTableOrAlias,
    joinInfo.targetPkColumn
  );
  const targetCol = adapter.identifiers.escape(joinInfo.targetFieldName);
  const junctionTable = adapter.identifiers.escape(joinInfo.junctionTableName);
  const sourceMatch = buildJunctionSourceMatch(ctx, joinInfo, parentValue);
  return sql`${childPkCol} IN (SELECT ${targetCol} FROM ${junctionTable} WHERE ${sourceMatch})`;
}

/**
 * Where-unique on the target table, additionally scoped to rows connected to
 * this parent through the junction (unique ∧ membership). The correlated
 * predicate the m2m update/upsert interpreter matches a connected child by.
 */
export function buildConnectedUniqueWhere(
  ctx: QueryContext,
  childCtx: QueryContext,
  joinInfo: ManyToManyJoinInfo,
  parentValue: Sql,
  whereUnique: Record<string, unknown>
): Sql {
  return ctx.adapter.operators.and(
    buildWhereUnique(childCtx, whereUnique, joinInfo.targetTableName),
    buildJunctionMembership(
      ctx,
      joinInfo,
      parentValue,
      joinInfo.targetTableName
    )
  );
}

/**
 * Junction rows referencing the given target PKs — from any parent, and on
 * self-referential relations also rows where the target is the SOURCE. Used to
 * delete every junction row pointing at a child that is being deleted so the
 * child DELETE cannot trip an FK constraint (§9 m2m delete/deleteMany).
 */
export function buildJunctionDeleteCondition(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  targetPks: Sql
): Sql {
  const condition = buildJunctionTargetIn(ctx, joinInfo, targetPks);
  if (relationInfo.targetModel !== ctx.model) {
    return condition;
  }
  return ctx.adapter.operators.or(
    condition,
    ctx.adapter.operators.in(
      ctx.adapter.identifiers.escape(joinInfo.sourceFieldName),
      targetPks
    )
  );
}
