import type { AnyDriver } from "@drivers";
import { type Sql, sql } from "@sql";
import {
  buildConnectFkValues,
  type ConnectOrCreateInput,
  type CreateManyInput,
  getFkDirection,
  type NestedUpdateInput,
  type NestedUpdateManyInput,
  type NestedUpsertInput,
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import { buildSet } from "../../builders/set-builder";
import { buildValues } from "../../builders/values-builder";
import { buildWhere } from "../../builders/where-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext, getTableName } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import {
  appendAssertUniqueExists,
  appendAssertUniqueMissing,
  appendAssertWhereExists,
} from "./assertions";
import { appendManyToManyMutation } from "./batch-many-to-many";
import { appendCreateRecord } from "./batch-plan";
import type { BatchResolvableValue, PlanState } from "./batch-references";
import {
  appendRelationConnect,
  appendRelationDelete,
  appendRelationDisconnect,
  appendRelationSet,
} from "./batch-relation-links";
import {
  appendUpdatedPrimaryKeyStores,
  getBatchUpdatedPrimaryKeyRef,
  hasPrimaryKeyUpdate,
} from "./batch-updated-primary-keys";
import {
  assignCurrentFkValues,
  assignRelatedFkValues,
  buildCurrentFkAssignments,
  buildFkMatchCondition,
  combineWithParentCorrelation,
  updateCurrentRecord,
} from "./fk";
import {
  fetchOptionalUniqueRecord,
  fetchOptionalWhereRecord,
  fetchRequiredWhereRecord,
} from "./record-access";
import {
  normalizeRecordArray,
  planRelationMutationSteps,
} from "./semantic-plan";
import {
  assertNestedUpdatePlanIsExecutable,
  assertUpdateManyDataHasNoRelations,
  normalizeNestedUpdateInputs,
  normalizeNestedUpdateManyInputs,
} from "./update-plan";

export async function appendBeforeParentCreateRelation(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  relationName: string,
  mutation: RelationMutation,
  parentData: Record<string, unknown>
): Promise<void> {
  for (const step of planRelationMutationSteps(
    relationName,
    mutation,
    "before"
  )) {
    const { relationInfo } = step.context;

    switch (step.kind) {
      case "create": {
        if (step.inputs.length !== 1) {
          throw new NestedWriteError(
            `Cannot use multiple 'create' inputs for to-one relation '${relationName}'.`,
            relationName
          );
        }
        const created = await appendCreateRecord(
          driver,
          state,
          createChildContext(ctx, relationInfo.targetModel, ctx.nextAlias()),
          step.inputs[0]!
        );
        assignCurrentFkValues(
          ctx,
          relationInfo,
          created.primaryKey,
          parentData
        );
        break;
      }

      case "connect": {
        const connect = step.inputs[0];
        if (!connect) break;
        appendAssertUniqueExists(state, ctx, relationInfo.targetModel, connect);
        Object.assign(
          parentData,
          buildConnectFkValues(ctx, relationInfo, connect)
        );
        break;
      }

      case "connectOrCreate": {
        const input = step.inputs[0];
        if (!input) break;
        const target = await appendConnectOrCreate(
          driver,
          state,
          ctx,
          relationInfo,
          input,
          parentData,
          false
        );
        if (target) {
          assignCurrentFkValues(ctx, relationInfo, target, parentData);
        }
        break;
      }

      default:
        throwUnsupportedNestedCreate(relationName);
    }
  }
}

