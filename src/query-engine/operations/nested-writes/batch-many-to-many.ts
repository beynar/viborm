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
import { buildWhere } from "../../builders/where-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import {
  appendAssertUniqueExists,
  appendAssertUniqueMissing,
} from "./assertions";
import { appendCreateRecord } from "./batch-plan";
import type { PlanState } from "./batch-references";
import { isBatchValueRef } from "./batch-references";
import { appendCorrelatedChildUpdate } from "./batch-relations";
import {
  buildConnectedUniqueWhere,
  fetchConnectedTargetPks,
} from "./many-to-many";
import {
  fetchOptionalUniqueRecord,
  fetchOptionalWhereRecord,
} from "./record-access";
import {
  assertManyToManyStepCombinationIsSupported,
  normalizeArray,
  normalizeRecordArray,
  planRelationMutationSteps,
} from "./semantic-plan";
import {
  assertUpdateManyDataHasNoRelations,
  normalizeNestedUpdateInputs,
  normalizeNestedUpdateManyInputs,
} from "./update-plan";

/**
 * Batch-engine planner for nested writes on many-to-many relations.
 * Mirrors processManyToManyMutation but emits plan statements instead of
 * executing; where a value is only known at execution time it uses scalar
 * subqueries and batch assertions.
 */
export async function appendManyToManyMutation(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  relationName: string,
  mutation: RelationMutation,
  parentData: Record<string, unknown>
): Promise<void> {
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
    "after"
  )) {
    switch (step.kind) {
      case "create":
        for (const createData of step.inputs) {
          await appendChildCreateWithJunctionRow(
            driver,
            state,
            ctx,
            relationInfo,
            joinInfo,
            createData,
            parentValue,
            relationName
          );
        }
        break;

      case "connect":
        for (const connectInput of step.inputs) {
          appendAssertUniqueExists(
            state,
            ctx,
            relationInfo.targetModel,
            connectInput
          );
          state.statements.push(
            buildJunctionInsert(
              ctx,
              joinInfo,
              parentValue,
              buildTargetPkSubquery(ctx, relationInfo, joinInfo, connectInput)
            )
          );
        }
        break;

      case "connectOrCreate":
        for (const input of step.inputs) {
          const existing = await fetchOptionalUniqueRecord(
            driver,
            ctx,
            relationInfo.targetModel,
            input.where
          );
          if (existing) {
            appendAssertUniqueExists(
              state,
              ctx,
              relationInfo.targetModel,
              input.where
            );
            state.statements.push(
              buildJunctionInsert(
                ctx,
                joinInfo,
                parentValue,
                buildTargetPkSubquery(ctx, relationInfo, joinInfo, input.where)
              )
            );
          } else {
            appendAssertUniqueMissing(
              state,
              ctx,
              relationInfo.targetModel,
              input.where
            );
            await appendChildCreateWithJunctionRow(
              driver,
              state,
              ctx,
              relationInfo,
              joinInfo,
              input.create,
              parentValue,
              relationName
            );
          }
        }
        break;

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
          state.statements.push(
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
          state.statements.push(
            ctx.adapter.mutations.delete(
              junctionTable,
              ctx.adapter.operators.and(sourceMatch, targetIn)
            )
          );
        }
        break;
      }

      case "set":
        state.statements.push(
          ctx.adapter.mutations.delete(
            ctx.adapter.identifiers.escape(joinInfo.junctionTableName),
            buildJunctionSourceMatch(ctx, joinInfo, parentValue)
          )
        );
        for (const item of step.input) {
          appendAssertUniqueExists(state, ctx, relationInfo.targetModel, item);
          state.statements.push(
            buildJunctionInsert(
              ctx,
              joinInfo,
              parentValue,
              buildTargetPkSubquery(ctx, relationInfo, joinInfo, item)
            )
          );
        }
        break;

      case "delete": {
        if (step.input === true) {
          // Delete-all-connected needs the target set resolved while the
          // junction rows still exist — same shape as an unfiltered deleteMany.
          await appendJunctionDeleteMany(
            driver,
            state,
            ctx,
            relationInfo,
            joinInfo,
            parentData,
            parentValue,
            {},
            relationName
          );
          break;
        }
        for (const item of normalizeRecordArray(
          step.input as Record<string, unknown> | Record<string, unknown>[]
        )) {
          appendJunctionDelete(
            state,
            ctx,
            relationInfo,
            joinInfo,
            parentValue,
            item
          );
        }
        break;
      }

      case "deleteMany":
        for (const input of normalizeRecordArray(step.input)) {
          await appendJunctionDeleteMany(
            driver,
            state,
            ctx,
            relationInfo,
            joinInfo,
            parentData,
            parentValue,
            input,
            relationName
          );
        }
        break;

      case "update":
        for (const input of normalizeNestedUpdateInputs(step.input)) {
          const childCtx = createChildContext(
            ctx,
            relationInfo.targetModel,
            ctx.nextAlias()
          );
          await appendCorrelatedChildUpdate(
            driver,
            state,
            ctx,
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

      case "updateMany":
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
          state.statements.push(
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

      case "upsert":
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
          const connected = await fetchOptionalWhereRecord(
            driver,
            childCtx,
            relationInfo.targetModel,
            whereClause
          );
          if (connected) {
            await appendCorrelatedChildUpdate(
              driver,
              state,
              ctx,
              childCtx,
              relationInfo,
              input.update,
              whereClause
            );
            continue;
          }
          const uncorrelated = await fetchOptionalUniqueRecord(
            driver,
            ctx,
            relationInfo.targetModel,
            input.where
          );
          if (uncorrelated) {
            throw new NestedWriteError(
              `Cannot upsert relation '${relationName}': target record was not found for this parent.`,
              relationName,
              { meta: { operation: "upsert" } }
            );
          }
          appendAssertUniqueMissing(
            state,
            ctx,
            relationInfo.targetModel,
            input.where
          );
          await appendChildCreateWithJunctionRow(
            driver,
            state,
            ctx,
            relationInfo,
            joinInfo,
            input.create,
            parentValue,
            relationName
          );
        }
        break;

      default:
        throw new NestedWriteError(
          `Nested operation '${step.kind}' is not supported for many-to-many relation '${relationName}'.`,
          relationName,
          { meta: { operation: step.kind } }
        );
    }
  }
}

