import type { AnyDriver } from "@drivers";
import { NotFoundError } from "@errors";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { createQueryContext } from "./context";
import { buildFindUnique as buildFindUniqueQuery } from "./operations/find-unique";
import {
  fetchRequiredUniqueRows,
  fetchUniqueRows,
  getCreateRefetchWhere,
  getUpdatedPrimaryKeyWhere,
  refetchCreatedRows,
} from "./operations/mutation-returns";
import { parseResult } from "./result";
import {
  isBatchOperation,
  type Operation,
  type PrepareOptions,
  type QueryContext,
  type QueryEngineDependencies,
  QueryEngineError,
} from "./types";

type MutationQueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function applyPostProcessing<T>(
  result: T,
  operation: Operation,
  options: PrepareOptions | undefined,
  modelName: string
): T {
  if (options?.throwIfNotFound && result === null) {
    throw new NotFoundError(modelName, options.originalOperation ?? operation);
  }

  if (operation === "exist") {
    return ((result as number) > 0) as unknown as T;
  }

  return result;
}

export function applyPaginationPostProcessing<T>(
  result: T,
  operation: Operation,
  args: Record<string, unknown>
): T {
  if (
    operation === "findMany" &&
    typeof args.take === "number" &&
    args.take < 0 &&
    Array.isArray(result)
  ) {
    return [...result].reverse() as T;
  }

  return result;
}

export function parseOperationResult<T>(
  ctx: QueryContext,
  operation: Operation,
  raw: unknown[] | { rowCount: number }
): T {
  return parseResult<T>(ctx, operation, raw);
}

export function parseFindUniqueResult<T>(
  ctx: QueryContext,
  rows: unknown[]
): T {
  return parseResult<T>(ctx, "findUnique", rows);
}

export async function throwIfSingleRecordMutationMiss(
  ctx: QueryContext,
  operation: Operation,
  rowCount: number,
  modelName: string,
  args: Record<string, unknown>,
  driver: AnyDriver
): Promise<void> {
  if (operation === "delete" && rowCount === 0) {
    throw new NotFoundError(modelName, operation);
  }

  if (operation !== "update" || rowCount !== 0) {
    return;
  }

  if (ctx.adapter.capabilities.supportsReturning) {
    throw new NotFoundError(modelName, operation);
  }

  await throwIfNonReturningUpdateMiss(ctx, args, driver, modelName);
}

export async function executeNonReturningMutation(
  ctx: QueryContext,
  operation: "create" | "update" | "delete" | "upsert",
  args: Record<string, unknown>,
  mutationSql: Sql,
  driver: AnyDriver,
  modelName: string
): Promise<MutationQueryResult> {
  switch (operation) {
    case "create": {
      const data = getMutationData(args, operation);
      const result = await driver._execute(mutationSql);
      const rows = await refetchCreatedRows(
        driver,
        ctx,
        data,
        {
          select: args.select as Record<string, unknown> | undefined,
          include: args.include as Record<string, unknown> | undefined,
        },
        modelName,
        result.insertId
      );
      return { rows, rowCount: result.rowCount };
    }

    case "update": {
      const where = getMutationWhere(args, operation);
      const data = getMutationData(args, operation);
      const beforeRows = await fetchRequiredUniqueRows(
        driver,
        ctx,
        { where },
        operation,
        modelName
      );
      const refetchWhere = getUpdatedPrimaryKeyWhere(
        ctx,
        beforeRows[0]!,
        data,
        modelName
      );
      const result = await driver._execute(mutationSql);
      const rows = await fetchRequiredUniqueRows(
        driver,
        ctx,
        {
          where: refetchWhere,
          select: args.select as Record<string, unknown> | undefined,
          include: args.include as Record<string, unknown> | undefined,
        },
        operation,
        modelName
      );
      return { rows, rowCount: result.rowCount };
    }

    case "upsert": {
      const where = getMutationWhere(args, operation);
      const result = await driver._execute(mutationSql);
      // ON DUPLICATE KEY UPDATE affected-rows cannot reliably distinguish
      // the create and update branches (CLIENT_FOUND_ROWS changes its
      // semantics), so refetch by the upsert's unique where first — routing
      // guarantees the update branch never rewrites those fields — and fall
      // back to the created row's identity when the insert didn't satisfy
      // `where`.
      const selectArgs = {
        select: args.select as Record<string, unknown> | undefined,
        include: args.include as Record<string, unknown> | undefined,
      };
      const rows = await fetchUniqueRows(driver, ctx, {
        where,
        ...selectArgs,
      });
      if (rows.length > 0) {
        return { rows, rowCount: rows.length };
      }

      const createRefetchWhere = await getCreateRefetchWhere(
        driver,
        ctx,
        getUpsertCreateData(args),
        modelName,
        result.insertId
      );
      const createdRows = await fetchRequiredUniqueRows(
        driver,
        ctx,
        { where: createRefetchWhere, ...selectArgs },
        operation,
        modelName
      );
      return { rows: createdRows, rowCount: createdRows.length };
    }

    case "delete": {
      const where = getMutationWhere(args, operation);
      const rows = await fetchRequiredUniqueRows(
        driver,
        ctx,
        {
          where,
          select: args.select as Record<string, unknown> | undefined,
          include: args.include as Record<string, unknown> | undefined,
        },
        operation,
        modelName
      );
      const result = await driver._execute(mutationSql);
      if (result.rowCount === 0) {
        throw new NotFoundError(modelName, operation);
      }
      return { rows, rowCount: result.rowCount };
    }

    default:
      throw new QueryEngineError(
        `Non-returning mutation refetch is not supported for operation '${operation}'.`
      );
  }
}

