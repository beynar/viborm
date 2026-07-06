import type { AnyDriver } from "@drivers";
import { type Sql, sql } from "@sql";
import {
  buildJunctionInsert,
  buildJunctionMembership,
  buildJunctionParentValue,
  buildJunctionSourceMatch,
  buildJunctionTargetIn,
  buildJunctionTargetValue,
  buildTargetPkSubquery,
  getManyToManyJoinInfo,
  type ManyToManyJoinInfo,
} from "../../builders/many-to-many-utils";
import {
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import { buildSet } from "../../builders/set-builder";
import { buildScalarSqlValue } from "../../builders/values-builder";
import { buildWhere } from "../../builders/where-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import { executeNestedCreate, type TransactionContext } from "./create";
import {
  buildSelectOneSql,
  fetchOptionalUniqueRecord,
  fetchRequiredUniqueRecord,
} from "./record-access";
import {
  assertManyToManyStepCombinationIsSupported,
  type NestedWriteTiming,
  normalizeArray,
  normalizeRecordArray,
  planRelationMutationSteps,
} from "./semantic-plan";
import { executeSingleRelationUpdate } from "./update";
import {
  assertUpdateManyDataHasNoRelations,
  normalizeNestedUpdateInputs,
  normalizeNestedUpdateManyInputs,
} from "./update-plan";

/**
 * Transaction-engine executor for nested writes on many-to-many relations.
 * All association changes go through junction table rows; child rows are
 * only touched by create/delete/deleteMany.
 */
export async function processManyToManyMutation(
  tx: AnyDriver,
  ctx: QueryContext,
  relationName: string,
  mutation: RelationMutation,
  timing: NestedWriteTiming,
  parentData: Record<string, unknown>,
  txCtx: TransactionContext
): Promise<void> {
  // Junction rows reference the parent row, so nothing runs before it exists.
  if (timing !== "after") {
    return;
  }

  const { relationInfo } = mutation;
  assertManyToManyStepCombinationIsSupported(relationName, mutation);
  const joinInfo = getManyToManyJoinInfo(ctx, relationInfo);
  const parentValue = buildJunctionParentValue(
    ctx,
    joinInfo,
    parentData,
    relationName
  );

  for (const step of planRelationMutationSteps(
    relationName,
    mutation,
    timing
  )) {
    switch (step.kind) {
      case "create": {
        const createdRecords: Record<string, unknown>[] = [];
        for (const createData of step.inputs) {
          createdRecords.push(
            await createChildWithJunctionRow(
              tx,
              ctx,
              relationInfo,
              joinInfo,
              createData,
              parentValue,
              relationName
            )
          );
        }
        appendCreatedRecords(txCtx, relationName, createdRecords);
        break;
      }

      case "connect": {
        for (const connectInput of step.inputs) {
          const target = await fetchRequiredUniqueRecord(
            tx,
            ctx,
            relationInfo.targetModel,
            connectInput,
            { relationName, operation: "connect", kind: "target" }
          );
          await insertJunctionRow(
            tx,
            ctx,
            relationInfo,
            joinInfo,
            target,
            parentValue,
            relationName
          );
        }
        break;
      }

      case "connectOrCreate": {
        const records: Record<string, unknown>[] = [];
        for (const input of step.inputs) {
          const existing = await fetchOptionalUniqueRecord(
            tx,
            ctx,
            relationInfo.targetModel,
            input.where
          );
          if (existing) {
            await insertJunctionRow(
              tx,
              ctx,
              relationInfo,
              joinInfo,
              existing,
              parentValue,
              relationName
            );
          } else {
            records.push(
              await createChildWithJunctionRow(
                tx,
                ctx,
                relationInfo,
                joinInfo,
                input.create,
                parentValue,
                relationName
              )
            );
          }
        }
        appendCreatedRecords(txCtx, relationName, records);
        break;
      }

      case "disconnect": {
        const junctionTable = ctx.adapter.identifiers.escape(
          joinInfo.junctionTableName
        );
        const sourceMatch = buildJunctionSourceMatch(
          ctx,
          joinInfo,
          parentValue
        );
        if (step.input === true) {
          await tx._execute(
            ctx.adapter.mutations.delete(junctionTable, sourceMatch)
          );
          break;
        }
        for (const item of normalizeRecordArray(
          step.input as Record<string, unknown> | Record<string, unknown>[]
        )) {
          const targetIn = buildJunctionTargetIn(
            ctx,
            joinInfo,
            buildTargetPkSubquery(ctx, relationInfo, joinInfo, item)
          );
          await tx._execute(
            ctx.adapter.mutations.delete(
              junctionTable,
              ctx.adapter.operators.and(sourceMatch, targetIn)
            )
          );
        }
        break;
      }

      case "set": {
        // Resolve every target first so a missing record aborts before any
        // junction row is touched.
        const targets: Record<string, unknown>[] = [];
        for (const item of step.input) {
          targets.push(
            await fetchRequiredUniqueRecord(
              tx,
              ctx,
              relationInfo.targetModel,
              item,
              {
                relationName,
                operation: "set",
                kind: "target",
              }
            )
          );
        }
        await tx._execute(
          ctx.adapter.mutations.delete(
            ctx.adapter.identifiers.escape(joinInfo.junctionTableName),
            buildJunctionSourceMatch(ctx, joinInfo, parentValue)
          )
        );
        for (const target of targets) {
          await insertJunctionRow(
            tx,
            ctx,
            relationInfo,
            joinInfo,
            target,
            parentValue,
            relationName
          );
        }
        break;
      }

      case "delete": {
        if (step.input === true) {
          const pks = await fetchConnectedTargetPks(
            tx,
            ctx,
            relationInfo,
            joinInfo,
            parentValue,
            undefined
          );
          await deleteChildrenAndJunctionRows(
            tx,
            ctx,
            relationInfo,
            joinInfo,
            pks
          );
          break;
        }
        for (const item of normalizeRecordArray(
          step.input as Record<string, unknown> | Record<string, unknown>[]
        )) {
          const childCtx = createChildContext(
            ctx,
            relationInfo.targetModel,
            ctx.nextAlias()
          );
          const uniqueWhere = buildWhereUnique(
            childCtx,
            item,
            joinInfo.targetTableName
          );
          const pks = await fetchConnectedTargetPks(
            tx,
            ctx,
            relationInfo,
            joinInfo,
            parentValue,
            uniqueWhere
          );
          if (pks.length === 0) {
            throw new NestedWriteError(
              `Cannot delete relation '${relationName}': target record was not found for this parent.`,
              relationName
            );
          }
          await deleteChildrenAndJunctionRows(
            tx,
            ctx,
            relationInfo,
            joinInfo,
            pks
          );
        }
        break;
      }

      case "deleteMany": {
        for (const input of normalizeRecordArray(step.input)) {
          const childCtx = createChildContext(
            ctx,
            relationInfo.targetModel,
            ctx.nextAlias()
          );
          const filterWhere = buildWhere(
            { ...childCtx, mutationTable: joinInfo.targetTableName },
            input,
            joinInfo.targetTableName
          );
          const pks = await fetchConnectedTargetPks(
            tx,
            ctx,
            relationInfo,
            joinInfo,
            parentValue,
            filterWhere
          );
          await deleteChildrenAndJunctionRows(
            tx,
            ctx,
            relationInfo,
            joinInfo,
            pks
          );
        }
        break;
      }

      case "update": {
        for (const input of normalizeNestedUpdateInputs(step.input)) {
          const childCtx = createChildContext(
            ctx,
            relationInfo.targetModel,
            ctx.nextAlias()
          );
          await executeSingleRelationUpdate(
            tx,
            childCtx,
            relationInfo,
            input.data,
            buildConnectedUniqueWhere(
              ctx,
              childCtx,
              joinInfo,
              parentValue,
              input.where
            )
          );
        }
        break;
      }

      case "updateMany": {
        for (const input of normalizeNestedUpdateManyInputs(step.input)) {
          const childCtx = createChildContext(
            ctx,
            relationInfo.targetModel,
            ctx.nextAlias()
          );
          const { scalarData, relations } = separateData(childCtx, input.data);
          assertUpdateManyDataHasNoRelations(relationName, relations);
          const membership = buildJunctionMembership(
            ctx,
            joinInfo,
            parentValue,
            joinInfo.targetTableName
          );
          const filterWhere = buildWhere(
            { ...childCtx, mutationTable: joinInfo.targetTableName },
            input.where,
            joinInfo.targetTableName
          );
          await tx._execute(
            ctx.adapter.mutations.update(
              ctx.adapter.identifiers.escape(joinInfo.targetTableName),
              buildSet(childCtx, scalarData),
              filterWhere
                ? ctx.adapter.operators.and(membership, filterWhere)
                : membership
            )
          );
        }
        break;
      }

      case "upsert": {
        const upserted: Record<string, unknown>[] = [];
        for (const input of normalizeArray(step.input)) {
          if (!input.where) {
            throw new NestedWriteError(
              `Nested operation 'upsert' on many-to-many relation '${relationName}' requires 'where'.`,
              relationName,
              { meta: { operation: "upsert", field: "where" } }
            );
          }
          const childCtx = createChildContext(
            ctx,
            relationInfo.targetModel,
            ctx.nextAlias()
          );
          const whereClause = buildConnectedUniqueWhere(
            ctx,
            childCtx,
            joinInfo,
            parentValue,
            input.where
          );
          const connected = await tx._execute<Record<string, unknown>>(
            buildSelectOneSql(childCtx, relationInfo.targetModel, whereClause)
          );
          if (connected.rows[0]) {
            await executeSingleRelationUpdate(
              tx,
              childCtx,
              relationInfo,
              input.update,
              whereClause
            );
            continue;
          }
          const existing = await fetchOptionalUniqueRecord(
            tx,
            ctx,
            relationInfo.targetModel,
            input.where
          );
          if (existing) {
            throw new NestedWriteError(
              `Cannot upsert relation '${relationName}': target record was not found for this parent.`,
              relationName,
              { meta: { operation: "upsert" } }
            );
          }
          upserted.push(
            await createChildWithJunctionRow(
              tx,
              ctx,
              relationInfo,
              joinInfo,
              input.create,
              parentValue,
              relationName
            )
          );
        }
        appendCreatedRecords(txCtx, relationName, upserted);
        break;
      }

      default:
        throw new NestedWriteError(
          `Nested operation '${step.kind}' is not supported for many-to-many relation '${relationName}'.`,
          relationName,
          { meta: { operation: step.kind } }
        );
    }
  }
}

/**
 * Where-unique on the target table, additionally scoped to rows connected to
 * this parent through the junction.
 */
export function buildConnectedUniqueWhere(
  ctx: QueryContext,
  childCtx: QueryContext,
  joinInfo: ManyToManyJoinInfo,
  parentValue: Sql,
  whereUnique: Record<string, unknown>
): Sql {
  return ctx.adapter.operators.and(
    buildWhereUnique(childCtx, whereUnique, joinInfo.targetTableName),
    buildJunctionMembership(
      ctx,
      joinInfo,
      parentValue,
      joinInfo.targetTableName
    )
  );
}

async function createChildWithJunctionRow(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  createData: Record<string, unknown>,
  parentValue: Sql,
  relationName: string
): Promise<Record<string, unknown>> {
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const { record } = await executeNestedCreate(tx, childCtx, createData);
  await insertJunctionRow(
    tx,
    ctx,
    relationInfo,
    joinInfo,
    record,
    parentValue,
    relationName
  );
  return record;
}

async function insertJunctionRow(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  targetRecord: Record<string, unknown>,
  parentValue: Sql,
  relationName: string
): Promise<void> {
  const targetValue = buildJunctionTargetValue(
    ctx,
    relationInfo,
    joinInfo,
    targetRecord,
    relationName
  );
  await tx._execute(
    buildJunctionInsert(ctx, joinInfo, parentValue, targetValue)
  );
}

/**
 * Resolve PK values of target rows connected to the parent, optionally
 * restricted by an extra condition on the target table.
 */
export async function fetchConnectedTargetPks(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  parentValue: Sql,
  extraWhere: Sql | undefined
): Promise<Sql[]> {
  const { adapter } = ctx;
  const membership = buildJunctionMembership(
    ctx,
    joinInfo,
    parentValue,
    joinInfo.targetTableName
  );
  const whereClause = extraWhere
    ? adapter.operators.and(membership, extraWhere)
    : membership;
  const pkCol = adapter.identifiers.column(
    joinInfo.targetTableName,
    joinInfo.targetPkColumn
  );
  const selectSql = sql.join(
    [
      adapter.clauses.select(pkCol),
      adapter.clauses.from(
        adapter.identifiers.escape(joinInfo.targetTableName)
      ),
      adapter.clauses.where(whereClause),
    ],
    " "
  );
  const result = await tx._execute<Record<string, unknown>>(selectSql);
  return result.rows.map((row) =>
    buildScalarSqlValue(
      ctx,
      relationInfo.targetModel,
      joinInfo.targetPkField,
      row[joinInfo.targetPkColumn] ?? row[joinInfo.targetPkField]
    )
  );
}

/**
 * Delete child rows and every junction row pointing at them (from any
 * parent — the child ceases to exist). Junction rows go first so the child
 * delete cannot trip FK constraints. On self-referential relations the child
 * may also be the source of junction rows; those go too.
 */
async function deleteChildrenAndJunctionRows(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  pks: Sql[]
): Promise<void> {
  if (pks.length === 0) {
    return;
  }
  const { adapter } = ctx;
  const pkList = sql`(${sql.join(pks, ", ")})`;

  let junctionWhere = buildJunctionTargetIn(ctx, joinInfo, pkList);
  if (relationInfo.targetModel === ctx.model) {
    junctionWhere = adapter.operators.or(
      junctionWhere,
      adapter.operators.in(
        adapter.identifiers.escape(joinInfo.sourceFieldName),
        pkList
      )
    );
  }
  await tx._execute(
    adapter.mutations.delete(
      adapter.identifiers.escape(joinInfo.junctionTableName),
      junctionWhere
    )
  );
  await tx._execute(
    adapter.mutations.delete(
      adapter.identifiers.escape(joinInfo.targetTableName),
      adapter.operators.in(
        adapter.identifiers.escape(joinInfo.targetPkColumn),
        pkList
      )
    )
  );
}

function appendCreatedRecords(
  txCtx: TransactionContext,
  relationName: string,
  records: Record<string, unknown>[]
): void {
  if (records.length === 0) {
    return;
  }
  const existing = txCtx.createdRecords.get(relationName);
  txCtx.createdRecords.set(
    relationName,
    Array.isArray(existing) ? [...existing, ...records] : records
  );
}
