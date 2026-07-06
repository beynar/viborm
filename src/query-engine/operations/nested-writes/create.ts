import type { AnyDriver } from "@drivers";
import { type Sql, sql } from "@sql";
import { getPrimaryKeyField } from "../../builders/correlation-utils";
import {
  type CreateManyInput,
  getFkDirection,
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import { buildValues } from "../../builders/values-builder";
import {
  createChildContext,
  getTableName,
  translateRowToFieldNames,
} from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import {
  fetchRequiredUniqueRows,
  getCreateRefetchWhere,
  getProvidedPrimaryKeyWhere,
} from "../mutation-returns";
import { assertSingleRelationInput } from "./assertions";
import { runNestedMutationAtomically } from "./atomic-runner";
import { executeConnectOrCreate } from "./connect-or-create";
import {
  assignCurrentFkValuesFromRecord,
  assignRelatedFkValuesFromParent,
  connectCreatedRecordToCurrentParent,
} from "./fk";
import { assertNoPlannedNestedMutationExecution } from "./planned-mutation";
import { fetchRequiredUniqueRecord } from "./record-access";
import { processRelationMutation } from "./relation-mutation";
import {
  planRelationMutationSteps,
  splitRelationMutationsByFk,
} from "./semantic-plan";

export interface NestedCreateResult {
  record: Record<string, unknown>;
}

export interface TransactionContext {
  generatedIds: Map<string, unknown>;
  createdRecords: Map<
    string,
    Record<string, unknown> | Record<string, unknown>[]
  >;
}

export async function executeNestedCreate(
  driver: AnyDriver,
  ctx: QueryContext,
  data: Record<string, unknown>
): Promise<NestedCreateResult> {
  const separated = separateData(ctx, data);
  const scalarData = { ...separated.scalarData };
  const { relations } = separated;
  assertNoPlannedNestedMutationExecution(relations, "create");

  if (Object.keys(relations).length === 0) {
    const result = await executeSimpleInsert(driver, ctx, scalarData);
    return { record: result };
  }

  return runNestedMutationAtomically(driver, "create", async (txDriver) => {
    const txCtx: TransactionContext = {
      generatedIds: new Map(),
      createdRecords: new Map(),
    };

    const { currentHoldsFk, relatedHoldsFk } = splitRelationMutationsByFk(
      ctx,
      relations
    );

    for (const [relationName, mutation] of currentHoldsFk) {
      await processCurrentFkMutationBeforeParentCreate(
        txDriver,
        ctx,
        relationName,
        mutation,
        scalarData,
        txCtx
      );
    }

    const parentRecord = await executeSimpleInsert(txDriver, ctx, scalarData);
    const parentPk = getPrimaryKeyField(ctx.model);
    const parentId = parentRecord[parentPk];
    txCtx.generatedIds.set("__parent__", parentId);

    for (const [relationName, mutation] of relatedHoldsFk) {
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
        }
      );
    }

    return { record: parentRecord };
  });
}

async function processCurrentFkMutationBeforeParentCreate(
  tx: AnyDriver,
  ctx: QueryContext,
  relationName: string,
  mutation: RelationMutation,
  scalarData: Record<string, unknown>,
  txCtx: TransactionContext
): Promise<void> {
  const { relationInfo } = mutation;
  const fkDir = getFkDirection(ctx, relationInfo);

  if (!fkDir.holdsFK) {
    throw new NestedWriteError(
      `Relation '${relationName}' does not store foreign keys on the parent model.`,
      relationName
    );
  }

  for (const step of planRelationMutationSteps(
    relationName,
    mutation,
    "before"
  )) {
    switch (step.kind) {
      case "create": {
        if (relationInfo.isToOne) {
          assertSingleRelationInput(relationName, "create", step.inputs);
        }

        const createdRecords: Record<string, unknown>[] = [];
        for (const createData of step.inputs) {
          const record = await executeRelationCreate(
            tx,
            ctx,
            relationInfo,
            createData,
            "before",
            scalarData
          );
          createdRecords.push(record);
        }

        const firstRecord = createdRecords[0];
        if (firstRecord) {
          assignCurrentFkValuesFromRecord(
            fkDir,
            firstRecord,
            scalarData,
            relationName
          );
        }

        txCtx.createdRecords.set(
          relationName,
          relationInfo.isToMany ? createdRecords : createdRecords[0]!
        );
        break;
      }

      case "connect": {
        if (relationInfo.isToOne) {
          assertSingleRelationInput(relationName, "connect", step.inputs);
        }

        const targetRecord = await fetchRequiredUniqueRecord(
          tx,
          ctx,
          relationInfo.targetModel,
          step.inputs[0]!,
          { relationName, operation: "connect", kind: "target" }
        );
        assignCurrentFkValuesFromRecord(
          fkDir,
          targetRecord,
          scalarData,
          relationName
        );
        break;
      }

      case "connectOrCreate": {
        if (relationInfo.isToOne) {
          assertSingleRelationInput(
            relationName,
            "connectOrCreate",
            step.inputs.map((input) => input.where)
          );
        }

        const record = await executeConnectOrCreate(
          tx,
          ctx,
          relationInfo,
          step.inputs[0]!,
          "before",
          scalarData,
          txCtx,
          executeRelationCreate
        );

        if (record) {
          assignCurrentFkValuesFromRecord(
            fkDir,
            record,
            scalarData,
            relationName
          );
          txCtx.createdRecords.set(relationName, record);
        }
        break;
      }

      default:
        throwUnsupportedNestedCreate(relationName);
    }
  }
}

