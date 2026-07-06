import type { AnyDriver } from "@drivers";
import type { Sql } from "@sql";
import { getPrimaryKeyField } from "../../builders/correlation-utils";
import {
  getFkDirection,
  type NestedUpdateInput,
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import { buildSet } from "../../builders/set-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext, getTableName } from "../../context";
import type { QueryContext, RelationInfo } from "../../types";
import { getUpdatedPrimaryKeyWhere } from "../mutation-returns";
import { runNestedMutationAtomically } from "./atomic-runner";
import {
  executeRelationCreate,
  executeRelationCreateMany,
  type TransactionContext,
} from "./create";
import { executeRelationDeleteMany } from "./delete-many";
import { buildFkMatchCondition, combineWithParentCorrelation } from "./fk";
import {
  fetchRequiredUniqueRecord,
  fetchRequiredWhereRecord,
  recordNotFoundError,
} from "./record-access";
import { processRelationMutation } from "./relation-mutation";
import { executeRelationUpdateMany } from "./update-many";
import {
  assertNestedUpdatePlanIsExecutable,
  normalizeNestedUpdateInputs,
} from "./update-plan";

export interface NestedUpdateResult {
  record: Record<string, unknown>;
  related: Record<string, Record<string, unknown> | Record<string, unknown>[]>;
}

export async function executeNestedUpdate(
  driver: AnyDriver,
  ctx: QueryContext,
  parentRecord: Record<string, unknown>,
  relations: Record<string, RelationMutation>
): Promise<NestedUpdateResult> {
  if (Object.keys(relations).length === 0) {
    return { record: parentRecord, related: {} };
  }

  assertNestedUpdatePlanIsExecutable(ctx, relations);

  return runNestedMutationAtomically(driver, "update", async (txDriver) => {
    const txCtx: TransactionContext = {
      generatedIds: new Map(),
      createdRecords: new Map(),
    };

    const parentPk = getPrimaryKeyField(ctx.model);
    const parentId = parentRecord[parentPk];
    txCtx.generatedIds.set("__parent__", parentId);

    for (const [relationName, mutation] of Object.entries(relations)) {
      await processRelationMutation(
        txDriver,
        ctx,
        relationName,
        mutation,
        "after",
        parentRecord,
        txCtx,
        {
          create: executeRelationCreate,
          createMany: executeRelationCreateMany,
          update: executeRelationUpdate,
          updateMany: executeRelationUpdateMany,
          deleteMany: executeRelationDeleteMany,
        }
      );
    }

    const related: Record<
      string,
      Record<string, unknown> | Record<string, unknown>[]
    > = {};
    for (const [name] of Object.entries(relations)) {
      const created = txCtx.createdRecords.get(name);
      if (created) {
        related[name] = created;
      }
    }

    return { record: parentRecord, related };
  });
}

export async function executeRelationUpdate(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  updateInput:
    | Record<string, unknown>
    | NestedUpdateInput
    | NestedUpdateInput[],
  parentData: Record<string, unknown>,
  _txCtx: TransactionContext
): Promise<void> {
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const fkDir = getFkDirection(ctx, relationInfo);

  if (relationInfo.isToOne) {
    await executeSingleRelationUpdate(
      tx,
      childCtx,
      relationInfo,
      updateInput as Record<string, unknown>,
      buildFkMatchCondition(ctx, fkDir, relationInfo.targetModel, parentData)
    );
    return;
  }

  for (const input of normalizeNestedUpdateInputs(updateInput)) {
    const whereClause = combineWithParentCorrelation(
      ctx,
      fkDir,
      relationInfo.targetModel,
      buildWhereUnique(
        childCtx,
        input.where,
        getTableName(relationInfo.targetModel)
      ),
      parentData
    );

    await executeSingleRelationUpdate(
      tx,
      childCtx,
      relationInfo,
      input.data,
      whereClause
    );
  }
}

export async function executeSingleRelationUpdate(
  tx: AnyDriver,
  childCtx: QueryContext,
  relationInfo: RelationInfo,
  data: Record<string, unknown>,
  whereClause: Sql
): Promise<void> {
  const { scalarData, relations } = separateData(childCtx, data);
  assertNestedUpdatePlanIsExecutable(childCtx, relations);

  const beforeRecord = await fetchRequiredWhereRecord(
    tx,
    childCtx,
    relationInfo.targetModel,
    whereClause,
    { relationName: relationInfo.name, operation: "update", kind: "correlated" }
  );
  const refetchWhere = getUpdatedPrimaryKeyWhere(
    childCtx,
    beforeRecord,
    scalarData,
    getTableName(relationInfo.targetModel)
  );

  if (Object.keys(scalarData).length > 0) {
    const table = childCtx.adapter.identifiers.escape(
      getTableName(relationInfo.targetModel)
    );
    const setSql = buildSet(childCtx, scalarData);
    const updateSql = childCtx.adapter.mutations.update(
      table,
      setSql,
      whereClause
    );
    const result = await tx._execute(updateSql);

    if (result.rowCount === 0) {
      throw recordNotFoundError({
        relationName: relationInfo.name,
        operation: "update",
        kind: "correlated",
      });
    }
  }

  if (Object.keys(relations).length === 0) {
    return;
  }

  const updatedRecord = await fetchRequiredUniqueRecord(
    tx,
    childCtx,
    relationInfo.targetModel,
    refetchWhere,
    { relationName: relationInfo.name, operation: "update", kind: "correlated" }
  );

  await executeNestedUpdate(tx, childCtx, updatedRecord, relations);
}
