import type { AnyDriver } from "@drivers";
import type { Model } from "@schema/model";
import { isSql, type Sql, sql } from "@sql";
import { getPrimaryKeyFields } from "../../builders/correlation-utils";
import {
  buildConnectFkValues,
  type FkDirection,
  getFkDirection,
} from "../../builders/relation-data-builder";
import { buildScalarSqlValue } from "../../builders/values-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { getColumnName, getTableName } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import { throwIfNoCorrelatedRowsAffected } from "./assertions";
import { type BatchResolvableValue, isBatchValueRef } from "./batch-references";

export function buildFkMatchCondition(
  ctx: QueryContext,
  fkDir: FkDirection,
  targetModel: Model<any>,
  parentData: Record<string, unknown>
): Sql {
  const { adapter } = ctx;
  const conditions: Sql[] = [];

  if (fkDir.holdsFK) {
    for (let i = 0; i < fkDir.pkFields.length; i++) {
      const pkField = fkDir.pkFields[i]!;
      const fkField = fkDir.fkFields[i]!;
      const pkColumn = getColumnName(targetModel, pkField);
      const column = adapter.identifiers.escape(pkColumn);
      const value = buildScalarSqlValue(
        ctx,
        targetModel,
        pkField,
        parentData[fkField]
      );
      conditions.push(adapter.operators.eq(column, value));
    }
  } else {
    for (let i = 0; i < fkDir.fkFields.length; i++) {
      const fkField = fkDir.fkFields[i]!;
      const pkField = fkDir.pkFields[i]!;
      const fkColumn = getColumnName(targetModel, fkField);
      const column = adapter.identifiers.escape(fkColumn);
      const value = buildScalarSqlValue(
        ctx,
        targetModel,
        fkField,
        parentData[pkField]
      );
      conditions.push(adapter.operators.eq(column, value));
    }
  }

  return conditions.length === 1
    ? conditions[0]!
    : adapter.operators.and(...conditions);
}

export function buildCurrentRecordMatchCondition(
  ctx: QueryContext,
  parentData: Record<string, unknown>
): Sql {
  const { adapter } = ctx;
  const pkFields = getPrimaryKeyFields(ctx.model);
  const conditions = pkFields.map((pkField) => {
    const pkColumn = getColumnName(ctx.model, pkField);
    const column = adapter.identifiers.escape(pkColumn);
    const value = parentData[pkField];

    if (value === undefined || value === null) {
      const modelName = ctx.model["~"].names.ts ?? getTableName(ctx.model);
      throw new NestedWriteError(
        `Cannot execute nested write for model '${modelName}': parent record is missing primary key field '${pkField}'.`,
        modelName
      );
    }

    return adapter.operators.eq(
      column,
      buildScalarSqlValue(ctx, ctx.model, pkField, value)
    );
  });

  return conditions.length === 1
    ? conditions[0]!
    : adapter.operators.and(...conditions);
}

export function combineWithParentCorrelation(
  ctx: QueryContext,
  fkDir: FkDirection,
  targetModel: Model<any>,
  childCondition: Sql,
  parentData: Record<string, unknown>
): Sql {
  const fkCondition = buildFkMatchCondition(
    ctx,
    fkDir,
    targetModel,
    parentData
  );
  return ctx.adapter.operators.and(fkCondition, childCondition);
}

export function assignCurrentFkValuesFromRecord(
  fkDir: FkDirection,
  targetRecord: Record<string, unknown>,
  parentData: Record<string, unknown>,
  relationName: string
): void {
  for (let i = 0; i < fkDir.fkFields.length; i++) {
    const fkField = fkDir.fkFields[i]!;
    const pkField = fkDir.pkFields[i]!;
    parentData[fkField] = getRequiredTargetPkValue(
      fkDir,
      targetRecord,
      pkField,
      relationName
    );
  }
}

export function assignRelatedFkValuesFromParent(
  fkDir: FkDirection,
  targetData: Record<string, unknown>,
  parentData: Record<string, unknown>
): void {
  for (let i = 0; i < fkDir.fkFields.length; i++) {
    const fkField = fkDir.fkFields[i]!;
    const pkField = fkDir.pkFields[i]!;
    targetData[fkField] = parentData[pkField];
  }
}