function throwUnsupportedNestedCreate(relationName: string): never {
  throw new NestedWriteError(
    `Unsupported nested create operation on relation '${relationName}'.`,
    relationName
  );
}

export async function executeRelationCreate(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  createData: Record<string, unknown>,
  timing: "before" | "after",
  parentData: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { targetModel } = relationInfo;
  const fkDir = getFkDirection(ctx, relationInfo);
  const childCtx = createChildContext(ctx, targetModel, ctx.nextAlias());
  const dataWithFk = { ...createData };

  if (timing === "after" && !fkDir.holdsFK) {
    assignRelatedFkValuesFromParent(fkDir, dataWithFk, parentData);
  }

  const { scalarData, relations } = separateData(childCtx, dataWithFk);

  const record =
    Object.keys(relations).length > 0
      ? (await executeNestedCreate(tx, childCtx, dataWithFk)).record
      : await executeSimpleInsert(tx, childCtx, scalarData);

  // "after" + parent holds FK only happens for nested writes on an existing
  // parent (update path); point the parent row at the created record.
  if (timing === "after" && fkDir.holdsFK) {
    await connectCreatedRecordToCurrentParent(
      tx,
      ctx,
      relationInfo,
      record,
      parentData,
      "create"
    );
  }

  return record;
}

export async function executeRelationCreateMany(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  createManyInput: CreateManyInput,
  parentData: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  const { adapter } = ctx;
  const { targetModel, name } = relationInfo;
  const fkDir = getFkDirection(ctx, relationInfo);
  const childCtx = createChildContext(ctx, targetModel, ctx.nextAlias());

  if (fkDir.holdsFK) {
    throw new NestedWriteError(
      `Cannot use createMany for relation '${name}' - ` +
        "createMany is only supported for to-many relations where the related model holds the FK.",
      name
    );
  }

  const { data, skipDuplicates } = createManyInput;

  if (!data || data.length === 0) {
    return [];
  }

  const dataWithFks = data.map((record) => {
    const withFk = { ...record };
    assignRelatedFkValuesFromParent(fkDir, withFk, parentData);
    return withFk;
  });

  const { columns, values } = buildValues(childCtx, dataWithFks);

  if (columns.length === 0 || values.length === 0) {
    throw new NestedWriteError(
      `No data to insert for createMany on relation '${name}'`,
      name
    );
  }

  const targetTable = getTableName(targetModel);
  const table = adapter.identifiers.escape(targetTable);

  let insertSql: Sql;
  if (skipDuplicates) {
    const { prefix, suffix } = adapter.mutations.skipDuplicates();
    insertSql = adapter.mutations.insert(table, columns, values, prefix);
    insertSql = sql`${insertSql} ${suffix}`;
  } else {
    insertSql = adapter.mutations.insert(table, columns, values);
  }

  const returningSql = adapter.mutations.returning(sql`*`);
  const hasReturning = returningSql.strings.join("").trim() !== "";

  if (hasReturning) {
    const finalSql = sql`${insertSql} ${returningSql}`;
    const result = await tx._execute<Record<string, unknown>>(finalSql);
    return result.rows.map((row) => translateRowToFieldNames(targetModel, row));
  }

  const refetchWhere = dataWithFks.map((record) => {
    const where = getProvidedPrimaryKeyWhere(targetModel, record);
    if (!where) {
      throw new NestedWriteError(
        `Cannot return nested createMany records for relation '${name}' because every created row must provide a primary key when RETURNING is not supported.`,
        name
      );
    }
    return where;
  });

  await tx._execute(insertSql);

  const rows = await Promise.all(
    refetchWhere.map(async (where) => {
      const result = await fetchRequiredUniqueRows(
        tx,
        childCtx,
        { where },
        "create",
        getTableName(targetModel)
      );
      return result[0]!;
    })
  );

  return rows;
}

async function executeSimpleInsert(
  driver: AnyDriver,
  ctx: QueryContext,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);
  const modelName = ctx.model["~"]?.names?.ts ?? tableName;

  const { columns, values } = buildValues(ctx, data);

  if (columns.length === 0) {
    throw new NestedWriteError(
      `No data to insert for model '${modelName}'`,
      modelName
    );
  }

  const table = adapter.identifiers.escape(tableName);
  const insertSql = adapter.mutations.insert(table, columns, values);
  const returningSql = adapter.mutations.returning(sql`*`);
  const hasReturning = returningSql.strings.join("").trim() !== "";

  if (hasReturning) {
    const finalSql = sql`${insertSql} ${returningSql}`;
    const result = await driver._execute<Record<string, unknown>>(finalSql);

    if (result.rows.length === 0) {
      throw new NestedWriteError(
        `Insert did not return a record for model '${modelName}'`,
        modelName
      );
    }

    // RETURNING * yields raw column names; downstream FK propagation and the
    // mutation result read field names, so translate at this choke point.
    return translateRowToFieldNames(ctx.model, result.rows[0]!);
  }

  const insertResult = await driver._execute(insertSql);

  const where = await getCreateRefetchWhere(
    driver,
    ctx,
    data,
    modelName,
    insertResult.insertId
  );
  const rows = await fetchRequiredUniqueRows(
    driver,
    ctx,
    { where },
    "create",
    modelName
  );
  return rows[0]!;
}
