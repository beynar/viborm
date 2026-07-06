import type { AnyDriver } from "@drivers";
import type { Sql } from "@sql";
import {
  getFkDirection,
  type NestedUpdateManyInput,
  separateData,
} from "../../builders/relation-data-builder";
import { buildSet } from "../../builders/set-builder";
import { buildWhere } from "../../builders/where-builder";
import { createChildContext, getTableName } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import { buildFkMatchCondition } from "./fk";
import {
  assertUpdateManyDataHasNoRelations,
  normalizeNestedUpdateManyInputs,
} from "./update-plan";

export async function executeRelationUpdateMany(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  updateManyInput: NestedUpdateManyInput | NestedUpdateManyInput[],
  parentData: Record<string, unknown>
): Promise<void> {
  if (relationInfo.isToOne) {
    throw new NestedWriteError(
      `Nested operation 'updateMany' is not supported for to-one relation '${relationInfo.name}'.`,
      relationInfo.name,
      { meta: { operation: "updateMany" } }
    );
  }

  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const table = ctx.adapter.identifiers.escape(
    getTableName(relationInfo.targetModel)
  );

  for (const input of normalizeNestedUpdateManyInputs(updateManyInput)) {
    const { scalarData, relations } = separateData(childCtx, input.data);
    assertUpdateManyDataHasNoRelations(relationInfo.name, relations);

    const setSql = buildSet(childCtx, scalarData);
    const whereClause = buildUpdateManyWhere(
      ctx,
      childCtx,
      relationInfo,
      input,
      parentData
    );
    const updateSql = ctx.adapter.mutations.update(table, setSql, whereClause);
    await tx._execute(updateSql);
  }
}

function buildUpdateManyWhere(
  ctx: QueryContext,
  childCtx: QueryContext,
  relationInfo: RelationInfo,
  input: NestedUpdateManyInput,
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
    input.where,
    targetTable
  );

  return childWhere
    ? ctx.adapter.operators.and(parentWhere, childWhere)
    : parentWhere;
}
