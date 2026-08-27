import type { Model } from "@schema/model";
import { isSql } from "@sql";
import { isRecord as isPlainRecord } from "@validation/value-guards";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import { isMissingGeneratedIncrement } from "../builders/generated-scalar";
import {
  NestedWriteError,
  type Operation,
  QueryEngineError,
  type QueryScope,
} from "../types";

const INTEGER_TEXT_REGEX = /^-?\d+$/;

/** Ordered row-key members whose INSERT values are database-assigned. */
export function databaseAssignedRowKeyFields<Value>(
  model: Model<any>,
  data: Readonly<Record<string, Value>>
): readonly string[] {
  return getPrimaryKeyFields(model).filter((field) =>
    isMissingGeneratedIncrement(model["~"].state.scalars[field], data[field])
  );
}

export function planNestedCreateIdentity<Value>(
  model: Model<any>,
  data: Record<string, Value>
): {
  readonly identity: Record<string, Value>;
  readonly databaseAssigned: readonly string[];
} {
  const fields = getPrimaryKeyFields(model);
  if (fields.length === 0) {
    throw new NestedWriteError(
      `Nested create requires model '${model["~"].names.sql ?? "unknown"}' to have a primary key.`,
      model["~"].names.sql ?? "unknown"
    );
  }
  const identity: Record<string, Value> = {};
  const databaseAssigned = databaseAssignedRowKeyFields(model, data);
  for (const field of fields) {
    const value = data[field];
    const scalar = model["~"].state.scalars[field];
    if (value !== undefined && !isMissingGeneratedIncrement(scalar, value)) {
      identity[field] = value;
      continue;
    }
    if (scalar?.["~"].state.autoGenerate?.kind !== "increment") {
      throw new NestedWriteError(
        `Nested create requires primary key field '${field}' to be known before execution.`,
        model["~"].names.sql ?? "unknown"
      );
    }
  }
  return { identity, databaseAssigned };
}

export function assertCreateRefetchIdentity(
  ctx: QueryScope,
  data: Record<string, unknown>,
  modelName: string
): void {
  if (getProvidedPrimaryKeyWhere(ctx.model, data)) return;

  const primaryKeyFields = getPrimaryKeyFields(ctx.model);
  const generatedField = primaryKeyFields[0];
  if (
    primaryKeyFields.length === 1 &&
    generatedField !== undefined &&
    ctx.model["~"].state.scalars[generatedField]?.["~"].state.autoGenerate
      ?.kind === "increment"
  ) {
    return;
  }

  throw new QueryEngineError(
    `Cannot return created row for model '${modelName}' because its final primary key cannot be determined atomically.`
  );
}

export function getCreatedRowWhere(
  ctx: QueryScope,
  data: Record<string, unknown>,
  modelName: string
): Record<string, unknown> {
  const provided = getProvidedPrimaryKeyWhere(ctx.model, data);
  if (provided) return provided;
  assertCreateRefetchIdentity(ctx, data, modelName);
  const [primaryKey] = getPrimaryKeyFields(ctx.model);
  if (!primaryKey) {
    throw new QueryEngineError(`Model '${modelName}' has no primary key.`);
  }
  return { [primaryKey]: ctx.adapter.lastInsertId() };
}

/**
 * Read one record's row-key values, in the order the row key declares them.
 *
 * `fields` defaults to the model's own primary key, which is what every refetch
 * seam wants. A caller that already holds the row key it published — a target
 * projection — passes it instead, so the fields read and the fields declared are
 * one list and a member the record does not carry raises here rather than
 * degrading into an absent value downstream.
 */
export function getPrimaryKeyValuesFromRecord(
  model: Model<any>,
  record: Record<string, unknown>,
  modelName: string,
  fields: readonly string[] = getPrimaryKeyFields(model)
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const pkField of fields) {
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
  ctx: QueryScope,
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
 * Literal assignments and portable int/bigint arithmetic are resolved exactly;
 * ambiguous or unsupported operations fail before mutation.
 */
export function getUpdatedPrimaryKeyValues(
  ctx: QueryScope,
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

    values[pkField] = getUpdatedPrimaryKeyValue(
      ctx.model,
      pkField,
      values[pkField],
      data[pkField],
      modelName
    );
  }

  return values;
}

export function getUpdatedPrimaryKeyValue(
  model: Model<any>,
  primaryKeyField: string,
  beforeValue: unknown,
  updateValue: unknown,
  modelName: string
): unknown {
  const scalarType =
    model["~"].state.scalars[primaryKeyField]?.["~"].state.type;
  const updatedValue = getSafeUpdatedScalarValue(
    updateValue,
    beforeValue,
    scalarType
  );
  if (updatedValue === unsafeScalarUpdate) {
    throw new QueryEngineError(
      `Cannot determine the updated primary key for model '${modelName}' because field '${primaryKeyField}' uses an unsupported operation.`
    );
  }
  return updatedValue;
}

