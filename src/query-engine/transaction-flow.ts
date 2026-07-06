import type { AnyDriver } from "@drivers";
import {
  isVibORMError,
  NotFoundError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import { hasNestedWritesInData } from "./builders/nested-write-detector";
import {
  buildConnectFkValues,
  canUseSubqueryOnly,
  needsTransaction,
  separateData,
} from "./builders/relation-data-builder";
import {
  buildCreate,
  buildUpdate,
  executeNestedCreate,
  executeNestedUpdate,
} from "./operations";
import { buildFindUnique as buildFindUniqueQuery } from "./operations/find-unique";
import {
  fetchRequiredUniqueRows,
  getPrimaryKeyWhereFromRecord,
  getProvidedPrimaryKeyWhere,
  getUpdatedPrimaryKeyWhere,
  needsMutationRefetch,
} from "./operations/mutation-returns";
import { runNestedMutationAtomically } from "./operations/nested-writes/atomic-runner";
import { executeNestedWriteBatch } from "./operations/nested-writes/batch-plan";
import {
  runInterpreter,
  selectMode,
} from "./operations/nested-writes/interpreter";
import { assertNoPlannedNestedMutationExecution } from "./operations/nested-writes/planned-mutation";
import { fetchOptionalUniqueWithWhereRecord } from "./operations/nested-writes/record-access";
import { isTreeEligible } from "./operations/nested-writes/routing";
import {
  hasRecordKeys,
  planExistingUpsertBranch,
  planRelationMutationSteps,
} from "./operations/nested-writes/semantic-plan";
import { assertNestedUpdatePlanIsExecutable } from "./operations/nested-writes/update-plan";
import {
  executeNonReturningMutation,
  parseFindUniqueResult,
  parseOperationResult,
  throwIfSingleRecordMutationMiss,
} from "./result-flow";
import { type Operation, type QueryContext, QueryEngineError } from "./types";

export function hasNestedWrites(
  operation: Operation,
  args: Record<string, unknown>
): boolean {
  if (!["create", "update", "upsert"].includes(operation)) {
    return false;
  }

  if (operation === "upsert") {
    return (
      hasNestedWritesInData(args.create) || hasNestedWritesInData(args.update)
    );
  }

  return hasNestedWritesInData(args.data);
}

export function needsUpsertWhereFallback(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>
): boolean {
  if (operation !== "upsert") {
    return false;
  }

  if (ctx.adapter.capabilities.supportsUpsertWhere) {
    return false;
  }

  return hasUpsertWhereOptions(operation, args);
}

export function hasUpsertWhereOptions(
  operation: Operation,
  args: Record<string, unknown>
): boolean {
  return (
    operation === "upsert" &&
    (hasRecordKeys(args.targetWhere) || hasRecordKeys(args.setWhere))
  );
}

export async function executeWithNestedWrites<T>(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>,
  driver: AnyDriver
): Promise<T> {
  const modelName = ctx.model["~"].names.ts ?? "unknown";

  driver.setContext({ model: modelName, operation });

  try {
    return await runNestedWriteOperation<T>(
      ctx,
      operation,
      args,
      driver,
      modelName
    );
  } catch (error) {
    // SELECT ... FOR UPDATE cannot lock absent rows, so two concurrent
    // upserts/connectOrCreates of a missing key can both take the create
    // branch. The loser's transaction rolled back with a unique violation
    // (Postgres/SQLite) or a gap-lock deadlock (MySQL); rerunning it sees
    // the winner's committed row and takes the update/found branch instead.
    if (
      isWriteRaceLoserError(error) &&
      hasRaceableCreateBranch(operation, args)
    ) {
      return await runNestedWriteOperation<T>(
        ctx,
        operation,
        args,
        driver,
        modelName
      );
    }
    throw error;
  } finally {
    driver.clearContext();
  }
}

function runNestedWriteOperation<T>(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>,
  driver: AnyDriver,
  modelName: string
): Promise<T> {
  // Migration routing seam (§11): whole trees whose every nested kind and
  // relation class is migrated run on the new interpreter; all others delegate
  // to the frozen legacy engines below. MIGRATED is empty at M1, so every tree
  // delegates and behavior is unchanged.
  if (isTreeEligible(ctx, operation, args)) {
    const mode = selectMode(driver, operation);
    return runInterpreter<T>(ctx, operation, args, mode);
  }

  if (
    !driver.supportsTransactions &&
    driver.supportsBatch &&
    isNestedBatchOperation(operation)
  ) {
    return executeNestedWriteBatch<T>(driver, ctx, operation, args);
  }

  switch (operation) {
    case "create":
      return executeCreateWithNestedWrites<T>(ctx, args, driver, modelName);

    case "update":
      return executeUpdateWithNestedWrites<T>(ctx, args, driver, modelName);

    case "upsert":
      return executeUpsertWithNestedWrites<T>(ctx, args, driver, modelName);

    default:
      throw new QueryEngineError(
        `Nested writes not supported for operation: ${operation}`
      );
  }
}

function isWriteRaceLoserError(error: unknown): boolean {
  if (error instanceof UniqueConstraintError) {
    return true;
  }

  return (
    isVibORMError(error) &&
    (error.code === VibORMErrorCode.DEADLOCK ||
      error.code === VibORMErrorCode.SERIALIZATION_FAILURE)
  );
}

function hasRaceableCreateBranch(
  operation: Operation,
  args: Record<string, unknown>
): boolean {
  if (operation === "upsert") {
    return true;
  }

  return containsRaceableNestedWrite(args.data);
}

function containsRaceableNestedWrite(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsRaceableNestedWrite);
  }

  if (value === null || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  if ("connectOrCreate" in record || "upsert" in record) {
    return true;
  }

  return Object.values(record).some(containsRaceableNestedWrite);
}

