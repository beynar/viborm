import type { AnyDriver } from "@drivers";
import type { QueryResult } from "@drivers/types";
import type { Model } from "@schema/model";
import { isSql, type Sql } from "@sql";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../../builders/correlation-utils";
import { isGeneratedIncrementDefault } from "../../builders/generated-scalar";
import { separateData } from "../../builders/relation-data-builder";
import { buildValues } from "../../builders/values-builder";
import { createChildContext, getTableName } from "../../context";
import { parseFindUniqueResult } from "../../result-flow";
import {
  type BatchPreparationContext,
  NestedWriteError,
  type Operation,
  type PreparedBatchOperation,
  type QueryContext,
  QueryEngineError,
} from "../../types";
import { buildFindUnique } from "../find-unique";
import { buildUpdate } from "../update";
import {
  appendAssertUniqueExists,
  appendAssertUniqueMissing,
  appendAssertWhereExists,
  appendAssertWhereMissing,
} from "./assertions";
import {
  type BatchRecordRef,
  collectPlanStatements,
  createPlanState,
  type PlanState,
} from "./batch-references";
import {
  appendBeforeParentCreateRelation,
  appendRelationMutation,
} from "./batch-relations";
import {
  appendUpdatedPrimaryKeyStores,
  getBatchUpdatedPrimaryKeyRef,
  overlayUpdatedParentData,
} from "./batch-updated-primary-keys";
import { assertNoPlannedNestedMutationExecution } from "./planned-mutation";
import {
  buildUniqueWithWhere,
  fetchOptionalUniqueRecord,
  fetchOptionalUniqueWithWhereRecord,
  fetchRequiredUniqueRecord,
} from "./record-access";
import {
  hasRecordKeys,
  type NestedWriteGuard,
  planExistingUpsertBranch,
  splitRelationMutationsByFk,
} from "./semantic-plan";
import { assertNestedUpdatePlanIsExecutable } from "./update-plan";

type NestedBatchOperation = Extract<Operation, "create" | "update" | "upsert">;

interface BatchPlan<T> {
  statements: Sql[];
  setupStatements?: Sql[];
  cleanupStatements?: Sql[];
  parse: (results: QueryResult<unknown>[]) => T;
}

interface AppendedBatchPlan<T> {
  statements: Sql[];
  setupStatements: Sql[];
  cleanupStatements: Sql[];
  parse: (results: QueryResult<unknown>[]) => T;
}

export async function executeNestedWriteBatch<T>(
  driver: AnyDriver,
  ctx: QueryContext,
  operation: NestedBatchOperation,
  args: Record<string, unknown>
): Promise<T> {
  const batch = await prepareNestedWriteBatch<T>(driver, ctx, operation, args);
  const results = await driver._executeBatch(batch.queries);
  return batch.parseResult(results);
}

export async function prepareNestedWriteBatch<T>(
  driver: AnyDriver,
  ctx: QueryContext,
  operation: NestedBatchOperation,
  args: Record<string, unknown>,
  context?: BatchPreparationContext
): Promise<PreparedBatchOperation<T>> {
  const plan = context
    ? await appendNestedWriteBatchPlan<T>(
        driver,
        getSharedPlanState(ctx, context),
        ctx,
        operation,
        args
      )
    : await buildNestedWriteBatchPlan<T>(driver, ctx, operation, args);
  return {
    queries: plan.statements.map((statement) => {
      const prepared = driver._prepare(statement);
      return { sql: prepared.sql, params: prepared.params ?? [] };
    }),
    setupQueries: plan.setupStatements?.map((statement) => {
      const prepared = driver._prepare(statement);
      return { sql: prepared.sql, params: prepared.params ?? [] };
    }),
    cleanupQueries: plan.cleanupStatements?.map((statement) => {
      const prepared = driver._prepare(statement);
      return { sql: prepared.sql, params: prepared.params ?? [] };
    }),
    parseResult: plan.parse,
  };
}