export async function appendRelationMutation(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  relationName: string,
  mutation: RelationMutation,
  parentData: Record<string, unknown>
): Promise<void> {
  if (mutation.relationInfo.type === "manyToMany") {
    await appendManyToManyMutation(
      driver,
      state,
      ctx,
      relationName,
      mutation,
      parentData
    );
    return;
  }

  for (const step of planRelationMutationSteps(
    relationName,
    mutation,
    "after"
  )) {
    const { relationInfo } = step.context;

    switch (step.kind) {
      case "create":
        for (const createData of step.inputs) {
          await appendRelationCreate(
            driver,
            state,
            ctx,
            relationInfo,
            createData,
            parentData
          );
        }
        break;

      case "createMany":
        appendRelationCreateMany(
          state,
          ctx,
          relationInfo,
          step.input,
          parentData
        );
        break;

      case "connect":
        for (const connectInput of step.inputs) {
          appendRelationConnect(
            state,
            ctx,
            relationInfo,
            connectInput,
            parentData
          );
        }
        break;

      case "connectOrCreate":
        for (const input of step.inputs) {
          await appendConnectOrCreate(
            driver,
            state,
            ctx,
            relationInfo,
            input,
            parentData,
            true
          );
        }
        break;

      case "disconnect":
        appendRelationDisconnect(
          state,
          ctx,
          relationInfo,
          step.input,
          parentData
        );
        break;

      case "delete":
        appendRelationDelete(state, ctx, relationInfo, step.input, parentData);
        break;

      case "set":
        appendRelationSet(state, ctx, relationInfo, step.input, parentData);
        break;

      case "update":
        await appendRelationUpdate(
          driver,
          state,
          ctx,
          relationInfo,
          step.input,
          parentData
        );
        break;

      case "updateMany":
        appendRelationUpdateMany(
          state,
          ctx,
          relationInfo,
          step.input,
          parentData
        );
        break;

      case "deleteMany":
        appendRelationDeleteMany(
          state,
          ctx,
          relationInfo,
          step.input,
          parentData
        );
        break;

      case "upsert":
        await appendRelationUpsert(
          driver,
          state,
          ctx,
          relationInfo,
          step.input,
          parentData
        );
        break;
    }
  }
}

function throwUnsupportedNestedCreate(relationName: string): never {
  throw new NestedWriteError(
    `Unsupported nested create operation on relation '${relationName}'.`,
    relationName
  );
}

async function appendRelationCreate(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  createData: Record<string, unknown>,
  parentData: Record<string, unknown>
): Promise<void> {
  const fkDir = getFkDirection(ctx, relationInfo);
  const childData = { ...createData };

  if (!fkDir.holdsFK) {
    assignRelatedFkValues(ctx, relationInfo, childData, parentData);
    await appendCreateRecord(
      driver,
      state,
      createChildContext(ctx, relationInfo.targetModel, ctx.nextAlias()),
      childData
    );
    return;
  }

  const created = await appendCreateRecord(
    driver,
    state,
    createChildContext(ctx, relationInfo.targetModel, ctx.nextAlias()),
    childData
  );
  const assignments = buildCurrentFkAssignments(
    ctx,
    relationInfo,
    created.primaryKey
  );
  state.statements.push(updateCurrentRecord(ctx, assignments, parentData));
}

function appendRelationCreateMany(
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  createMany: CreateManyInput,
  parentData: Record<string, unknown>
): void {
  const fkDir = getFkDirection(ctx, relationInfo);
  if (fkDir.holdsFK) {
    throw new NestedWriteError(
      `Cannot use createMany for relation '${relationInfo.name}' - createMany is only supported for to-many relations where the related model holds the FK.`,
      relationInfo.name
    );
  }

  if (!createMany.data.length) {
    return;
  }

  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const rows = createMany.data.map((record) => {
    const row = { ...record };
    assignRelatedFkValues(ctx, relationInfo, row, parentData);
    return row;
  });
  const { columns, values } = buildValues(childCtx, rows);
  const table = ctx.adapter.identifiers.escape(
    getTableName(relationInfo.targetModel)
  );
  let insertSql = ctx.adapter.mutations.insert(table, columns, values);
  if (createMany.skipDuplicates) {
    const { prefix, suffix } = ctx.adapter.mutations.skipDuplicates();
    insertSql = ctx.adapter.mutations.insert(table, columns, values, prefix);
    insertSql = sql`${insertSql} ${suffix}`;
  }
  state.statements.push(insertSql);
}

