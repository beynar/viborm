/**
 * ManyAndReturn fallback execution for adapters without RETURNING (MySQL).
 *
 * createManyAndReturn: INSERT, then refetch the inserted rows — either by
 * the primary keys provided in the input, or (single auto-increment PK) by
 * the consecutive id range starting at the driver-reported insertId.
 *
 * updateManyAndReturn: inside a transaction, lock the matching rows' primary
 * keys, update exactly those rows, then re-select them.
 */

import type { AnyDriver } from "@drivers";
import { isSql, type Sql } from "@sql";
import { getPrimaryKeyFields } from "../builders/correlation-utils";
import { isGeneratedIncrementDefault } from "../builders/generated-scalar";
import {
  isManyAndReturnOperation,
  type Operation,
  type QueryContext,
  QueryEngineError,
} from "../types";
import { buildFindMany } from "./find-many";
import { getUpdatedPrimaryKeyValues } from "./mutation-returns";
import { buildUpdateMany } from "./update";

type MutationQueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
};

export function needsManyReturnRefetch(
  ctx: QueryContext,
  operation: Operation
): operation is "createManyAndReturn" | "updateManyAndReturn" {
  return (
    isManyAndReturnOperation(operation) &&
    !ctx.adapter.capabilities.supportsReturning
  );
}

export async function executeManyReturnWithoutReturning(
  ctx: QueryContext,
  operation: "createManyAndReturn" | "updateManyAndReturn",
  args: Record<string, unknown>,
  mutationSql: Sql,
  driver: AnyDriver,
  modelName: string
): Promise<MutationQueryResult> {
  if (operation === "createManyAndReturn") {
    return executeCreateManyRefetch(ctx, args, mutationSql, driver, modelName);
  }

  return executeUpdateManyRefetch(ctx, args, driver, modelName);
}

// =============================================================================
// CREATE MANY AND RETURN
// =============================================================================

async function executeCreateManyRefetch(
  ctx: QueryContext,
  args: Record<string, unknown>,
  mutationSql: Sql,
  driver: AnyDriver,
  modelName: string
): Promise<MutationQueryResult> {
  const data = args.data as Record<string, unknown>[];

  if (args.skipDuplicates) {
    // INSERT IGNORE cannot report WHICH rows were skipped, so the inserted
    // set cannot be identified for refetch.
    throw new QueryEngineError(
      `createManyAndReturn with skipDuplicates is not supported for model '${modelName}' on drivers without RETURNING (MySQL), because the inserted rows cannot be identified.`
    );
  }

  const providedPkValues = getAllProvidedPrimaryKeyValues(ctx, data);
  const canUseInsertIdRange =
    providedPkValues === undefined && hasSingleAutoIncrementPk(ctx);

  if (providedPkValues === undefined && !canUseInsertIdRange) {
    throw new QueryEngineError(
      `Cannot return created rows for model '${modelName}' on drivers without RETURNING (MySQL): provide all primary key values in data, or use a single auto-increment primary key.`
    );
  }

  const result = await driver._execute(mutationSql);

  const select = args.select as Record<string, unknown> | undefined;
  let refetchArgs: Record<string, unknown>;

  if (providedPkValues) {
    refetchArgs = {
      where: buildOrOfPkEquals(providedPkValues),
      ...(select ? { select } : {}),
    };
  } else {
    // Single auto-increment PK: mysql2 reports the FIRST inserted id, and
    // InnoDB assigns consecutive ids for a multi-row INSERT.
    // ponytail: innodb_autoinc_lock_mode=2 (interleaved) can break
    // consecutiveness under concurrent inserts; provide PKs in data if so.
    const pkField = getPrimaryKeyFields(ctx.model)[0]!;
    const firstId = result.insertId;
    if (firstId === undefined || firstId === null) {
      throw new QueryEngineError(
        `Cannot return created rows for model '${modelName}' because the driver did not report an insert id.`
      );
    }
    const first = BigInt(firstId);
    const last = first + BigInt(result.rowCount) - 1n;
    refetchArgs = {
      where: {
        [pkField]: {
          gte: toPkNumber(firstId, first),
          lte: toPkNumber(firstId, last),
        },
      },
      orderBy: { [pkField]: "asc" },
      ...(select ? { select } : {}),
    };
  }

  const refetched = await driver._execute<Record<string, unknown>>(
    buildFindMany(ctx, refetchArgs)
  );

  return { rows: refetched.rows, rowCount: result.rowCount };
}