export function isNestedBatchOperation(
  operation: Operation
): operation is Extract<Operation, "create" | "update" | "upsert"> {
  return (
    operation === "create" || operation === "update" || operation === "upsert"
  );
}

async function executeCreateWithNestedWrites<T>(
  ctx: QueryContext,
  args: Record<string, unknown>,
  driver: AnyDriver,
  modelName: string
): Promise<T> {
  const data = args.data as Record<string, unknown>;
  const { scalarData, relations } = separateData(ctx, data);
  assertNoPlannedNestedMutationExecution(relations, "create");

  const hasMultipleConnects = Object.values(relations).some((mutation) =>
    planRelationMutationSteps("", mutation, "before").some(
      (step) => step.kind === "connect" && step.inputs.length > 1
    )
  );

  if (canUseSubqueryOnly(relations) && !hasMultipleConnects) {
    const dataWithFks = { ...scalarData };
    for (const [relationName, mutation] of Object.entries(relations)) {
      for (const step of planRelationMutationSteps(
        relationName,
        mutation,
        "before"
      )) {
        if (step.kind !== "connect" || !mutation.relationInfo.fields?.length) {
          continue;
        }
        const fkValues = buildConnectFkValues(
          ctx,
          mutation.relationInfo,
          step.inputs[0]!
        );
        Object.assign(dataWithFks, fkValues);
      }
    }

    const sqlQuery = buildCreate(ctx, {
      data: dataWithFks,
      select: args.select as Record<string, unknown>,
      include: args.include as Record<string, unknown>,
    });
    const result = needsMutationRefetch(ctx, "create")
      ? await executeNonReturningMutation(
          ctx,
          "create",
          {
            ...args,
            data: dataWithFks,
          },
          sqlQuery,
          driver,
          modelName
        )
      : await driver._execute(sqlQuery);
    return parseOperationResult<T>(ctx, "create", result.rows);
  }

  const createResult = await executeNestedCreate(driver, ctx, data);

  if (args.include || args.select) {
    const refetchWhere = getProvidedPrimaryKeyWhere(
      ctx.model,
      createResult.record
    );
    if (refetchWhere) {
      const refetchArgs = {
        where: refetchWhere,
        select: args.select,
        include: args.include,
      };
      const refetchSql = buildFindUniqueQuery(
        ctx,
        refetchArgs as { where: Record<string, unknown> }
      );
      const refetchResult = await driver._execute(refetchSql);
      if (refetchResult.rows.length > 0) {
        return parseFindUniqueResult<T>(ctx, refetchResult.rows);
      }
    }
  }

  // Prisma parity: without select/include, mutations return scalars only
  return createResult.record as T;
}