async function appendConnectOrCreate(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  input: ConnectOrCreateInput,
  parentData: Record<string, unknown>,
  updateCurrentRecordAfterCreate: boolean
): Promise<Record<string, BatchResolvableValue> | undefined> {
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const existing = await fetchOptionalUniqueRecord(
    driver,
    childCtx,
    relationInfo.targetModel,
    input.where
  );
  const fkDir = getFkDirection(ctx, relationInfo);

  if (existing) {
    appendAssertUniqueExists(state, ctx, relationInfo.targetModel, input.where);
    if (!fkDir.holdsFK) {
      appendRelationConnect(state, ctx, relationInfo, input.where, parentData);
      return existing;
    }

    if (updateCurrentRecordAfterCreate) {
      const assignments = buildCurrentFkAssignments(
        ctx,
        relationInfo,
        existing
      );
      state.statements.push(updateCurrentRecord(ctx, assignments, parentData));
    }
    return existing;
  }

  appendAssertUniqueMissing(state, ctx, relationInfo.targetModel, input.where);
  const childData = { ...input.create };
  if (!fkDir.holdsFK) {
    assignRelatedFkValues(ctx, relationInfo, childData, parentData);
  }

  const created = await appendCreateRecord(driver, state, childCtx, childData);

  if (!fkDir.holdsFK) {
    return created.primaryKey;
  }

  if (updateCurrentRecordAfterCreate) {
    const assignments = buildCurrentFkAssignments(
      ctx,
      relationInfo,
      created.primaryKey
    );
    state.statements.push(updateCurrentRecord(ctx, assignments, parentData));
  }
  return created.primaryKey;
}

async function appendRelationUpdate(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  updateInput:
    | Record<string, unknown>
    | NestedUpdateInput
    | NestedUpdateInput[],
  parentData: Record<string, unknown>
): Promise<void> {
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const fkDir = getFkDirection(ctx, relationInfo);
  const inputs: Array<{
    where?: Record<string, unknown>;
    data: Record<string, unknown>;
  }> = relationInfo.isToOne
    ? [{ data: updateInput as Record<string, unknown> }]
    : normalizeNestedUpdateInputs(
        updateInput as NestedUpdateInput | NestedUpdateInput[]
      );

  for (const input of inputs) {
    const whereClause = relationInfo.isToOne
      ? buildFkMatchCondition(ctx, fkDir, relationInfo.targetModel, parentData)
      : combineWithParentCorrelation(
          ctx,
          fkDir,
          relationInfo.targetModel,
          buildWhereUnique(
            childCtx,
            input.where!,
            getTableName(relationInfo.targetModel)
          ),
          parentData
        );

    await appendCorrelatedChildUpdate(
      driver,
      state,
      ctx,
      childCtx,
      relationInfo,
      input.data,
      whereClause
    );
  }
}

/**
 * Plan a nested update of a single child row matched by an
 * already-correlated where clause: assert it exists, update scalars (tracking
 * PK updates), and recurse into nested relation writes.
 */
export async function appendCorrelatedChildUpdate(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  childCtx: QueryContext,
  relationInfo: RelationInfo,
  data: Record<string, unknown>,
  whereClause: Sql
): Promise<void> {
  const { scalarData, relations } = separateData(childCtx, data);
  assertNestedUpdatePlanIsExecutable(childCtx, relations);

  appendAssertWhereExists(state, ctx, relationInfo.targetModel, whereClause);
  const needsUpdatedPrimaryKey =
    hasPrimaryKeyUpdate(childCtx.model, scalarData) ||
    Object.keys(relations).length > 0;
  const childRecord = needsUpdatedPrimaryKey
    ? await fetchRequiredWhereRecord(
        driver,
        childCtx,
        relationInfo.targetModel,
        whereClause,
        {
          relationName: relationInfo.name,
          operation: "update",
          kind: "correlated",
        }
      )
    : undefined;
  const updatedRecord = childRecord
    ? getBatchUpdatedPrimaryKeyRef(
        state,
        childCtx,
        childRecord,
        scalarData,
        "update"
      )
    : undefined;

  if (Object.keys(scalarData).length > 0) {
    const setSql = buildSet(childCtx, scalarData);
    state.statements.push(
      ctx.adapter.mutations.update(
        ctx.adapter.identifiers.escape(getTableName(relationInfo.targetModel)),
        setSql,
        whereClause
      )
    );
    if (updatedRecord) {
      appendUpdatedPrimaryKeyStores(state, childCtx, updatedRecord);
    }
  }

  if (Object.keys(relations).length > 0) {
    if (!(updatedRecord && childRecord)) {
      throw new NestedWriteError(
        `Cannot update relation '${relationInfo.name}': updated record state was not available.`,
        relationInfo.name
      );
    }

    const updatedChildData = {
      ...childRecord,
      ...updatedRecord.primaryKey,
    };
    for (const [childRelationName, childMutation] of Object.entries(
      relations
    )) {
      await appendRelationMutation(
        driver,
        state,
        childCtx,
        childRelationName,
        childMutation,
        updatedChildData
      );
    }
  }
}