export function buildCurrentFkValueAssignmentsFromRecord(
  ctx: QueryContext,
  fkDir: FkDirection,
  targetRecord: Record<string, unknown>,
  parentData: Record<string, unknown>,
  relationName: string
): Sql[] {
  const { adapter } = ctx;
  const assignments: Sql[] = [];

  for (let i = 0; i < fkDir.fkFields.length; i++) {
    const fkField = fkDir.fkFields[i]!;
    const pkField = fkDir.pkFields[i]!;
    const fkColumn = getColumnName(ctx.model, fkField);
    const column = adapter.identifiers.escape(fkColumn);
    const value = targetRecord[pkField];

    if (value === undefined) {
      throw new NestedWriteError(
        `Cannot connect relation '${relationName}': target record is missing primary key field '${pkField}'.`,
        relationName
      );
    }

    assignments.push(
      adapter.set.assign(
        column,
        buildScalarSqlValue(ctx, ctx.model, fkField, value)
      )
    );
    parentData[fkField] = value;
  }

  return assignments;
}

export function buildFkNullAssignments(
  ctx: QueryContext,
  fkDir: FkDirection,
  targetModel: Model<any>
): Sql[] {
  const { adapter } = ctx;
  const assignments: Sql[] = [];

  for (const fkField of fkDir.fkFields) {
    const fkColumn = getColumnName(targetModel, fkField);
    const column = adapter.identifiers.escape(fkColumn);
    assignments.push(adapter.set.assign(column, adapter.literals.null()));
  }

  return assignments;
}

export function buildFkValueAssignments(
  ctx: QueryContext,
  fkDir: FkDirection,
  targetModel: Model<any>,
  parentData: Record<string, unknown>
): Sql[] {
  const { adapter } = ctx;
  const assignments: Sql[] = [];

  for (let i = 0; i < fkDir.fkFields.length; i++) {
    const fkField = fkDir.fkFields[i]!;
    const pkField = fkDir.pkFields[i]!;
    const fkColumn = getColumnName(targetModel, fkField);
    const column = adapter.identifiers.escape(fkColumn);
    const value = buildScalarSqlValue(
      ctx,
      targetModel,
      fkField,
      parentData[pkField]
    );
    assignments.push(adapter.set.assign(column, value));
  }

  return assignments;
}

export async function connectCreatedRecordToCurrentParent(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  createdRecord: Record<string, unknown>,
  parentData: Record<string, unknown>,
  operation: string
): Promise<void> {
  const fkDir = getFkDirection(ctx, relationInfo);
  const parentWhere = buildCurrentRecordMatchCondition(ctx, parentData);
  const assignments = buildCurrentFkValueAssignmentsFromRecord(
    ctx,
    fkDir,
    createdRecord,
    parentData,
    relationInfo.name
  );
  const setSql = sql.join(assignments, ", ");
  const table = ctx.adapter.identifiers.escape(getTableName(ctx.model));
  const updateSql = ctx.adapter.mutations.update(table, setSql, parentWhere);
  const result = await tx._execute(updateSql);
  await throwIfNoCorrelatedRowsAffected(result, relationInfo.name, operation);
}

function getRequiredTargetPkValue(
  fkDir: FkDirection,
  targetRecord: Record<string, unknown>,
  pkField: string,
  relationName: string
): unknown {
  const pkColumn = getColumnName(fkDir.referenced, pkField);
  const value = targetRecord[pkField] ?? targetRecord[pkColumn];

  if (value === undefined) {
    throw new NestedWriteError(
      `Cannot connect relation '${relationName}': target record is missing primary key field '${pkField}'.`,
      relationName
    );
  }

  return value;
}

export function assignCurrentFkValues(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  targetData: Record<string, BatchResolvableValue>,
  parentData: Record<string, unknown>
): void {
  const fkDir = getFkDirection(ctx, relationInfo);
  for (let index = 0; index < fkDir.fkFields.length; index++) {
    parentData[fkDir.fkFields[index]!] = targetData[fkDir.pkFields[index]!];
  }
}

export function assignRelatedFkValues(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  targetData: Record<string, unknown>,
  parentData: Record<string, BatchResolvableValue>
): void {
  const fkDir = getFkDirection(ctx, relationInfo);
  for (let index = 0; index < fkDir.fkFields.length; index++) {
    targetData[fkDir.fkFields[index]!] = parentData[fkDir.pkFields[index]!];
  }
}

export function buildCurrentFkAssignments(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  targetData: Record<string, BatchResolvableValue>
): Sql[] {
  const fkDir = getFkDirection(ctx, relationInfo);
  return fkDir.fkFields.map((fkField, index) => {
    const column = ctx.adapter.identifiers.escape(
      getColumnName(ctx.model, fkField)
    );
    return ctx.adapter.set.assign(
      column,
      buildScalarSqlValue(
        ctx,
        ctx.model,
        fkField,
        targetData[fkDir.pkFields[index]!]
      )
    );
  });
}