async function buildNestedWriteBatchPlan<T>(
  driver: AnyDriver,
  ctx: QueryContext,
  operation: NestedBatchOperation,
  args: Record<string, unknown>
): Promise<BatchPlan<T>> {
  const state: PlanState = createPlanState(ctx);
  const appended = await appendNestedWriteBatchPlan<T>(
    driver,
    state,
    ctx,
    operation,
    args
  );

  return {
    statements: collectPlanStatements(state),
    parse: (results) =>
      appended.parse(
        results.slice(
          state.setupStatements.length,
          state.setupStatements.length + appended.statements.length
        )
      ),
  };
}

async function appendNestedWriteBatchPlan<T>(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  operation: NestedBatchOperation,
  args: Record<string, unknown>
): Promise<AppendedBatchPlan<T>> {
  const statementStart = state.statements.length;
  let finalWhere: Record<string, unknown>;

  if (operation === "create") {
    const data = args.data as Record<string, unknown>;
    const created = await appendCreateRecord(driver, state, ctx, data);
    finalWhere = created.primaryKey;
  } else if (operation === "update") {
    finalWhere = await appendUpdateRecord(driver, state, ctx, args);
  } else {
    finalWhere = await appendUpsertRecord(driver, state, ctx, args);
  }

  state.statements.push(
    buildFindUnique(ctx, {
      where: finalWhere,
      select: args.select as Record<string, unknown> | undefined,
      include: args.include as Record<string, unknown> | undefined,
    } as { where: Record<string, unknown> })
  );

  const operationStatements = state.statements.slice(statementStart);
  const resultIndex = operationStatements.length - 1;
  return {
    statements: operationStatements,
    setupStatements: state.setupStatements,
    cleanupStatements: state.cleanupStatements,
    parse: (results) =>
      parseFindUniqueResult<T>(ctx, results[resultIndex]?.rows ?? []),
  };
}

function getSharedPlanState(
  ctx: QueryContext,
  context: BatchPreparationContext
): PlanState {
  if (context.nestedWriteState) {
    if (!isPlanState(context.nestedWriteState)) {
      throw new QueryEngineError(
        "Invalid nested write batch preparation context."
      );
    }
    return context.nestedWriteState;
  }

  const state = createPlanState(ctx);
  context.nestedWriteState = state;
  return state;
}

function isPlanState(value: unknown): value is PlanState {
  return (
    value !== null &&
    typeof value === "object" &&
    "batchId" in value &&
    "statements" in value &&
    "setupStatements" in value &&
    "cleanupStatements" in value &&
    "registerProducedPrimaryKeyRef" in value
  );
}

export async function appendCreateRecord(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  data: Record<string, unknown>
): Promise<BatchRecordRef> {
  const { scalarData, relations } = separateData(ctx, data);
  assertNoPlannedNestedMutationExecution(relations, "create");
  const { currentHoldsFk, relatedHoldsFk } = splitRelationMutationsByFk(
    ctx,
    relations
  );
  const recordRef = getBatchPrimaryKeyRef(
    state,
    ctx.model,
    scalarData,
    "create"
  );

  for (const [relationName, mutation] of currentHoldsFk) {
    await appendBeforeParentCreateRelation(
      driver,
      state,
      ctx,
      relationName,
      mutation,
      scalarData
    );
  }

  appendInsert(state, ctx, ctx.model, scalarData);
  appendGeneratedPrimaryKeyStores(state, ctx, recordRef);

  for (const [relationName, mutation] of relatedHoldsFk) {
    await appendRelationMutation(
      driver,
      state,
      ctx,
      relationName,
      mutation,
      recordRef.primaryKey
    );
  }

  return recordRef;
}