async function executeUpdateWithNestedWrites<T>(
  ctx: QueryContext,
  args: Record<string, unknown>,
  driver: AnyDriver,
  modelName: string
): Promise<T> {
  const data = args.data as Record<string, unknown>;
  const where = args.where as Record<string, unknown>;
  const { scalarData, relations } = separateData(ctx, data);
  assertNestedUpdatePlanIsExecutable(ctx, relations);

  if (Object.keys(relations).length > 0 && needsTransaction(relations)) {
    return runNestedMutationAtomically(driver, "update", async (txDriver) => {
      const beforeRows = await fetchRequiredUniqueRows(
        txDriver,
        ctx,
        { where },
        "update",
        modelName
      );
      const refetchWhere = getUpdatedPrimaryKeyWhere(
        ctx,
        beforeRows[0]!,
        scalarData,
        modelName
      );

      if (Object.keys(scalarData).length > 0) {
        const updateSql = buildUpdate(ctx, { where, data: scalarData });
        await txDriver._execute(updateSql);
      }

      const selectSql = buildFindUniqueQuery(ctx, {
        where: refetchWhere,
      });
      const selectResult =
        await txDriver._execute<Record<string, unknown>>(selectSql);
      const updatedRecord = selectResult.rows[0];

      if (!updatedRecord) {
        throw new NotFoundError(modelName, "update");
      }

      await executeNestedUpdate(txDriver, ctx, updatedRecord, relations);

      if (args.include || args.select) {
        const refetchSql = buildFindUniqueQuery(ctx, {
          where: refetchWhere,
          select: args.select as Record<string, unknown> | undefined,
          include: args.include as Record<string, unknown> | undefined,
        } as { where: Record<string, unknown> });
        const refetchResult =
          await txDriver._execute<Record<string, unknown>>(refetchSql);
        return parseFindUniqueResult<T>(ctx, refetchResult.rows);
      }

      return updatedRecord as T;
    });
  }

  const updateSql = buildUpdate(
    ctx,
    args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }
  );
  const result = needsMutationRefetch(ctx, "update")
    ? await executeNonReturningMutation(
        ctx,
        "update",
        args,
        updateSql,
        driver,
        modelName
      )
    : await driver._execute(updateSql);
  await throwIfSingleRecordMutationMiss(
    ctx,
    "update",
    result.rowCount,
    modelName,
    args,
    driver
  );
  return parseOperationResult<T>(ctx, "update", result.rows);
}

async function executeUpsertWithNestedWrites<T>(
  ctx: QueryContext,
  args: Record<string, unknown>,
  driver: AnyDriver,
  modelName: string
): Promise<T> {
  return runNestedMutationAtomically(driver, "upsert", async (txDriver) => {
    const where = args.where as Record<string, unknown>;
    const targetWhere = args.targetWhere as Record<string, unknown> | undefined;
    const setWhere = args.setWhere as Record<string, unknown> | undefined;

    const selectSql = buildFindUniqueQuery(ctx, {
      where,
      forUpdate: true,
    });
    const selectResult =
      await txDriver._execute<Record<string, unknown>>(selectSql);

    if (selectResult.rows.length > 0) {
      return executeExistingUpsert<T>(
        ctx,
        args,
        txDriver,
        modelName,
        selectResult.rows[0]!,
        targetWhere,
        setWhere
      );
    }

    return executeMissingUpsert<T>(ctx, args, txDriver);
  });
}