function appendRelationUpdateMany(
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  updateManyInput: NestedUpdateManyInput | NestedUpdateManyInput[],
  parentData: Record<string, unknown>
): void {
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  for (const input of normalizeNestedUpdateManyInputs(updateManyInput)) {
    const { scalarData, relations } = separateData(childCtx, input.data);
    assertUpdateManyDataHasNoRelations(relationInfo.name, relations);
    const setSql = buildSet(childCtx, scalarData);
    const whereClause = buildManyWhere(
      ctx,
      childCtx,
      relationInfo,
      input.where,
      parentData
    );
    state.statements.push(
      ctx.adapter.mutations.update(
        ctx.adapter.identifiers.escape(getTableName(relationInfo.targetModel)),
        setSql,
        whereClause
      )
    );
  }
}

function appendRelationDeleteMany(
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  deleteManyInput: Record<string, unknown> | Record<string, unknown>[],
  parentData: Record<string, unknown>
): void {
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  for (const input of normalizeRecordArray(deleteManyInput)) {
    const whereClause = buildManyWhere(
      ctx,
      childCtx,
      relationInfo,
      input,
      parentData
    );
    state.statements.push(
      ctx.adapter.mutations.delete(
        ctx.adapter.identifiers.escape(getTableName(relationInfo.targetModel)),
        whereClause
      )
    );
  }
}

async function appendRelationUpsert(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  upsertInput: NestedUpsertInput | NestedUpsertInput[],
  parentData: Record<string, unknown>
): Promise<void> {
  const inputs = relationInfo.isToOne
    ? [upsertInput as NestedUpsertInput]
    : (upsertInput as NestedUpsertInput[]);
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const fkDir = getFkDirection(ctx, relationInfo);

  for (const input of inputs) {
    const whereClause = relationInfo.isToOne
      ? buildFkMatchCondition(ctx, fkDir, relationInfo.targetModel, parentData)
      : combineWithParentCorrelation(
          ctx,
          fkDir,
          relationInfo.targetModel,
          buildWhereUnique(
            childCtx,
            input.where!,
            getTableName(relationInfo.targetModel)
          ),
          parentData
        );
    const current = await fetchOptionalWhereRecord(
      driver,
      childCtx,
      relationInfo.targetModel,
      whereClause
    );

    if (current) {
      appendAssertWhereExists(
        state,
        ctx,
        relationInfo.targetModel,
        whereClause
      );
      await appendRelationUpdate(
        driver,
        state,
        ctx,
        relationInfo,
        relationInfo.isToOne
          ? input.update
          : { where: input.where!, data: input.update },
        parentData
      );
      continue;
    }

    if (!relationInfo.isToOne) {
      const uncorrelated = await fetchOptionalUniqueRecord(
        driver,
        childCtx,
        relationInfo.targetModel,
        input.where!
      );
      if (uncorrelated) {
        throw new NestedWriteError(
          `Cannot upsert relation '${relationInfo.name}': target record was not found for this parent.`,
          relationInfo.name,
          { meta: { operation: "upsert" } }
        );
      }
      appendAssertUniqueMissing(
        state,
        childCtx,
        relationInfo.targetModel,
        input.where!
      );
    }

    await appendRelationCreate(
      driver,
      state,
      ctx,
      relationInfo,
      input.create,
      parentData
    );
  }
}

function buildManyWhere(
  ctx: QueryContext,
  childCtx: QueryContext,
  relationInfo: RelationInfo,
  where: Record<string, unknown> | undefined,
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
    where,
    targetTable
  );
  return childWhere
    ? ctx.adapter.operators.and(parentWhere, childWhere)
    : parentWhere;
}
