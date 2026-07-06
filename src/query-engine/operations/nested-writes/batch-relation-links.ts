import { type Sql, sql } from "@sql";
import { getFkDirection } from "../../builders/relation-data-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext, getTableName } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import {
  appendAssertUniqueExists,
  appendAssertWhereExists,
  appendAssertWhereMissing,
  assertFkCanBeSetNull,
  getNonNullableFkFields,
} from "./assertions";
import type { PlanState } from "./batch-references";
import {
  buildCurrentFkAssignmentsFromConnect,
  buildCurrentRecordMatchCondition,
  buildFkMatchCondition,
  buildFkNullAssignments,
  buildFkValueAssignments,
  combineWithParentCorrelation,
  updateCurrentRecord,
} from "./fk";
import { normalizeRecordArray } from "./semantic-plan";
import { buildDepartingRowsCondition } from "./set";

export function appendRelationConnect(
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>,
  parentData: Record<string, unknown>
): void {
  const fkDir = getFkDirection(ctx, relationInfo);
  appendAssertUniqueExists(state, ctx, relationInfo.targetModel, connectInput);

  if (fkDir.holdsFK) {
    const assignments = buildCurrentFkAssignmentsFromConnect(
      ctx,
      relationInfo,
      connectInput
    );
    state.statements.push(updateCurrentRecord(ctx, assignments, parentData));
    return;
  }

  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const whereClause = buildWhereUnique(
    childCtx,
    connectInput,
    getTableName(relationInfo.targetModel)
  );
  const setSql = sql.join(
    buildFkValueAssignments(ctx, fkDir, relationInfo.targetModel, parentData),
    ", "
  );
  const table = ctx.adapter.identifiers.escape(
    getTableName(relationInfo.targetModel)
  );
  state.statements.push(
    ctx.adapter.mutations.update(table, setSql, whereClause)
  );
}

export function appendRelationDisconnect(
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  disconnectInput:
    | boolean
    | Record<string, unknown>
    | Record<string, unknown>[],
  parentData: Record<string, unknown>
): void {
  const fkDir = getFkDirection(ctx, relationInfo);
  assertFkCanBeSetNull(relationInfo.name, fkDir);

  if (fkDir.holdsFK) {
    const setSql = sql.join(
      buildFkNullAssignments(ctx, fkDir, ctx.model),
      ", "
    );
    state.statements.push(
      ctx.adapter.mutations.update(
        ctx.adapter.identifiers.escape(getTableName(ctx.model)),
        setSql,
        buildCurrentRecordMatchCondition(ctx, parentData)
      )
    );
    return;
  }

  const whereClause = buildRelationTargetWhere(
    state,
    ctx,
    relationInfo,
    disconnectInput,
    parentData,
    true
  );
  const setSql = sql.join(
    buildFkNullAssignments(ctx, fkDir, relationInfo.targetModel),
    ", "
  );
  state.statements.push(
    ctx.adapter.mutations.update(
      ctx.adapter.identifiers.escape(getTableName(relationInfo.targetModel)),
      setSql,
      whereClause
    )
  );
}

export function appendRelationDelete(
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  deleteInput: boolean | Record<string, unknown> | Record<string, unknown>[],
  parentData: Record<string, unknown>
): void {
  const whereClause = buildRelationTargetWhere(
    state,
    ctx,
    relationInfo,
    deleteInput,
    parentData,
    true
  );
  state.statements.push(
    ctx.adapter.mutations.delete(
      ctx.adapter.identifiers.escape(getTableName(relationInfo.targetModel)),
      whereClause
    )
  );
}

export function appendRelationSet(
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  setInput: Record<string, unknown>[],
  parentData: Record<string, unknown>
): void {
  const fkDir = getFkDirection(ctx, relationInfo);
  if (fkDir.holdsFK) {
    throw new NestedWriteError(
      `Nested operation 'set' is not supported for to-one relation '${relationInfo.name}'.`,
      relationInfo.name,
      { meta: { operation: "set" } }
    );
  }

  for (const input of setInput) {
    appendAssertUniqueExists(state, ctx, relationInfo.targetModel, input);
  }

  // Only rows connected to the parent but NOT in the new set leave the
  // relation; rows staying connected are never disconnected.
  const childCtx = createChildContext(
    ctx,
    relationInfo.targetModel,
    ctx.nextAlias()
  );
  const departingWhere = buildDepartingRowsCondition(
    ctx,
    fkDir,
    relationInfo,
    setInput,
    parentData,
    childCtx
  );

  if (getNonNullableFkFields(fkDir).length > 0) {
    // Required FK: abort the batch only when rows would actually leave the
    // set and be orphaned — a no-op set succeeds (matches the tx engine).
    appendAssertWhereMissing(
      state,
      ctx,
      relationInfo.targetModel,
      departingWhere
    );
  } else {
    const setSql = sql.join(
      buildFkNullAssignments(ctx, fkDir, relationInfo.targetModel),
      ", "
    );
    state.statements.push(
      ctx.adapter.mutations.update(
        ctx.adapter.identifiers.escape(getTableName(relationInfo.targetModel)),
        setSql,
        departingWhere
      )
    );
  }

  for (const input of setInput) {
    appendRelationConnect(state, ctx, relationInfo, input, parentData);
  }
}

function buildRelationTargetWhere(
  state: PlanState,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  input: boolean | Record<string, unknown> | Record<string, unknown>[],
  parentData: Record<string, unknown>,
  requireRows: boolean
): Sql {
  const fkDir = getFkDirection(ctx, relationInfo);
  let whereClause: Sql;

  if (input === true) {
    whereClause = buildFkMatchCondition(
      ctx,
      fkDir,
      relationInfo.targetModel,
      parentData
    );
  } else if (input === false) {
    throw new NestedWriteError(
      `Invalid nested relation input for relation '${relationInfo.name}'.`,
      relationInfo.name
    );
  } else {
    const childCtx = createChildContext(
      ctx,
      relationInfo.targetModel,
      ctx.nextAlias()
    );
    const conditions = normalizeRecordArray(input).map((entry) =>
      buildWhereUnique(childCtx, entry, getTableName(relationInfo.targetModel))
    );
    const targetWhere =
      conditions.length === 1
        ? conditions[0]!
        : ctx.adapter.operators.or(...conditions);
    whereClause = combineWithParentCorrelation(
      ctx,
      fkDir,
      relationInfo.targetModel,
      targetWhere,
      parentData
    );
  }

  if (requireRows && input !== true) {
    appendAssertWhereExists(state, ctx, relationInfo.targetModel, whereClause);
  }

  return whereClause;
}
