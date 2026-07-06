import type { AnyDriver } from "@drivers";
import type {
  CreateManyInput,
  NestedUpdateInput,
  NestedUpdateManyInput,
  NestedUpsertInput,
  RelationMutation,
} from "../../builders/relation-data-builder";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import { executeRelationConnect } from "./connect";
import { executeConnectOrCreate } from "./connect-or-create";
import type { TransactionContext } from "./create";
import { executeRelationDelete } from "./delete";
import { executeRelationDeleteMany } from "./delete-many";
import { executeRelationDisconnect } from "./disconnect";
import { processManyToManyMutation } from "./many-to-many";
import {
  type NestedWriteTiming,
  planRelationMutationSteps,
} from "./semantic-plan";
import { executeRelationSet } from "./set";
import { executeRelationUpsert } from "./upsert";

export interface RelationMutationExecutors {
  create: (
    tx: AnyDriver,
    ctx: QueryContext,
    relationInfo: RelationInfo,
    createData: Record<string, unknown>,
    timing: NestedWriteTiming,
    parentData: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  createMany: (
    tx: AnyDriver,
    ctx: QueryContext,
    relationInfo: RelationInfo,
    createManyInput: CreateManyInput,
    parentData: Record<string, unknown>
  ) => Promise<Record<string, unknown>[]>;
  update?: (
    tx: AnyDriver,
    ctx: QueryContext,
    relationInfo: RelationInfo,
    updateInput:
      | Record<string, unknown>
      | NestedUpdateInput
      | NestedUpdateInput[],
    parentData: Record<string, unknown>,
    txCtx: TransactionContext,
    executors: RelationMutationExecutors
  ) => Promise<void>;
  updateMany?: (
    tx: AnyDriver,
    ctx: QueryContext,
    relationInfo: RelationInfo,
    updateManyInput: NestedUpdateManyInput | NestedUpdateManyInput[],
    parentData: Record<string, unknown>
  ) => Promise<void>;
  deleteMany?: (
    tx: AnyDriver,
    ctx: QueryContext,
    relationInfo: RelationInfo,
    deleteManyInput: Record<string, unknown> | Record<string, unknown>[],
    parentData: Record<string, unknown>
  ) => Promise<void>;
  upsert?: (
    tx: AnyDriver,
    ctx: QueryContext,
    relationInfo: RelationInfo,
    upsertInput: NestedUpsertInput | NestedUpsertInput[],
    parentData: Record<string, unknown>,
    txCtx: TransactionContext,
    executors: RelationMutationExecutors
  ) => Promise<void>;
}

export async function processRelationMutation(
  tx: AnyDriver,
  ctx: QueryContext,
  relationName: string,
  mutation: RelationMutation,
  timing: NestedWriteTiming,
  parentData: Record<string, unknown>,
  txCtx: TransactionContext,
  executors: RelationMutationExecutors
): Promise<void> {
  if (mutation.relationInfo.type === "manyToMany") {
    await processManyToManyMutation(
      tx,
      ctx,
      relationName,
      mutation,
      timing,
      parentData,
      txCtx
    );
    return;
  }

  for (const step of planRelationMutationSteps(
    relationName,
    mutation,
    timing
  )) {
    const { relationInfo } = step.context;

    switch (step.kind) {
      case "create": {
        const createdRecords: Record<string, unknown>[] = [];
        for (const createData of step.inputs) {
          const record = await executors.create(
            tx,
            ctx,
            relationInfo,
            createData,
            timing,
            parentData
          );
          createdRecords.push(record);
        }
        setCreatedRecords(
          txCtx,
          relationName,
          relationInfo.isToMany,
          createdRecords
        );
        break;
      }

      case "createMany": {
        if (timing !== "after") break;
        const createdRecords = await executors.createMany(
          tx,
          ctx,
          relationInfo,
          step.input,
          parentData
        );
        appendCreatedRecords(txCtx, relationName, createdRecords);
        break;
      }

      case "connect": {
        if (timing !== "after") break;
        for (const connectInput of step.inputs) {
          await executeRelationConnect(
            tx,
            ctx,
            relationInfo,
            connectInput,
            parentData,
            txCtx
          );
        }
        break;
      }

      case "connectOrCreate": {
        const records: Record<string, unknown>[] = [];
        for (const connectOrCreate of step.inputs) {
          const record = await executeConnectOrCreate(
            tx,
            ctx,
            relationInfo,
            connectOrCreate,
            timing,
            parentData,
            txCtx,
            executors.create
          );
          if (record) records.push(record);
        }
        appendCreatedRecords(
          txCtx,
          relationName,
          records,
          relationInfo.isToMany
        );
        break;
      }

      case "disconnect":
        if (timing === "after") {
          await executeRelationDisconnect(
            tx,
            ctx,
            relationInfo,
            step.input,
            parentData
          );
        }
        break;

      case "delete":
        if (timing === "after") {
          await executeRelationDelete(
            tx,
            ctx,
            relationInfo,
            step.input,
            parentData
          );
        }
        break;

      case "set":
        if (timing === "after") {
          await executeRelationSet(
            tx,
            ctx,
            relationInfo,
            step.input,
            parentData
          );
        }
        break;

      case "update":
        if (timing === "after") {
          assertExecutor(relationName, "update", executors.update);
          await executors.update(
            tx,
            ctx,
            relationInfo,
            step.input,
            parentData,
            txCtx,
            executors
          );
        }
        break;

      case "updateMany":
        if (timing === "after") {
          assertExecutor(relationName, "updateMany", executors.updateMany);
          await executors.updateMany(
            tx,
            ctx,
            relationInfo,
            step.input,
            parentData
          );
        }
        break;

      case "deleteMany":
        if (timing === "after") {
          const deleteMany = executors.deleteMany ?? executeRelationDeleteMany;
          await deleteMany(tx, ctx, relationInfo, step.input, parentData);
        }
        break;

      case "upsert":
        if (timing === "after") {
          const upsert = executors.upsert ?? executeRelationUpsert;
          await upsert(
            tx,
            ctx,
            relationInfo,
            step.input,
            parentData,
            txCtx,
            executors
          );
        }
        break;
    }
  }
}

function setCreatedRecords(
  txCtx: TransactionContext,
  relationName: string,
  isToMany: boolean,
  records: Record<string, unknown>[]
): void {
  if (!records.length) return;
  txCtx.createdRecords.set(relationName, isToMany ? records : records[0]!);
}

function appendCreatedRecords(
  txCtx: TransactionContext,
  relationName: string,
  records: Record<string, unknown>[],
  isToMany = true
): void {
  if (!records.length) return;
  if (!isToMany) {
    txCtx.createdRecords.set(relationName, records[0]!);
    return;
  }
  const existing = txCtx.createdRecords.get(relationName);
  txCtx.createdRecords.set(
    relationName,
    Array.isArray(existing) ? [...existing, ...records] : records
  );
}

function assertExecutor<T>(
  relationName: string,
  operation: string,
  executor: T | undefined
): asserts executor is T {
  if (executor) return;
  throw new NestedWriteError(
    `Nested operation '${operation}' on relation '${relationName}' cannot run in this mutation context.`,
    relationName,
    { meta: { operation } }
  );
}