async function appendUpdateRecord(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const where = args.where as Record<string, unknown>;
  const data = args.data as Record<string, unknown>;
  const { scalarData, relations } = separateData(ctx, data);
  assertNestedUpdatePlanIsExecutable(ctx, relations);

  const parentRecord = await fetchRequiredUniqueRecord(
    driver,
    ctx,
    ctx.model,
    where,
    {
      relationName: getTableName(ctx.model),
      operation: "update",
      kind: "nested-write",
    }
  );
  appendAssertUniqueExists(state, ctx, ctx.model, where);

  const updatedRecord = getBatchUpdatedPrimaryKeyRef(
    state,
    ctx,
    parentRecord,
    scalarData,
    "update"
  );

  if (Object.keys(scalarData).length > 0) {
    state.statements.push(buildUpdate(ctx, { where, data: scalarData }));
    appendUpdatedPrimaryKeyStores(state, ctx, updatedRecord);
  }

  const updatedParentData = overlayUpdatedParentData(
    ctx.model,
    parentRecord,
    updatedRecord.primaryKey,
    scalarData
  );
  for (const [relationName, mutation] of Object.entries(relations)) {
    await appendRelationMutation(
      driver,
      state,
      ctx,
      relationName,
      mutation,
      updatedParentData
    );
  }

  return updatedRecord.primaryKey;
}

async function appendUpsertRecord(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const where = args.where as Record<string, unknown>;
  const existingRecord = await fetchOptionalUniqueRecord(
    driver,
    ctx,
    ctx.model,
    where
  );

  if (existingRecord) {
    appendAssertUniqueExists(state, ctx, ctx.model, where);
    const pkWhere = getStaticPrimaryKeyWhere(
      ctx.model,
      existingRecord,
      "upsert"
    );
    const targetWhere = args.targetWhere as Record<string, unknown> | undefined;
    const targetWhereMatched = hasRecordKeys(targetWhere)
      ? Boolean(
          await fetchOptionalUniqueWithWhereRecord(
            driver,
            ctx,
            ctx.model,
            pkWhere,
            targetWhere
          )
        )
      : undefined;
    const setWhere = args.setWhere as Record<string, unknown> | undefined;
    const setWhereMatched =
      targetWhereMatched !== false && hasRecordKeys(setWhere)
        ? Boolean(
            await fetchOptionalUniqueWithWhereRecord(
              driver,
              ctx,
              ctx.model,
              pkWhere,
              setWhere
            )
          )
        : undefined;
    const branch = planExistingUpsertBranch({
      model: ctx.model,
      existingRecord,
      pkWhere,
      targetWhere,
      targetWhereMatched,
      setWhere,
      setWhereMatched,
    });

    if (branch.kind !== "update") {
      appendPlanGuard(state, ctx, branch.guard);
      return branch.pkWhere;
    }

    if (branch.targetWhereGuard) {
      appendPlanGuard(state, ctx, branch.targetWhereGuard);
    }
    if (branch.setWhereGuard) {
      appendPlanGuard(state, ctx, branch.setWhereGuard);
    }

    const updateArgs = {
      where,
      data: args.update as Record<string, unknown>,
      select: args.select,
      include: args.include,
    };
    return appendUpdateRecordFromExisting(
      driver,
      state,
      ctx,
      updateArgs,
      existingRecord
    );
  }

  appendAssertUniqueMissing(state, ctx, ctx.model, where);
  const createData = args.create as Record<string, unknown>;
  const created = await appendCreateRecord(driver, state, ctx, createData);
  return created.primaryKey;
}

function appendPlanGuard(
  state: PlanState,
  ctx: QueryContext,
  guard: NestedWriteGuard
): void {
  switch (guard.kind) {
    case "uniqueExists":
      appendAssertUniqueExists(state, ctx, guard.model, guard.where);
      break;

    case "uniqueMissing":
      appendAssertUniqueMissing(state, ctx, guard.model, guard.where);
      break;

    case "uniqueWithWhereExists":
      appendAssertWhereExists(
        state,
        ctx,
        guard.model,
        buildUniqueWithWhere(ctx, guard.model, guard.uniqueWhere, guard.where)
      );
      break;

    case "uniqueWithWhereMissing":
      appendAssertWhereMissing(
        state,
        ctx,
        guard.model,
        buildUniqueWithWhere(ctx, guard.model, guard.uniqueWhere, guard.where)
      );
      break;
  }
}

