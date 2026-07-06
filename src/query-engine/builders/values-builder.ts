/**
 * Values Builder
 *
 * Builds VALUES clause for INSERT operations.
 * Handles scalar fields, defaults, and auto-generated values.
 */

import type { CastType } from "@adapters/database-adapter";
import type { Model } from "@schema/model";
import { isSql, type Sql } from "@sql";
import { getColumnName } from "../context";
import {
  isBatchValueRef,
  lowerBatchResolvableValue,
} from "../operations/nested-writes/batch-references";
import { type QueryContext, QueryEngineError } from "../types";
import { isGeneratedIncrementDefault } from "./generated-scalar";

interface ValuesResult {
  columns: string[];
  values: Sql[][];
}

/**
 * Build VALUES for INSERT from create data
 *
 * @param ctx - Query context
 * @param data - Create input data (single record or array)
 * @returns Object with columns (actual DB column names) and values arrays
 */
export function buildValues(
  ctx: QueryContext,
  data: Record<string, unknown> | Record<string, unknown>[]
): ValuesResult {
  const records = Array.isArray(data) ? data : [data];

  if (records.length === 0) {
    return { columns: [], values: [] };
  }

  // Get cached scalar field Set for O(1) lookups
  const scalarFieldSet = ctx.model["~"].scalarFieldSet;

  // Determine which fields to include (all fields that have values in any record)
  const fieldsSet = new Set<string>();

  for (const record of records) {
    // Use Object.keys + direct access instead of Object.entries to avoid tuple allocation
    const keys = Object.keys(record);
    for (const key of keys) {
      const value = record[key];
      if (value === undefined) {
        continue;
      }
      // Use cached Set for O(1) lookup instead of array.includes() O(n)
      if (!scalarFieldSet.has(key)) {
        continue; // Skip relations and unknown fields
      }
      const field = ctx.model["~"].state.scalars[key];
      if (isGeneratedIncrementDefault(field, value)) {
        continue;
      }
      fieldsSet.add(key);
    }
  }

  // Check for auto-generated fields that weren't provided
  for (const fieldName of ctx.model["~"].scalarFieldNames) {
    const scalar = ctx.model["~"].state.scalars[fieldName];
    if (scalar) {
      const state = scalar["~"].state;
      // Throw if scalar has auto-generate (uuid, ulid, cuid, etc.) but wasn't provided
      // and doesn't have a database default
      if (state?.autoGenerate && !fieldsSet.has(fieldName)) {
        const genType = state.autoGenerate;
        // Check if it's a supported database-level auto-generate
        if (genType !== "increment") {
          throw new QueryEngineError(
            `Auto-generated value '${genType}' for field '${fieldName}' must be provided explicitly or ` +
              "handled by the database. Application-level ID generation (uuid, ulid, cuid) is not yet implemented."
          );
        }
      }
    }
  }

  // Convert field names to arrays (keeping order for both)
  const fieldNames = Array.from(fieldsSet);
  // Map field names to actual column names (handles .map() overrides)
  const columns = fieldNames.map((fieldName) =>
    getColumnName(ctx.model, fieldName)
  );

  // Build values for each record
  const values: Sql[][] = [];

  for (const record of records) {
    const row: Sql[] = [];

    for (const fieldName of fieldNames) {
      const value = record[fieldName];
      row.push(buildScalarSqlValue(ctx, ctx.model, fieldName, value));
    }

    values.push(row);
  }

  return { columns, values };
}

/**
 * Build value SQL for a single field, handling special types
 */
export function buildScalarSqlValue(
  ctx: QueryContext,
  model: Model<any>,
  fieldName: string,
  value: unknown
): Sql {
  if (value === undefined || value === null) {
    return ctx.adapter.literals.null();
  }

  const loweredValue = lowerBatchResolvableValue(ctx.adapter, value);
  if (isBatchValueRef(value)) {
    return castBatchRefValue(ctx, model, fieldName, loweredValue as Sql);
  }

  if (isSql(loweredValue)) {
    // Pass through Sql values directly (e.g., subqueries from connect)
    return loweredValue;
  }

  // Get scalar type if available
  const field = model["~"].state.scalars[fieldName];
  const scalarState = field?.["~"]?.state;
  const scalarType = scalarState?.type;

  // List scalars take the whole array in the dialect's storage format
  // (native array on PG, JSON on MySQL/SQLite)
  if (scalarState?.array && Array.isArray(loweredValue)) {
    return ctx.adapter.arrays.value(loweredValue);
  }

  // JSON scalars always store serialized JSON — primitives included — so every
  // dialect receives valid JSON text (a bare 'hello' is not valid JSON on PG)
  if (scalarType === "json") {
    return ctx.adapter.literals.json(loweredValue);
  }

  // Datetime ISO strings need dialect-specific serialization (MySQL rejects 'Z')
  if (scalarType === "datetime" && typeof loweredValue === "string") {
    return ctx.adapter.literals.dateTime(loweredValue);
  }

  return ctx.adapter.literals.value(loweredValue);
}

/**
 * Parameterize a scalar comparison/assignment value against ctx.model,
 * routing datetime ISO strings through the adapter's dialect-specific
 * serialization. Used by where/set/cursor builders.
 */
export function scalarValueLiteral(
  ctx: QueryContext,
  fieldName: string,
  value: unknown
): Sql {
  const state = ctx.model["~"].state.scalars[fieldName]?.["~"].state;
  // Whole-list values (e.g. { set: [...] }) use the dialect's storage format
  if (state?.array && Array.isArray(value)) {
    return ctx.adapter.arrays.value(value);
  }
  if (state?.type === "datetime" && typeof value === "string") {
    return ctx.adapter.literals.dateTime(value);
  }
  // JSON scalars store serialized JSON, primitives included (see buildScalarSqlValue)
  if (state?.type === "json" && value !== null && value !== undefined) {
    return ctx.adapter.literals.json(value);
  }
  return ctx.adapter.literals.value(value);
}

function castBatchRefValue(
  ctx: QueryContext,
  model: Model<any>,
  fieldName: string,
  value: Sql
): Sql {
  const castType = getScalarCastType(model, fieldName);
  return castType ? ctx.adapter.expressions.cast(value, castType) : value;
}

export function getScalarCastType(
  model: Model<any>,
  fieldName: string
): CastType | undefined {
  const scalarType = model["~"].state.scalars[fieldName]?.["~"].state.type;

  switch (scalarType) {
    case "int":
    case "bigint":
      return "integer";
    case "float":
    case "decimal":
      return "numeric";
    case "boolean":
      return "boolean";
    case "string":
    case "date":
    case "datetime":
    case "time":
      return "text";
    default:
      return undefined;
  }
}

/**
 * Build a single INSERT statement
 */
export function buildInsert(
  ctx: QueryContext,
  tableName: string,
  data: Record<string, unknown>
): Sql {
  const { columns, values } = buildValues(ctx, data);

  if (columns.length === 0) {
    // No columns to insert - this shouldn't happen normally
    throw new QueryEngineError("No columns to insert");
  }

  const table = ctx.adapter.identifiers.escape(tableName);
  return ctx.adapter.mutations.insert(table, columns, values);
}

/**
 * Build INSERT for createMany
 */
export function buildInsertMany(
  ctx: QueryContext,
  tableName: string,
  data: Record<string, unknown>[]
): Sql {
  const { columns, values } = buildValues(ctx, data);

  if (columns.length === 0 || values.length === 0) {
    throw new QueryEngineError("No data to insert");
  }

  const table = ctx.adapter.identifiers.escape(tableName);
  return ctx.adapter.mutations.insert(table, columns, values);
}
