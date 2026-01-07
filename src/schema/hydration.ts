/**
 * Schema Hydration
 *
 * Hydrates schema name slots (tsName, sqlName) for models, fields, and relations.
 * This is called once at client initialization when the full schema context is available.
 *
 * - tsName: The TypeScript key name in the schema (e.g., "email", "User")
 * - sqlName: The resolved database name (e.g., "email_column", "users")
 *
 * Names are stored in the model's nameRegistry, not on the field/relation instances.
 * This allows the same field to be reused across multiple models with different keys.
 */

import type { Field } from "./fields/base";
import type { SchemaNames } from "./fields/common";
import type { Model, NameRegistry } from "./model";
import type { AnyRelation } from "./relation";

/**
 * Schema type - record of model names to Model instances
 */
export type Schema = Record<string, Model<any>>;

/**
 * Hydrate name slots for all models, fields, and relations in a schema.
 *
 * This function populates the model's nameRegistry:
 * - model["~"].names.ts = schema key (e.g., "User")
 * - model["~"].names.sql = tableName ?? schema key (e.g., "users")
 * - model["~"].nameRegistry.fields.get(fieldKey) = {ts, sql}
 * - model["~"].nameRegistry.relations.get(relationKey) = {ts, sql}
 *
 * Note: Full schemas are built lazily when first accessed via model["~"].schemas.
 * This allows circular references to work correctly - thunks are evaluated
 * at validation time when all models' schemas are available.
 *
 * @param schema - The schema object mapping model names to Model instances
 */
export function hydrateSchemaNames(schema: Schema): void {
  for (const [modelKey, model] of Object.entries(schema)) {
    hydrateModel(modelKey, model);
  }
}

/**
 * Hydrate a single model and its fields/relations
 */
function hydrateModel(modelKey: string, model: Model<any>): void {
  const names = model["~"].names as SchemaNames;
  const state = model["~"].state;
  const registry = model["~"].nameRegistry as NameRegistry;

  // Set model names
  names.ts = modelKey;
  names.sql = state.tableName ?? modelKey;

  // Hydrate scalar fields into model's nameRegistry
  for (const [fieldKey, field] of Object.entries(
    state.scalars as Record<string, Field>
  )) {
    const fieldNames: SchemaNames = {
      ts: fieldKey,
      sql: field["~"].state.columnName ?? fieldKey,
    };
    registry.fields.set(fieldKey, fieldNames);
  }

  // Hydrate relations into model's nameRegistry
  for (const [relationKey] of Object.entries(
    state.relations as Record<string, AnyRelation>
  )) {
    const relationNames: SchemaNames = {
      ts: relationKey,
      // Relations don't have column mapping - sql name equals ts name
      sql: relationKey,
    };
    registry.relations.set(relationKey, relationNames);
  }

  // Note: Schemas are built lazily on first access to model["~"].schemas
  // No explicit buildSchemas() call needed
}

/**
 * Check if a schema has been hydrated
 */
export function isSchemaHydrated(schema: Schema): boolean {
  const firstModel = Object.values(schema)[0];
  if (!firstModel) {
    return true;
  } // Empty schema is considered hydrated
  return firstModel["~"].names.ts !== undefined;
}

/**
 * Get the SQL name for a model (throws if not hydrated)
 */
export function getModelSqlName(model: Model<any>): string {
  const sqlName = model["~"].names.sql;
  if (!sqlName) {
    throw new Error(
      "Schema not hydrated. Call hydrateSchemaNames() or create a client first."
    );
  }
  return sqlName;
}

/**
 * Get the SQL name for a field.
 * Delegates to model["~"].getFieldName().
 */
export function getFieldSqlName(model: Model<any>, fieldKey: string): string {
  return model["~"].getFieldName(fieldKey).sql;
}

/**
 * Get the SQL name for a relation.
 * Delegates to model["~"].getRelationName().
 */
export function getRelationSqlName(
  model: Model<any>,
  relationKey: string
): string {
  return model["~"].getRelationName(relationKey).sql;
}