async function appendUpdateRecordFromExisting(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  args: Record<string, unknown>,
  existingRecord: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const data = args.data as Record<string, unknown>;
  const { scalarData, relations } = separateData(ctx, data);
  assertNestedUpdatePlanIsExecutable(ctx, relations);

  const pkWhere = getStaticPrimaryKeyWhere(ctx.model, existingRecord, "upsert");
  const updatedRecord = getBatchUpdatedPrimaryKeyRef(
    state,
    ctx,
    existingRecord,
    scalarData,
    "upsert"
  );

  if (Object.keys(scalarData).length > 0) {
    state.statements.push(
      buildUpdate(ctx, { where: pkWhere, data: scalarData })
    );
    appendUpdatedPrimaryKeyStores(state, ctx, updatedRecord);
  }

  const updatedParentData = overlayUpdatedParentData(
    ctx.model,
    existingRecord,
    updatedRecord.primaryKey,
    scalarData
  );
  for (const [relationName, mutation] of Object.entries(relations)) {
    await appendRelationMutation(
      driver,
      state,
      ctx,
      relationName,
      mutation,
      updatedParentData
    );
  }

  return updatedRecord.primaryKey;
}

function appendInsert(
  state: PlanState,
  ctx: QueryContext,
  model: Model<any>,
  data: Record<string, unknown>
): void {
  const childCtx =
    model === ctx.model ? ctx : createChildContext(ctx, model, ctx.nextAlias());
  const { columns, values } = buildValues(childCtx, data);
  const table = ctx.adapter.identifiers.escape(getTableName(model));
  state.statements.push(ctx.adapter.mutations.insert(table, columns, values));
}

function getStaticPrimaryKeyWhere(
  model: Model<any>,
  data: Record<string, unknown>,
  operation: string
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const pkField of getPrimaryKeyFields(model)) {
    const value = data[pkField];
    if (value === undefined || value === null || isSql(value)) {
      throw new NestedWriteError(
        `Batch-only nested ${operation} requires primary key field '${pkField}' to be known before execution.`,
        getTableName(model)
      );
    }
    values[pkField] = value;
  }
  return buildPrimaryKeyWhereUnique(model, values);
}

function getBatchPrimaryKeyRef(
  state: PlanState,
  model: Model<any>,
  data: Record<string, unknown>,
  operation: string
): BatchRecordRef {
  const pkFields = getPrimaryKeyFields(model);
  const normalizedData = { ...data };
  const generatedFields: string[] = [];

  for (const pkField of pkFields) {
    const field = model["~"].state.scalars[pkField];
    const value = data[pkField];
    const isGeneratedIncrement = isGeneratedIncrementDefault(field, value);

    if (
      value !== undefined &&
      value !== null &&
      !isSql(value) &&
      !isGeneratedIncrement
    ) {
      continue;
    }

    if (
      field?.["~"].state.autoGenerate === "increment" &&
      (value === undefined || isGeneratedIncrement)
    ) {
      generatedFields.push(pkField);
      delete normalizedData[pkField];
      continue;
    }

    throw new NestedWriteError(
      `Batch-only nested ${operation} requires primary key field '${pkField}' to be known before execution.`,
      getTableName(model)
    );
  }

  if (generatedFields.length > 0 && pkFields.length !== 1) {
    throw new NestedWriteError(
      `Batch-only nested ${operation} cannot propagate generated compound primary keys.`,
      getTableName(model)
    );
  }

  return state.registerProducedPrimaryKeyRef(model, normalizedData);
}

function appendGeneratedPrimaryKeyStores(
  state: PlanState,
  ctx: QueryContext,
  recordRef: BatchRecordRef
): void {
  for (const primaryKeyRef of recordRef.primaryKeyRefs) {
    state.statements.push(
      ctx.adapter.batchRefs.storeLastInsertId(
        primaryKeyRef.valueRef.batchId,
        primaryKeyRef.valueRef.key
      )
    );
  }
}
