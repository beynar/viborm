import type { AnyDriver } from "@drivers";
import {
  getFkDirection,
  type NestedUpsertInput,
} from "../../builders/relation-data-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import type { TransactionContext } from "./create";
import {
  buildFkMatchCondition,
  combineWithParentCorrelation,
  connectCreatedRecordToCurrentParent,
} from "./fk";
import { fetchOptionalWhereRecord } from "./record-access";
import type { RelationMutationExecutors } from "./relation-mutation";

export async function executeRelationUpsert(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  upsertInput: NestedUpsertInput | NestedUpsertInput[],
  parentData: Record<string, unknown>,
  txCtx: TransactionContext,
  executors: RelationMutationExecutors
): Promise<void> {
  const inputs = normalizeNestedUpsertInputs(relationInfo, upsertInput);

  for (const input of inputs) {
    if (relationInfo.isToOne) {
      await executeToOneRelationUpsert(
        tx,
        ctx,
        relationInfo,
        input,
        parentData,
        txCtx,
        executors
      );
      continue;
    }

    await executeToManyRelationUpsert(
      tx,
      ctx,
      relationInfo,
      input,
      parentData,
      txCtx,
      executors
    );
  }
}

async function executeToOneRelationUpsert(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  input: NestedUpsertInput,
  parentData: Record<string, unknown>,
  txCtx: TransactionContext,
  executors: RelationMutationExecutors
): Promise<void> {
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const fkDir = getFkDirection(ctx, relationInfo);
  const currentTargetWhere = buildFkMatchCondition(
    ctx,
    fkDir,
    relationInfo.targetModel,
    parentData
  );
  const currentTarget = await fetchOptionalWhereRecord(
    tx,
    childCtx,
    relationInfo.targetModel,
    currentTargetWhere
  );

  if (currentTarget) {
    await executeUpsertUpdateBranch(
      tx,
      ctx,
      relationInfo,
      input.update,
      parentData,
      txCtx,
      executors
    );
    return;
  }

  const createdRecord = await executors.create(
    tx,
    ctx,
    relationInfo,
    input.create,
    fkDir.holdsFK ? "before" : "after",
    parentData
  );

  if (fkDir.holdsFK) {
    await connectCreatedRecordToCurrentParent(
      tx,
      ctx,
      relationInfo,
      createdRecord,
      parentData,
      "upsert"
    );
  }

  txCtx.createdRecords.set(relationInfo.name, createdRecord);
}

async function executeToManyRelationUpsert(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  input: NestedUpsertInput,
  parentData: Record<string, unknown>,
  txCtx: TransactionContext,
  executors: RelationMutationExecutors
): Promise<void> {
  if (!input.where) {
    throw new NestedWriteError(
      `Nested operation 'upsert' on to-many relation '${relationInfo.name}' requires 'where'.`,
      relationInfo.name,
      { meta: { operation: "upsert", field: "where" } }
    );
  }

  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const uniqueWhere = buildWhereUnique(childCtx, input.where, "");
  const fkDir = getFkDirection(ctx, relationInfo);
  const correlatedWhere = combineWithParentCorrelation(
    ctx,
    fkDir,
    relationInfo.targetModel,
    uniqueWhere,
    parentData
  );
  const correlatedRecord = await fetchOptionalWhereRecord(
    tx,
    childCtx,
    relationInfo.targetModel,
    correlatedWhere
  );

  if (correlatedRecord) {
    await executeUpsertUpdateBranch(
      tx,
      ctx,
      relationInfo,
      { where: input.where, data: input.update },
      parentData,
      txCtx,
      executors
    );
    return;
  }

  const existingUncorrelatedRecord = await fetchOptionalWhereRecord(
    tx,
    childCtx,
    relationInfo.targetModel,
    uniqueWhere
  );

  if (existingUncorrelatedRecord) {
    throw new NestedWriteError(
      `Cannot upsert relation '${relationInfo.name}': target record was not found for this parent.`,
      relationInfo.name,
      { meta: { operation: "upsert" } }
    );
  }

  await executors.create(
    tx,
    ctx,
    relationInfo,
    input.create,
    "after",
    parentData
  );
}

async function executeUpsertUpdateBranch(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  updateInput: Record<string, unknown>,
  parentData: Record<string, unknown>,
  txCtx: TransactionContext,
  executors: RelationMutationExecutors
): Promise<void> {
  if (!executors.update) {
    throw new NestedWriteError(
      `Nested operation 'upsert' on relation '${relationInfo.name}' cannot run in this mutation context.`,
      relationInfo.name,
      { meta: { operation: "upsert" } }
    );
  }

  await executors.update(
    tx,
    ctx,
    relationInfo,
    updateInput,
    parentData,
    txCtx,
    executors
  );
}

function normalizeNestedUpsertInputs(
  relationInfo: RelationInfo,
  input: NestedUpsertInput | NestedUpsertInput[]
): NestedUpsertInput[] {
  const inputs = Array.isArray(input) ? input : [input];
  if (relationInfo.isToOne && inputs.length > 1) {
    throw new NestedWriteError(
      `Cannot use multiple 'upsert' inputs for to-one relation '${relationInfo.name}'.`,
      relationInfo.name,
      { meta: { operation: "upsert" } }
    );
  }

  return inputs;
}
