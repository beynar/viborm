import type { Model } from "@schema/model";
import type { ScalarType } from "@schema/scalars";
import { isSql, type Sql } from "@sql";
import { getPrimaryKeyFields } from "../../builders/correlation-utils";
import {
  buildScalarSqlValue,
  getScalarCastType,
} from "../../builders/values-builder";
import { getColumnName, getTableName } from "../../context";
import { NestedWriteError, type QueryContext } from "../../types";
import {
  type BatchPrimaryKeyRef,
  type BatchRecordRef,
  type BatchResolvableValue,
  isBatchValueRef,
  type PlanState,
} from "./batch-references";

export interface BatchUpdatedPrimaryKeyRef extends BatchRecordRef {
  readonly computedStores: readonly BatchComputedPrimaryKeyStore[];
}

interface BatchComputedPrimaryKeyStore {
  readonly valueRef: BatchPrimaryKeyRef["valueRef"];
  readonly valueSql: Sql;
}

type UpdatedPrimaryKeyValue =
  | { kind: "literal"; value: BatchResolvableValue }
  | { kind: "computed"; valueSql: Sql };

export function getBatchUpdatedPrimaryKeyRef(
  state: PlanState,
  ctx: QueryContext,
  beforeRecord: Record<string, unknown>,
  data: Record<string, unknown>,
  operation: string
): BatchUpdatedPrimaryKeyRef {
  const primaryKey: Record<string, BatchResolvableValue> = {};
  const primaryKeyRefs: BatchPrimaryKeyRef[] = [];
  const computedStores: BatchComputedPrimaryKeyStore[] = [];
  const tableName = getTableName(ctx.model);

  for (const pkField of getPrimaryKeyFields(ctx.model)) {
    const beforeValue = getBeforePrimaryKeyValue(
      ctx.model,
      beforeRecord,
      pkField,
      operation
    );

    if (data[pkField] === undefined) {
      primaryKey[pkField] = beforeValue;
      continue;
    }

    const updatedValue = getUpdatedPrimaryKeyValue(
      ctx,
      pkField,
      beforeValue,
      data[pkField],
      operation
    );

    if (updatedValue.kind === "literal") {
      primaryKey[pkField] = updatedValue.value;
      continue;
    }

    const valueRef = state.references.allocateValueRef();
    primaryKey[pkField] = valueRef;
    primaryKeyRefs.push({
      kind: "batchPrimaryKeyRef",
      modelName: ctx.model["~"].names.ts ?? tableName,
      tableName,
      fieldName: pkField,
      valueRef,
    });
    computedStores.push({ valueRef, valueSql: updatedValue.valueSql });
  }

  return {
    kind: "batchRecordRef",
    modelName: ctx.model["~"].names.ts ?? tableName,
    tableName,
    primaryKey,
    primaryKeyRefs,
    computedStores,
  };
}

export function appendUpdatedPrimaryKeyStores(
  state: PlanState,
  ctx: QueryContext,
  recordRef: BatchUpdatedPrimaryKeyRef
): void {
  for (const store of recordRef.computedStores) {
    state.statements.push(
      ctx.adapter.batchRefs.store(
        store.valueRef.batchId,
        store.valueRef.key,
        store.valueSql
      )
    );
  }
}

