/**
 * Schema Hydration
 *
 * Hydrates schema name slots (tsName, sqlName) for models, fields, and relations.
 * This is called once at client initialization when the full schema context is available.
 *
 * - tsName: The TypeScript key name in the schema (e.g., "email", "User")
 * - sqlName: The resolved database name (e.g., "email_column", "users")
 */

import type { Field } from "./fields/base";
import type { SchemaNames } from "./fields/common";
import type { Model } from "./model";
import type { AnyRelation } from "./relation";

/**
 * Schema type - record of model names to Model instances
 */
export type Schema = Record<string, Model<any>>;

/**
 * Hydrate name slots for all models, fields, and relations in a schema.
 *
 * This function mutates the schema objects in place, setting:
 * - model["~"].names.ts = schema key (e.g., "User")
 * - model["~"].names.sql = tableName ?? schema key (e.g., "users")
 * - field["~"].names.ts = field key (e.g., "email")
 * - field["~"].names.sql = columnName ?? field key (e.g., "email_column")
 * - relation["~"].names.ts = relation key (e.g., "posts")
 * - relation["~"].names.sql = relation key (relations don't have column mapping)
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

  // Set model names
  names.ts = modelKey;
  names.sql = state.tableName ?? modelKey;

  // Hydrate scalar fields
  for (const [fieldKey, field] of Object.entries(
    state.scalars as Record<string, Field>
  )) {
    hydrateField(fieldKey, field);
  }

  // Hydrate relations
  for (const [relationKey, relation] of Object.entries(
    state.relations as Record<string, AnyRelation>
  )) {
    hydrateRelation(relationKey, relation);
  }

  // Note: Schemas are built lazily on first access to model["~"].schemas
  // No explicit buildSchemas() call needed
}

/**
 * Hydrate a single field
 */
function hydrateField(fieldKey: string, field: Field): void {
  const names = field["~"].names as SchemaNames;
  names.ts = fieldKey;
  names.sql = field["~"].state.columnName ?? fieldKey;
}

/**
 * Hydrate a single relation
 */
function hydrateRelation(relationKey: string, relation: AnyRelation): void {
  const names = relation["~"].names as SchemaNames;
  names.ts = relationKey;
  // Relations don't have column mapping - sql name equals ts name
  names.sql = relationKey;
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
 * Get the SQL name for a field (throws if not hydrated)
 */
export function getFieldSqlName(field: Field): string {
  const sqlName = field["~"].names.sql;
  if (!sqlName) {
    throw new Error(
      "Schema not hydrated. Call hydrateSchemaNames() or create a client first."
    );
  }
  return sqlName;
}