/** Keep number PK bounds as numbers so binding matches the column type */
function toPkNumber(reported: number | bigint, value: bigint): number | bigint {
  return typeof reported === "number" &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

/**
 * Primary key values for every input row, or undefined if any row is
 * missing one (or uses a non-literal / generated value).
 */
function getAllProvidedPrimaryKeyValues(
  ctx: QueryContext,
  data: Record<string, unknown>[]
): Record<string, unknown>[] | undefined {
  const pkFields = getPrimaryKeyFields(ctx.model);
  const all: Record<string, unknown>[] = [];

  for (const row of data) {
    const values: Record<string, unknown> = {};
    for (const pkField of pkFields) {
      const value = row[pkField];
      const field = ctx.model["~"].state.scalars[pkField];
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
    all.push(values);
  }

  return all;
}

function hasSingleAutoIncrementPk(ctx: QueryContext): boolean {
  const pkFields = getPrimaryKeyFields(ctx.model);
  if (pkFields.length !== 1) {
    return false;
  }
  const field = ctx.model["~"].state.scalars[pkFields[0]!];
  return field?.["~"].state.autoGenerate === "increment";
}

// =============================================================================
// UPDATE MANY AND RETURN
// =============================================================================

async function executeUpdateManyRefetch(
  ctx: QueryContext,
  args: Record<string, unknown>,
  driver: AnyDriver,
  modelName: string
): Promise<MutationQueryResult> {
  const run = (txDriver: AnyDriver) =>
    runUpdateManyRefetch(ctx, args, txDriver, modelName);

  // ponytail: without transaction support this flow is non-atomic; every
  // current non-returning driver (mysql2, planetscale) supports transactions.
  return driver.supportsTransactions
    ? driver.withTransaction(run)
    : run(driver);
}

async function runUpdateManyRefetch(
  ctx: QueryContext,
  args: Record<string, unknown>,
  driver: AnyDriver,
  modelName: string
): Promise<MutationQueryResult> {
  const where = args.where as Record<string, unknown> | undefined;
  const data = args.data as Record<string, unknown>;
  const select = args.select as Record<string, unknown> | undefined;
  const pkFields = getPrimaryKeyFields(ctx.model);

  // 1. Lock the matching rows' primary keys
  const pkSelect: Record<string, boolean> = {};
  for (const pkField of pkFields) {
    pkSelect[pkField] = true;
  }
  const matched = await driver._execute<Record<string, unknown>>(
    buildFindMany(ctx, {
      ...(where ? { where } : {}),
      select: pkSelect,
      forUpdate: true,
    })
  );

  if (matched.rows.length === 0) {
    return { rows: [], rowCount: 0 };
  }

  // 2. Update exactly the locked rows
  const beforePkValues = matched.rows.map((row) => {
    const values: Record<string, unknown> = {};
    for (const pkField of pkFields) {
      values[pkField] = row[pkField];
    }
    return values;
  });

  const updateResult = await driver._execute(
    buildUpdateMany(ctx, { where: buildOrOfPkEquals(beforePkValues), data })
  );

  // 3. Re-select the rows by their post-update primary keys
  const afterPkValues = beforePkValues.map((values) =>
    getUpdatedPrimaryKeyValues(ctx, values, data, modelName)
  );

  const refetched = await driver._execute<Record<string, unknown>>(
    buildFindMany(ctx, {
      where: buildOrOfPkEquals(afterPkValues),
      ...(select ? { select } : {}),
    })
  );

  return { rows: refetched.rows, rowCount: updateResult.rowCount };
}

// =============================================================================
// SHARED
// =============================================================================

/**
 * Plain-where OR of per-row primary key equality conditions.
 * Single-PK single-row collapses to a simple equals for cleaner SQL.
 */
function buildOrOfPkEquals(
  pkValuesList: Record<string, unknown>[]
): Record<string, unknown> {
  const conditions = pkValuesList.map((values) => {
    const condition: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(values)) {
      condition[field] = { equals: value };
    }
    return condition;
  });

  return conditions.length === 1 ? conditions[0]! : { OR: conditions };
}
