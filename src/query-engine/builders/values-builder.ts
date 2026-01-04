/**
 * Values Builder
 *
 * Builds VALUES clause for INSERT operations.
 * Handles scalar fields, defaults, and auto-generated values.
 */

import type { Sql } from "@sql";
import { getColumnName, getScalarFieldNames, isRelation } from "../context";
import type { QueryContext } from "../types";
import { QueryEngineError } from "../types";

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

  // Get all scalar field names
  const scalarFields = getScalarFieldNames(ctx.model);

  // Determine which fields to include (all fields that have values in any record)
  const fieldsSet = new Set<string>();

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) {
        continue;
      }
      if (isRelation(ctx.model, key)) {
        continue; // Skip relations
      }
      if (scalarFields.includes(key)) {
        fieldsSet.add(key);
      }
    }
  }

  // Check for auto-generated fields that weren't provided
  for (const fieldName of scalarFields) {
    const field = ctx.model["~"].state.scalars[fieldName];
    if (field) {
      const state = field["~"].state;
      // Throw if field has auto-generate (uuid, ulid, cuid, etc.) but wasn't provided
      // and doesn't have a database default
      if (state?.autoGenerate && !fieldsSet.has(fieldName)) {
        const genType = state.autoGenerate;
        // Check if it's a supported database-level auto-generate
        if (genType !== "autoincrement") {
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
      row.push(buildFieldValue(ctx, fieldName, value));
    }

    values.push(row);
  }

  return { columns, values };
}

/**
 * Build value SQL for a single field, handling special types
 */
function buildFieldValue(
  ctx: QueryContext,
  fieldName: string,
  value: unknown
): Sql {
  if (value === undefined || value === null) {
    return ctx.adapter.literals.null();
  }

  if (isSql(value)) {
    // Pass through Sql values directly (e.g., subqueries from connect)
    return value;
  }

  // Get field type if available
  const field = ctx.model["~"].state.scalars[fieldName];
  const fieldType = field?.["~"]?.state?.type;

  // Handle JSON fields - adapter handles dialect-specific serialization
  if (fieldType === "json" && typeof value === "object") {
    return ctx.adapter.literals.json(value);
  }

  return ctx.adapter.literals.value(value);
}

/**
 * Check if a value is a Sql object
 */
function isSql(value: unknown): value is Sql {
  return (
    value !== null &&
    typeof value === "object" &&
    "strings" in value &&
    "values" in value &&
    Array.isArray((value as Sql).strings) &&
    Array.isArray((value as Sql).values)
  );
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
    throw new Error("No columns to insert");
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
    throw new Error("No data to insert");
  }

  const table = ctx.adapter.identifiers.escape(tableName);
  return ctx.adapter.mutations.insert(table, columns, values);
}