async function appendChildCreateWithJunctionRow(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  createData: Record<string, unknown>,
  parentValue: Sql,
  relationName: string
): Promise<void> {
  const created = await appendCreateRecord(
    driver,
    state,
    createChildContext(ctx, relationInfo.targetModel, ctx.nextAlias()),
    { ...createData }
  );
  const targetValue = buildJunctionTargetValue(
    ctx,
    relationInfo,
    joinInfo,
    created.primaryKey,
    relationName
  );
  state.statements.push(
    buildJunctionInsert(ctx, joinInfo, parentValue, targetValue)
  );
}

/**
 * Delete a connected child row matched by a where-unique input: assert it is
 * connected to this parent, then delete junction rows first so the child
 * delete cannot trip FK constraints. The child row is deleted by its own
 * where-unique condition (no subquery on the child table — MySQL rejects a
 * mutation target appearing in its own subquery).
 */
function appendJunctionDelete(
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  parentValue: Sql,
  uniqueInput: Record<string, unknown>
): void {
  const { adapter } = ctx;
  const junctionTable = adapter.identifiers.escape(joinInfo.junctionTableName);
  const sourceMatch = buildJunctionSourceMatch(ctx, joinInfo, parentValue);
  const targetPkSubquery = buildTargetPkSubquery(
    ctx,
    relationInfo,
    joinInfo,
    uniqueInput
  );

  // The batch aborts unless the record is connected to this parent.
  const connectedCheck = sql.join(
    [
      adapter.clauses.select(sql`1`),
      adapter.clauses.from(junctionTable),
      adapter.clauses.where(
        adapter.operators.and(
          sourceMatch,
          buildJunctionTargetIn(ctx, joinInfo, targetPkSubquery)
        )
      ),
      adapter.clauses.limit(adapter.literals.value(1)),
    ],
    " "
  );
  state.statements.push(adapter.assertions.exists(connectedCheck));

  state.statements.push(
    adapter.mutations.delete(
      junctionTable,
      buildJunctionDeleteCondition(
        ctx,
        relationInfo,
        joinInfo,
        targetPkSubquery
      )
    )
  );

  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  state.statements.push(
    adapter.mutations.delete(
      adapter.identifiers.escape(joinInfo.targetTableName),
      buildWhereUnique(childCtx, uniqueInput, joinInfo.targetTableName)
    )
  );
}

async function appendJunctionDeleteMany(
  driver: AnyDriver,
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  parentData: Record<string, unknown>,
  parentValue: Sql,
  filter: Record<string, unknown>,
  relationName: string
): Promise<void> {
  const rawParentPk =
    parentData[joinInfo.sourcePkField] ?? parentData[joinInfo.sourcePkColumn];
  if (isBatchValueRef(rawParentPk)) {
    throw new NestedWriteError(
      `Nested 'deleteMany' on many-to-many relation '${relationName}' requires the parent primary key to be known before execution.`,
      relationName,
      { meta: { operation: "deleteMany" } }
    );
  }

  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const filterWhere = buildWhere(
    { ...childCtx, mutationTable: joinInfo.targetTableName },
    filter,
    joinInfo.targetTableName
  );
  // ponytail: filtered M2M deleteMany resolves matching rows at plan time
  // (the filter can't be evaluated after the junction rows are deleted);
  // rows added between planning and execution are not covered
  const pks = await fetchConnectedTargetPks(
    driver,
    ctx,
    relationInfo,
    joinInfo,
    parentValue,
    filterWhere
  );
  if (pks.length === 0) {
    return;
  }

  const { adapter } = ctx;
  const pkList = sql`(${sql.join(pks, ", ")})`;
  state.statements.push(
    adapter.mutations.delete(
      adapter.identifiers.escape(joinInfo.junctionTableName),
      buildJunctionDeleteCondition(ctx, relationInfo, joinInfo, pkList)
    )
  );
  state.statements.push(
    adapter.mutations.delete(
      adapter.identifiers.escape(joinInfo.targetTableName),
      adapter.operators.in(
        adapter.identifiers.escape(joinInfo.targetPkColumn),
        pkList
      )
    )
  );
}

/**
 * Junction rows referencing deleted children — from any parent, and on
 * self-referential relations also rows where the child is the source.
 */
function buildJunctionDeleteCondition(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  targetPks: Sql
): Sql {
  const condition = buildJunctionTargetIn(ctx, joinInfo, targetPks);
  if (relationInfo.targetModel !== ctx.model) {
    return condition;
  }
  return ctx.adapter.operators.or(
    condition,
    ctx.adapter.operators.in(
      ctx.adapter.identifiers.escape(joinInfo.sourceFieldName),
      targetPks
    )
  );
}