async function executeExistingUpsert<T>(
  ctx: QueryContext,
  args: Record<string, unknown>,
  txDriver: AnyDriver,
  modelName: string,
  existingRecord: Record<string, unknown>,
  targetWhere: Record<string, unknown> | undefined,
  setWhere: Record<string, unknown> | undefined
): Promise<T> {
  const pkWhere = getPrimaryKeyWhereFromRecord(
    ctx.model,
    existingRecord,
    modelName
  );
  const targetWhereMatched = hasRecordKeys(targetWhere)
    ? Boolean(
        await fetchOptionalUniqueWithWhereRecord(
          txDriver,
          ctx,
          ctx.model,
          pkWhere,
          targetWhere
        )
      )
    : undefined;
  const setWhereMatched =
    targetWhereMatched !== false && hasRecordKeys(setWhere)
      ? Boolean(
          await fetchOptionalUniqueWithWhereRecord(
            txDriver,
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
  let finalWhere: Record<string, unknown> = branch.pkWhere;

  if (branch.kind === "update") {
    const updateData = args.update as Record<string, unknown>;
    const { scalarData, relations } = separateData(ctx, updateData);
    assertNestedUpdatePlanIsExecutable(ctx, relations);
    finalWhere = getUpdatedPrimaryKeyWhere(
      ctx,
      existingRecord,
      scalarData,
      modelName
    );

    if (Object.keys(scalarData).length > 0) {
      const updateSql = buildUpdate(ctx, {
        where: pkWhere,
        data: scalarData,
      });
      await txDriver._execute(updateSql);
    }

    const refetchByPkSql = buildFindUniqueQuery(ctx, {
      where: finalWhere,
    });
    const updatedResult =
      await txDriver._execute<Record<string, unknown>>(refetchByPkSql);
    const updatedRecord = updatedResult.rows[0];

    if (!updatedRecord) {
      throw new QueryEngineError(
        "Record was deleted by another transaction during upsert"
      );
    }

    if (Object.keys(relations).length > 0) {
      await executeNestedUpdate(txDriver, ctx, updatedRecord, relations);
    }
  }

  const refetchSql = buildFindUniqueQuery(ctx, {
    where: finalWhere,
    select: args.select as Record<string, unknown> | undefined,
    include: args.include as Record<string, unknown> | undefined,
  } as { where: Record<string, unknown> });
  const refetchResult =
    await txDriver._execute<Record<string, unknown>>(refetchSql);
  return parseFindUniqueResult<T>(ctx, refetchResult.rows);
}

async function executeMissingUpsert<T>(
  ctx: QueryContext,
  args: Record<string, unknown>,
  txDriver: AnyDriver
): Promise<T> {
  const createData = args.create as Record<string, unknown>;
  const { relations } = separateData(ctx, createData);
  assertNoPlannedNestedMutationExecution(relations, "upsertCreate");

  const createResult = await executeNestedCreate(txDriver, ctx, createData);

  if (args.include || args.select) {
    const refetchWhere = getProvidedPrimaryKeyWhere(
      ctx.model,
      createResult.record
    );
    if (refetchWhere) {
      const refetchSql = buildFindUniqueQuery(ctx, {
        where: refetchWhere,
        select: args.select as Record<string, unknown> | undefined,
        include: args.include as Record<string, unknown> | undefined,
      } as { where: Record<string, unknown> });
      const refetchResult =
        await txDriver._execute<Record<string, unknown>>(refetchSql);
      if (refetchResult.rows.length > 0) {
        return parseFindUniqueResult<T>(ctx, refetchResult.rows);
      }
    }
  }

  // Prisma parity: without select/include, mutations return scalars only
  return createResult.record as T;
}
