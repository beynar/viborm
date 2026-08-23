/**
 * Schema Hydration
 *
 * Hydrates schema name slots (tsName, sqlName) for models, scalars, and relations.
 * This is called once at client initialization when the full schema context is available.
 *
 * - tsName: The TypeScript key name in the schema (e.g., "email", "User")
 * - sqlName: The resolved database name (e.g., "email_column", "users")
 *
 * Names are stored in the model's nameRegistry, not on the scalar/relation instances.
 * This allows the same scalar to be reused across multiple models with different keys.
 */

import { isValidSchemaIdentifier } from "./identifier";
import type { Model, NameRegistry } from "./model";
import { preflightModelRegistrationIdentity } from "./registration-preflight";
import type { AnyRelation } from "./relation";
import type { Scalar } from "./scalars/base";
import type { SchemaNames } from "./scalars/common";
import { SchemaValidationError } from "./validation/error";

/**
 * Schema type - record of model names to Model instances
 */
export type Schema = Record<string, Model<any>>;

/**
 * Hydrate name slots for all models, scalars, and relations in a schema.
 *
 * This function populates the model's nameRegistry:
 * - model["~"].names.ts = schema key (e.g., "User")
 * - model["~"].names.sql = tableName ?? schema key (e.g., "users")
 * - model["~"].nameRegistry.fields.get(fieldKey) = {ts, sql}
 * - model["~"].nameRegistry.relations.get(relationKey) = {ts, sql}
 *
 * Operation schemas are registry-owned; hydration only binds reusable schema
 * definitions to model-local names and relation sources.
 *
 * @param schema - The schema object mapping model names to Model instances
 */
export function hydrateSchemaNames(schema: Schema): void {
  const registrations = Object.entries(schema);
  // TWO ordered phases. The preflight proves every model's identity and name
  // stability BEFORE a single registry write, so a schema that fails validation
  // never leaves models 0..N-1 bound while model N is refused.
  const identityIssue = preflightModelRegistrationIdentity(registrations);
  if (identityIssue) throw new SchemaValidationError([identityIssue]);
  for (const [modelKey, model] of registrations) {
    preflightModelIdentifiers(modelKey, model);
  }
  for (const [modelKey, model] of registrations) {
    bindModelNames(modelKey, model);
  }
}

/**
 * Prove one model's identity: its identifiers are legal, and its schema key is
 * the one this model object is already bound to.
 *
 * A model object binds ONE schema key for its lifetime. Re-registering the same
 * object under the same key is idempotent — the same schema composed twice, or
 * a second client over the same models, is a normal thing to do — while a second
 * key is refused, because every derived name, junction table, index and
 * constraint in the estate is generated from the schema key and two keys would
 * make one model object mean two different tables.
 */
function preflightModelIdentifiers(modelKey: string, model: Model<any>): void {
  const state = model["~"].state;

  assertValidIdentifier("Model", modelKey);
  if (state.tableName !== undefined) {
    assertValidIdentifier("Mapped table", state.tableName, modelKey);
  }
  for (const fieldKey of Object.keys(state.shape)) {
    assertValidIdentifier("Field", fieldKey, modelKey);
  }
  for (const scalar of Object.values(state.scalars as Record<string, Scalar>)) {
    if (scalar["~"].state.columnName !== undefined) {
      assertValidIdentifier(
        "Mapped column",
        scalar["~"].state.columnName,
        modelKey
      );
    }
  }
}

/**
 * Bind one model's names and its scalar/relation name registries.
 *
 * ONE relation lane covers both target domains, and no relation is given a
 * source model: `.extends()` may reuse one relation object under more than one
 * model or key, so a contextual operation carries its own slot identity instead.
 */
function bindModelNames(modelKey: string, model: Model<any>): void {
  const names = model["~"].names as SchemaNames;
  const state = model["~"].state;
  const registry = model["~"].nameRegistry as NameRegistry;

  names.ts = modelKey;
  names.sql = state.tableName ?? modelKey;

  for (const [fieldKey, scalar] of Object.entries(
    state.scalars as Record<string, Scalar>
  )) {
    const fieldNames: SchemaNames = {
      ts: fieldKey,
      sql: scalar["~"].state.columnName ?? fieldKey,
    };
    registry.fields.set(fieldKey, fieldNames);
  }

  for (const relationKey of Object.keys(
    state.relations as Record<string, AnyRelation>
  )) {
    registry.relations.set(relationKey, {
      ts: relationKey,
      // Relations don't have column mapping - sql name equals ts name
      sql: relationKey,
    });
  }

  // Operation schemas are built by SchemaRegistry, not during name hydration.
}

function assertValidIdentifier(
  kind: "Field" | "Mapped column" | "Mapped table" | "Model",
  identifier: unknown,
  modelName?: string
): void {
  if (isValidSchemaIdentifier(identifier)) return;
  const location = modelName ? ` in '${modelName}'` : "";
  const renderedIdentifier = String(identifier);
  throw new Error(
    `${kind} '${renderedIdentifier}'${location} is invalid identifier; identifiers must be ASCII, at most 63 bytes, and must not collide with Object.prototype properties`
  );
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
 * Get the SQL name for a scalar field key.
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
