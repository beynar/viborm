import type { AnyDriver } from "@drivers";
import { NotFoundError } from "@errors";
import type { Model } from "@schema/model";
import { isSql } from "@sql";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import { isGeneratedIncrementDefault } from "../builders/generated-scalar";
import { getWhereUniqueFieldNames } from "../builders/where-unique-builder";
import { type Operation, type QueryContext, QueryEngineError } from "../types";
import { buildFindUnique } from "./find-unique";

type SingleRecordMutation = "create" | "update" | "delete" | "upsert";

const SINGLE_RECORD_MUTATIONS: readonly Operation[] = [
  "create",
  "update",
  "delete",
  "upsert",
];

export function needsMutationRefetch(
  ctx: QueryContext,
  operation: Operation
): operation is SingleRecordMutation {
  return (
    SINGLE_RECORD_MUTATIONS.includes(operation) &&
    !ctx.adapter.capabilities.supportsReturning
  );
}

/**
 * Whether a non-returning adapter (MySQL) can run this upsert natively as
 * INSERT ... ON DUPLICATE KEY UPDATE and refetch the row afterwards.
 * The update branch is refetched by the upsert's unique where, so the
 * update must not rewrite those fields, and ON DUPLICATE KEY UPDATE
 * requires at least one assignment.
 */
export function canRefetchNativeUpsert(
  ctx: QueryContext,
  args: Record<string, unknown>
): boolean {
  const where = args.where as Record<string, unknown> | undefined;
  const update = args.update as Record<string, unknown> | undefined;
  if (!(where && update)) {
    return false;
  }

  const hasAssignments = Object.values(update).some(
    (value) => value !== undefined
  );
  if (!hasAssignments) {
    return false;
  }

  return getWhereUniqueFieldNames(ctx, where).every(
    (field) => update[field] === undefined
  );
}

export async function fetchUniqueRows(
  driver: AnyDriver,
  ctx: QueryContext,
  args: {
    where: Record<string, unknown>;
    select?: Record<string, unknown>;
    include?: Record<string, unknown>;
    forUpdate?: boolean;
  }
): Promise<Record<string, unknown>[]> {
  const result = await driver._execute<Record<string, unknown>>(
    buildFindUnique(ctx, args)
  );
  return result.rows;
}

export async function fetchRequiredUniqueRows(
  driver: AnyDriver,
  ctx: QueryContext,
  args: {
    where: Record<string, unknown>;
    select?: Record<string, unknown>;
    include?: Record<string, unknown>;
    forUpdate?: boolean;
  },
  operation: SingleRecordMutation,
  modelName: string
): Promise<Record<string, unknown>[]> {
  const rows = await fetchUniqueRows(driver, ctx, args);

  if (rows.length === 0) {
    throw new NotFoundError(modelName, operation);
  }

  return rows;
}

export async function getCreateRefetchWhere(
  driver: AnyDriver,
  ctx: QueryContext,
  data: Record<string, unknown>,
  modelName: string,
  insertId?: number | bigint
): Promise<Record<string, unknown>> {
  const providedWhere = getProvidedPrimaryKeyWhere(ctx.model, data);
  if (providedWhere) {
    return providedWhere;
  }

  const generatedWhere = await getGeneratedPrimaryKeyWhere(
    driver,
    ctx,
    insertId
  );
  if (generatedWhere) {
    return generatedWhere;
  }

  throw new QueryEngineError(
    `Cannot return created row for model '${modelName}' because the primary key was not provided and no safe inserted-id refetch is available.`
  );
}

export function getPrimaryKeyWhereFromRecord(
  model: Model<any>,
  record: Record<string, unknown>,
  modelName: string
): Record<string, unknown> {
  return buildPrimaryKeyWhereUnique(
    model,
    getPrimaryKeyValuesFromRecord(model, record, modelName)
  );
}

function getPrimaryKeyValuesFromRecord(
  model: Model<any>,
  record: Record<string, unknown>,
  modelName: string
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const pkField of getPrimaryKeyFields(model)) {
    const value = record[pkField];
    if (value === undefined || value === null) {
      throw new QueryEngineError(
        `Cannot refetch mutation result for model '${modelName}' because primary key field '${pkField}' is missing.`
      );
    }
    values[pkField] = value;
  }

  return values;
}

