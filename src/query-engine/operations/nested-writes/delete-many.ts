import type { AnyDriver } from "@drivers";
import type { Sql } from "@sql";
import { getFkDirection } from "../../builders/relation-data-builder";
import { buildWhere } from "../../builders/where-builder";
import { createChildContext, getTableName } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import { buildFkMatchCondition } from "./fk";

export async function executeRelationDeleteMany(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  deleteManyInput: Record<string, unknown> | Record<string, unknown>[],
  parentData: Record<string, unknown>
): Promise<void> {
  if (relationInfo.isToOne) {
    throw new NestedWriteError(
      `Nested operation 'deleteMany' is not supported for to-one relation '${relationInfo.name}'.`,
      relationInfo.name,
      { meta: { operation: "deleteMany" } }
    );
  }

  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const tableName = getTableName(relationInfo.targetModel);
  const table = ctx.adapter.identifiers.escape(tableName);
  const inputs = Array.isArray(deleteManyInput)
    ? deleteManyInput
    : [deleteManyInput];

  for (const input of inputs) {
    const whereClause = buildDeleteManyWhere(
      ctx,
      childCtx,
      relationInfo,
      input,
      parentData
    );
    const deleteSql = ctx.adapter.mutations.delete(table, whereClause);
    await tx._execute(deleteSql);
  }
}

function buildDeleteManyWhere(
  ctx: QueryContext,
  childCtx: QueryContext,
  relationInfo: RelationInfo,
  where: Record<string, unknown>,
  parentData: Record<string, unknown>
): Sql {
  const fkDir = getFkDirection(ctx, relationInfo);
  const parentWhere = buildFkMatchCondition(
    ctx,
    fkDir,
    relationInfo.targetModel,
    parentData
  );
  const targetTable = getTableName(relationInfo.targetModel);
  const childWhere = buildWhere(
    { ...childCtx, mutationTable: targetTable },
    where,
    targetTable
  );

  return childWhere
    ? ctx.adapter.operators.and(parentWhere, childWhere)
    : parentWhere;
}