export function buildCurrentFkAssignmentsFromConnect(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>
): Sql[] {
  const fkValues = buildConnectFkValues(ctx, relationInfo, connectInput);
  return Object.entries(fkValues).map(([field, value]) =>
    ctx.adapter.set.assign(
      ctx.adapter.identifiers.escape(getColumnName(ctx.model, field)),
      value
    )
  );
}

export function updateCurrentRecord(
  ctx: QueryContext,
  assignments: Sql[],
  parentData: Record<string, unknown>
): Sql {
  return ctx.adapter.mutations.update(
    ctx.adapter.identifiers.escape(getTableName(ctx.model)),
    sql.join(assignments, ", "),
    buildCurrentRecordMatchCondition(ctx, parentData)
  );
}

/**
 * Condition matching rows that leave a `set` — connected to this parent but NOT
 * in the new member set. `fkMatch ∧ NOT COALESCE(memberWhere, FALSE)`.
 *
 * The COALESCE-to-FALSE before negating is the SQL three-valued-logic fix: when
 * a connected row has NULL in a unique column a set item references,
 * `memberWhere` is NULL and `NOT(NULL)` is NULL, so the row would silently stay
 * connected instead of departing. (Kept from the frozen `set.ts` — a pure shared
 * condition builder consumed by the interpreter's FK `set` body.)
 */
export function buildDepartingRowsCondition(
  ctx: QueryContext,
  fkDir: FkDirection,
  relationInfo: RelationInfo,
  setItems: Record<string, unknown>[],
  parentData: Record<string, unknown>,
  childCtx: QueryContext
): Sql {
  const { adapter } = ctx;
  const targetTable = getTableName(relationInfo.targetModel);
  const fkMatch = buildFkMatchCondition(
    ctx,
    fkDir,
    relationInfo.targetModel,
    parentData
  );

  if (setItems.length === 0) {
    return fkMatch;
  }

  const memberConditions = setItems.map((setItem) =>
    buildWhereUnique(childCtx, setItem, targetTable)
  );
  const memberWhere =
    memberConditions.length === 1
      ? memberConditions[0]!
      : adapter.operators.or(...memberConditions);

  return adapter.operators.and(
    fkMatch,
    adapter.operators.not(
      adapter.expressions.coalesce(memberWhere, adapter.literals.false())
    )
  );
}

/**
 * Synthesize the parent record as it looks AFTER a scalar update, for threading
 * into nested relation mutations (the D4 overlay, §6.2 / §9). The primary key
 * carriers are overlaid first (literal or deferred symbol carrier), then every
 * updated scalar column that resolves to a plain literal, so a child correlation
 * reading a NON-primary-key referenced column (a `.references()` on a non-id
 * unique field changed mid-update) observes the new value in BOTH modes — a
 * static over-approximation (§1.2 A10). Columns updated with Sql / array /
 * operation-envelope shapes are left at their pre-read value (not known at plan
 * time; no correlation path depends on them). Kept from the frozen batch engine
 * as a pure parent-data preparation helper for the shared FK builders.
 */
export function overlayUpdatedParentData(
  model: Model<any>,
  beforeRecord: Record<string, unknown>,
  primaryKey: Record<string, BatchResolvableValue>,
  data: Record<string, unknown>
): Record<string, unknown> {
  const pkFields = new Set(getPrimaryKeyFields(model));
  const overlay: Record<string, unknown> = { ...beforeRecord, ...primaryKey };

  for (const [field, value] of Object.entries(data)) {
    if (pkFields.has(field) || value === undefined) {
      continue;
    }
    const literal = resolveLiteralScalarUpdate(value);
    if (literal.resolved) {
      overlay[field] = literal.value;
      overlay[getColumnName(model, field)] = literal.value;
    }
  }

  return overlay;
}

function resolveLiteralScalarUpdate(
  value: unknown
): { resolved: true; value: unknown } | { resolved: false } {
  if (value === null) {
    return { resolved: true, value: null };
  }
  if (isSql(value) || Array.isArray(value) || isBatchValueRef(value)) {
    return { resolved: false };
  }
  if (!isPlainRecord(value)) {
    return { resolved: true, value };
  }
  const setValue = value.set;
  if (
    Object.keys(value).length === 1 &&
    setValue !== undefined &&
    !isSql(setValue) &&
    !Array.isArray(setValue) &&
    !isPlainRecord(setValue)
  ) {
    return { resolved: true, value: setValue };
  }
  return { resolved: false };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