export function assertPortablePrimaryKeyUpdateInput(
  model: Model<any>,
  operation: Operation,
  args: unknown
): void {
  if (!isPlainRecord(args)) return;
  const data =
    operation === "upsert"
      ? args.update
      : operation === "update" ||
          operation === "updateMany" ||
          operation === "updateManyAndReturn"
        ? args.data
        : undefined;
  if (!isPlainRecord(data)) return;

  for (const primaryKeyField of getPrimaryKeyFields(model)) {
    const updateValue = data[primaryKeyField];
    if (!isPlainRecord(updateValue)) continue;
    const scalarType =
      model["~"].state.scalars[primaryKeyField]?.["~"].state.type;
    const operationNames = [
      "set",
      "increment",
      "decrement",
      "multiply",
      "divide",
    ].filter((operationName) => updateValue[operationName] !== undefined);
    if (operationNames.length !== 1) {
      throw new QueryEngineError(
        `Primary key field '${primaryKeyField}' accepts exactly one update operation; received ${operationNames.join(", ") || "none"}.`
      );
    }
    const arithmeticOperation = operationNames.find(
      (operationName) => operationName !== "set"
    );
    if (
      arithmeticOperation !== undefined &&
      (scalarType === "number" || scalarType === "decimal")
    ) {
      throw new QueryEngineError(
        `Arithmetic updates are not portable for ${scalarType} primary key field '${primaryKeyField}'. Use an explicit set value.`
      );
    }
    const divide = updateValue.divide;
    if (divide === 0 || divide === 0n) {
      throw new QueryEngineError(
        `Cannot divide primary key field '${primaryKeyField}' by zero.`
      );
    }
    for (const operationName of [
      "increment",
      "decrement",
      "multiply",
      "divide",
    ]) {
      const operand = updateValue[operationName];
      if (typeof operand === "number" && !Number.isFinite(operand)) {
        throw new QueryEngineError(
          `Primary key field '${primaryKeyField}' has a non-finite '${operationName}' operand.`
        );
      }
    }
  }
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
      isMissingGeneratedIncrement(field, value)
    ) {
      return undefined;
    }
    values[pkField] = value;
  }

  return buildPrimaryKeyWhereUnique(model, values);
}

const unsafeScalarUpdate = Symbol("unsafe scalar update");

function getSafeUpdatedScalarValue(
  value: unknown,
  beforeValue: unknown,
  scalarType: string | undefined
): unknown {
  if (value === null || value === undefined || isSql(value)) {
    return unsafeScalarUpdate;
  }

  if (typeof value !== "object") {
    return value;
  }

  const operation = value as Record<string, unknown>;
  const operationNames = Object.keys(operation).filter(
    (operationName) => operation[operationName] !== undefined
  );
  if (operationNames.length !== 1) {
    return unsafeScalarUpdate;
  }
  const operationName = operationNames[0]!;
  const operand = operation[operationName];
  if (operationName === "set") {
    return operand === undefined || operand === null || isSql(operand)
      ? unsafeScalarUpdate
      : operand;
  }
  if (
    operationName !== "increment" &&
    operationName !== "decrement" &&
    operationName !== "multiply" &&
    operationName !== "divide"
  ) {
    return unsafeScalarUpdate;
  }
  return calculateNumericPrimaryKey(
    beforeValue,
    operand,
    operationName,
    scalarType
  );
}

function calculateNumericPrimaryKey(
  beforeValue: unknown,
  operand: unknown,
  operation: "increment" | "decrement" | "multiply" | "divide",
  scalarType: string | undefined
): unknown {
  if (scalarType === "bigint") {
    const before = toBigInt(beforeValue);
    const by = toBigInt(operand);
    if (before === undefined || by === undefined) return unsafeScalarUpdate;
    if (operation === "divide" && by === 0n) {
      throw new QueryEngineError("Cannot divide a primary key by zero.");
    }
    switch (operation) {
      case "increment":
        return before + by;
      case "decrement":
        return before - by;
      case "multiply":
        return before * by;
      case "divide":
        return before / by;
      default: {
        const exhaustive: never = operation;
        return exhaustive;
      }
    }
  }

  const before = toFiniteNumber(beforeValue);
  const by = toFiniteNumber(operand);
  if (before === undefined || by === undefined) return unsafeScalarUpdate;
  if (operation === "divide" && by === 0) {
    throw new QueryEngineError("Cannot divide a primary key by zero.");
  }

  let updated: number;
  switch (operation) {
    case "increment":
      updated = before + by;
      break;
    case "decrement":
      updated = before - by;
      break;
    case "multiply":
      updated = before * by;
      break;
    case "divide":
      updated = before / by;
      if (scalarType === "int") updated = Math.trunc(updated);
      break;
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
  if (!Number.isFinite(updated)) {
    throw new QueryEngineError(
      "Primary key arithmetic produced a non-finite number."
    );
  }
  if (scalarType === "int" && !Number.isSafeInteger(updated)) {
    throw new QueryEngineError(
      "Primary key arithmetic produced an unsafe integer."
    );
  }
  return updated;
}

function toBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && INTEGER_TEXT_REGEX.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) && BigInt(number) === value
      ? number
      : undefined;
  }
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}