/**
 * Synthesize the parent record as it looks AFTER a scalar update, for
 * threading into nested relation mutations. The batch engine cannot re-SELECT
 * the row (unlike the tx engine, which does), so it overlays the pre-read
 * record with the update's resolved values.
 *
 * The primary key ref is overlaid first (literal or computed value-ref).
 * Every other updated scalar column that resolves to a plain literal is then
 * overlaid so that a child correlation reading a NON-primary-key referenced
 * column (a `.references()` on a non-id unique field) observes the new value
 * — matching the tx engine's re-SELECT. Columns updated with SQL, array, or
 * operation-envelope shapes are left at their pre-read value: their new value
 * is not known at plan time, and no correlation path depends on them.
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

export function hasPrimaryKeyUpdate(
  model: Model<any>,
  data: Record<string, unknown>
): boolean {
  return getPrimaryKeyFields(model).some(
    (pkField) => data[pkField] !== undefined
  );
}

function getBeforePrimaryKeyValue(
  model: Model<any>,
  beforeRecord: Record<string, unknown>,
  pkField: string,
  operation: string
): BatchResolvableValue {
  const columnName = getColumnName(model, pkField);
  const value = beforeRecord[pkField] ?? beforeRecord[columnName];

  if (value === undefined || value === null || isSql(value)) {
    throw new NestedWriteError(
      `Batch-only nested ${operation} requires primary key field '${pkField}' to be known before execution.`,
      getTableName(model)
    );
  }

  return value;
}

function getUpdatedPrimaryKeyValue(
  ctx: QueryContext,
  pkField: string,
  beforeValue: BatchResolvableValue,
  updateValue: unknown,
  operation: string
): UpdatedPrimaryKeyValue {
  const tableName = getTableName(ctx.model);
  assertSafePrimaryKeyUpdateValue(pkField, updateValue, operation, tableName);

  if (!isPlainRecord(updateValue) || isBatchValueRef(updateValue)) {
    return { kind: "literal", value: updateValue as BatchResolvableValue };
  }

  const operationKeys = Object.keys(updateValue).filter(
    (key) => updateValue[key] !== undefined
  );

  if (operationKeys.length !== 1) {
    throw new NestedWriteError(
      `Batch-only nested ${operation} cannot update primary key field '${pkField}' with operation envelope '${operationKeys.join(", ")}'.`,
      tableName
    );
  }

  const updateOperation = operationKeys[0]!;
  const operand = updateValue[updateOperation];

  if (updateOperation === "set") {
    assertSafePrimaryKeyUpdateValue(pkField, operand, operation, tableName);
    return { kind: "literal", value: operand as BatchResolvableValue };
  }

  if (updateOperation === "push" || updateOperation === "unshift") {
    throw new NestedWriteError(
      `Batch-only nested ${operation} cannot update primary key field '${pkField}' with array operation '${updateOperation}'.`,
      tableName
    );
  }

  if (!isNumericUpdateOperation(updateOperation)) {
    throw new NestedWriteError(
      `Batch-only nested ${operation} cannot update primary key field '${pkField}' with unsupported operation '${updateOperation}'.`,
      tableName
    );
  }

  assertNumericPrimaryKeyScalar(ctx, pkField, updateOperation, operation);
  assertSafePrimaryKeyUpdateValue(pkField, operand, operation, tableName);
  assertSafeNumericPrimaryKeyOperand(pkField, operand, operation, tableName);

  const oldValueSql = buildPrimaryKeyArithmeticOperand(
    ctx,
    pkField,
    beforeValue
  );
  const operandSql = buildPrimaryKeyArithmeticOperand(ctx, pkField, operand);

  switch (updateOperation) {
    case "increment":
      return {
        kind: "computed",
        valueSql: ctx.adapter.expressions.add(oldValueSql, operandSql),
      };
    case "decrement":
      return {
        kind: "computed",
        valueSql: ctx.adapter.expressions.subtract(oldValueSql, operandSql),
      };
    case "multiply":
      return {
        kind: "computed",
        valueSql: ctx.adapter.expressions.multiply(oldValueSql, operandSql),
      };
    case "divide":
      return {
        kind: "computed",
        valueSql: ctx.adapter.expressions.divide(oldValueSql, operandSql),
      };
  }
}

function assertSafePrimaryKeyUpdateValue(
  pkField: string,
  value: unknown,
  operation: string,
  tableName: string
): void {
  if (
    value === undefined ||
    value === null ||
    isSql(value) ||
    Array.isArray(value)
  ) {
    throw new NestedWriteError(
      `Batch-only nested ${operation} cannot update primary key field '${pkField}' with an unsafe value.`,
      tableName
    );
  }
}

function assertNumericPrimaryKeyScalar(
  ctx: QueryContext,
  pkField: string,
  updateOperation: string,
  operation: string
): void {
  const scalarState = ctx.model["~"].state.scalars[pkField]?.["~"].state;
  if (
    !scalarState ||
    scalarState.array ||
    !isNumericScalarType(scalarState.type)
  ) {
    throw new NestedWriteError(
      `Batch-only nested ${operation} cannot update non-numeric primary key field '${pkField}' with '${updateOperation}'.`,
      getTableName(ctx.model)
    );
  }
}

function assertSafeNumericPrimaryKeyOperand(
  pkField: string,
  value: unknown,
  operation: string,
  tableName: string
): void {
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    isBatchValueRef(value)
  ) {
    return;
  }

  throw new NestedWriteError(
    `Batch-only nested ${operation} cannot update primary key field '${pkField}' with a non-numeric operation value.`,
    tableName
  );
}

function isNumericScalarType(type: ScalarType): boolean {
  return (
    type === "int" ||
    type === "float" ||
    type === "decimal" ||
    type === "bigint"
  );
}

function isNumericUpdateOperation(
  operation: string
): operation is "increment" | "decrement" | "multiply" | "divide" {
  return (
    operation === "increment" ||
    operation === "decrement" ||
    operation === "multiply" ||
    operation === "divide"
  );
}

function buildPrimaryKeyArithmeticOperand(
  ctx: QueryContext,
  pkField: string,
  value: BatchResolvableValue
): Sql {
  const valueSql = buildScalarSqlValue(ctx, ctx.model, pkField, value);
  const castType = getScalarCastType(ctx.model, pkField);
  return castType ? ctx.adapter.expressions.cast(valueSql, castType) : valueSql;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