export function throwIfDefinitiveSingleRecordMutationMiss(
  ctx: QueryContext,
  operation: Operation,
  rowCount: number,
  modelName: string
): void {
  const isDefinitiveUpdateMiss =
    operation === "update" && ctx.adapter.capabilities.supportsReturning;
  const isDefinitiveDeleteMiss = operation === "delete";

  if ((isDefinitiveUpdateMiss || isDefinitiveDeleteMiss) && rowCount === 0) {
    throw new NotFoundError(modelName, operation);
  }
}

export function createParseResultFunction<T>(
  dependencies: QueryEngineDependencies,
  model: Model<any>,
  operation: Operation,
  args: Record<string, unknown>,
  options?: PrepareOptions
): (raw: { rows: unknown[]; rowCount: number }) => T {
  const modelName = model["~"].names.ts ?? "unknown";

  return (raw: { rows: unknown[]; rowCount: number }): T => {
    const ctx = createQueryContext(
      dependencies.adapter,
      model,
      dependencies.registry,
      dependencies.driver
    );

    const parseInput = isBatchOperation(operation)
      ? { rowCount: raw.rowCount }
      : raw.rows;

    throwIfDefinitiveSingleRecordMutationMiss(
      ctx,
      operation,
      raw.rowCount,
      modelName
    );

    const parsed = parseOperationResult<T>(ctx, operation, parseInput);
    // args were already validated by prepare()/prepareBatch() before execution;
    // pagination post-processing only reads `take`, which validation never transforms
    const paginated = applyPaginationPostProcessing<T>(parsed, operation, args);

    return applyPostProcessing(paginated, operation, options, modelName);
  };
}

function getMutationData(
  args: Record<string, unknown>,
  operation: "create" | "update"
): Record<string, unknown> {
  const data = args.data;
  if (!isRecord(data)) {
    throw new QueryEngineError(
      `Validated ${operation} arguments are missing a data object`
    );
  }

  return data;
}

function getUpsertCreateData(
  args: Record<string, unknown>
): Record<string, unknown> {
  const data = args.create;
  if (!isRecord(data)) {
    throw new QueryEngineError(
      "Validated upsert arguments are missing a create object"
    );
  }

  return data;
}

function getMutationWhere(
  args: Record<string, unknown>,
  operation: "update" | "delete" | "upsert"
): Record<string, unknown> {
  const where = args.where;
  if (!isRecord(where)) {
    throw new QueryEngineError(
      `Validated ${operation} arguments are missing a where object`
    );
  }

  return where;
}

async function throwIfNonReturningUpdateMiss(
  ctx: QueryContext,
  args: Record<string, unknown>,
  driver: AnyDriver,
  modelName: string
): Promise<void> {
  const where = args.where;
  if (!isRecord(where)) {
    throw new QueryEngineError(
      "Validated update arguments are missing a where object"
    );
  }

  const selectSql = buildFindUniqueQuery(ctx, { where });
  const selectResult = await driver._execute(selectSql);

  if (selectResult.rows.length === 0) {
    throw new NotFoundError(modelName, "update");
  }
}