export function getUpdatedPrimaryKeyWhere(
  ctx: QueryContext,
  beforeRecord: Record<string, unknown>,
  data: Record<string, unknown>,
  modelName: string
): Record<string, unknown> {
  return buildPrimaryKeyWhereUnique(
    ctx.model,
    getUpdatedPrimaryKeyValues(ctx, beforeRecord, data, modelName)
  );
}

/**
 * Primary key values a row will have after applying `data`.
 * Throws when a primary key field is updated with a non-literal operation.
 */
export function getUpdatedPrimaryKeyValues(
  ctx: QueryContext,
  beforeRecord: Record<string, unknown>,
  data: Record<string, unknown>,
  modelName: string
): Record<string, unknown> {
  const values = getPrimaryKeyValuesFromRecord(
    ctx.model,
    beforeRecord,
    modelName
  );

  for (const pkField of getPrimaryKeyFields(ctx.model)) {
    if (!(pkField in data) || data[pkField] === undefined) {
      continue;
    }

    const updatedValue = getSafeUpdatedScalarValue(data[pkField]);
    if (updatedValue === unsafeScalarUpdate) {
      throw new QueryEngineError(
        `Cannot return updated row for model '${modelName}' because primary key field '${pkField}' is updated with a non-literal operation.`
      );
    }

    values[pkField] = updatedValue;
  }

  return values;
}

export async function refetchCreatedRows(
  driver: AnyDriver,
  ctx: QueryContext,
  data: Record<string, unknown>,
  args: {
    select?: Record<string, unknown>;
    include?: Record<string, unknown>;
  },
  modelName: string,
  insertId?: number | bigint
): Promise<Record<string, unknown>[]> {
  const where = await getCreateRefetchWhere(
    driver,
    ctx,
    data,
    modelName,
    insertId
  );
  return fetchRequiredUniqueRows(
    driver,
    ctx,
    {
      where,
      select: args.select,
      include: args.include,
    },
    "create",
    modelName
  );
}

export function getProvidedPrimaryKeyWhere(
  model: Model<any>,
  data: Record<string, unknown>
): Record<string, unknown> | undefined {
  const values: Record<string, unknown> = {};

  for (const pkField of getPrimaryKeyFields(model)) {
    const value = data[pkField];
    const field = model["~"].state.scalars[pkField];
    if (
      value === undefined ||
      value === null ||
      isSql(value) ||
      isGeneratedIncrementDefault(field, value)
    ) {
      return undefined;
    }
    values[pkField] = value;
  }

  return buildPrimaryKeyWhereUnique(model, values);
}

async function getGeneratedPrimaryKeyWhere(
  driver: AnyDriver,
  ctx: QueryContext,
  insertId?: number | bigint
): Promise<Record<string, unknown> | undefined> {
  const pkFields = getPrimaryKeyFields(ctx.model);
  if (pkFields.length !== 1) {
    return undefined;
  }

  const pkField = pkFields[0]!;
  const field = ctx.model["~"].state.scalars[pkField];
  const autoGenerate = field?.["~"].state.autoGenerate;
  if (autoGenerate !== "increment") {
    return undefined;
  }

  // Prefer the driver-reported insert id: a separate SELECT LAST_INSERT_ID()
  // may run on a different pooled connection and read another session's id.
  const value = insertId ?? (await selectLastInsertId(driver, ctx, pkField));
  if (value === undefined || value === null) {
    return undefined;
  }

  return { [pkField]: value };
}

async function selectLastInsertId(
  driver: AnyDriver,
  ctx: QueryContext,
  alias: string
): Promise<unknown> {
  const result = await driver._execute<Record<string, unknown>>(
    ctx.adapter.clauses.select(
      ctx.adapter.identifiers.aliased(ctx.adapter.lastInsertId(), alias)
    )
  );
  return result.rows[0]?.[alias];
}

const unsafeScalarUpdate = Symbol("unsafe scalar update");

function getSafeUpdatedScalarValue(value: unknown): unknown {
  if (value === null || value === undefined || isSql(value)) {
    return unsafeScalarUpdate;
  }

  if (typeof value !== "object") {
    return value;
  }

  const operation = value as Record<string, unknown>;
  if (!("set" in operation)) {
    return unsafeScalarUpdate;
  }

  const setValue = operation.set;
  if (setValue === undefined || isSql(setValue)) {
    return unsafeScalarUpdate;
  }

  return setValue;
}
