/**
 * Query Context
 *
 * Holds shared state for query building: adapter, model, aliases, registry.
 */

import type { DatabaseAdapter } from "@adapters";
import type { AnyDriver } from "@drivers/driver";
import { QueryEngineError } from "@errors";
import { getColumnName, type Model } from "@schema/model";
import type { ModelRegistry, QueryContext, RelationInfo } from "../types";
import { createAliasGenerator } from "./alias-generator";

/**
 * Create a query context for building queries
 */
export function createQueryContext(
  adapter: DatabaseAdapter,
  model: Model<any>,
  registry: ModelRegistry,
  driver?: AnyDriver
): QueryContext {
  const aliasGenerator = createAliasGenerator();
  // Reserve t0 for root
  const rootAlias = aliasGenerator.next();
  const schemaRegistry = registry.schemas;

  if (!schemaRegistry) {
    throw new QueryEngineError("Schema registry is required for query context");
  }

  return {
    driver,
    adapter,
    model,
    registry,
    schemaRegistry,
    nextAlias: () => aliasGenerator.next(),
    rootAlias,
  };
}

/**
 * Create a child context for nested queries (relations)
 * Inherits driver, adapter, registry, but uses a different model and alias space
 */
export function createChildContext(
  parent: QueryContext,
  model: Model<any>,
  alias: string
): QueryContext {
  return {
    driver: parent.driver,
    adapter: parent.adapter,
    model,
    registry: parent.registry,
    schemaRegistry: parent.schemaRegistry,
    nextAlias: parent.nextAlias,
    rootAlias: alias,
    mutationTable: parent.mutationTable,
  };
}

/**
 * Get relation info from a model
 */
export function getRelationInfo(
  ctx: QueryContext,
  relationName: string
): RelationInfo | undefined {
  const relations = ctx.model["~"].state.relations;
  const relation = relations[relationName];
  if (!relation) return undefined;

  const state = relation["~"].state;
  const targetModel = state.getter();

  // Determine relation type
  const isToMany = state.type === "oneToMany" || state.type === "manyToMany";
  const isToOne = state.type === "oneToOne" || state.type === "manyToOne";

  return {
    name: relationName,
    relation,
    targetModel,
    type: state.type,
    isToMany,
    isToOne,
    isOptional: state.optional ?? false,
    fields: state.fields,
    references: state.references,
  };
}

export { getColumnName, getTableName } from "@schema/model";

/**
 * Get all scalar field names from a model (cached)
 */
export function getScalarFieldNames(model: Model<any>): string[] {
  return model["~"].scalarFieldNames;
}

/**
 * Get all relation names from a model (cached)
 */
export function getRelationNames(model: Model<any>): string[] {
  return model["~"].relationNames;
}

/**
 * Check if a field name is a scalar field (O(1) using cached Set)
 */
export function isScalarField(model: Model<any>, fieldName: string): boolean {
  return model["~"].scalarFieldSet.has(fieldName);
}

/**
 * Check if a field name is a relation (O(1) using cached Set)
 */
export function isRelation(model: Model<any>, fieldName: string): boolean {
  return model["~"].relationSet.has(fieldName);
}

/**
 * Translate a raw driver row (RETURNING * / SELECT *) from database column
 * names to schema field names, so consumers of captured records never see
 * .map()ed column names. Rows already keyed by field name pass through
 * unchanged.
 */
export function translateRowToFieldNames(
  model: Model<any>,
  row: Record<string, unknown>
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const fieldName of getScalarFieldNames(model)) {
    const columnName = getColumnName(model, fieldName);
    if (columnName in row) {
      record[fieldName] = row[columnName];
    } else if (fieldName in row) {
      record[fieldName] = row[fieldName];
    }
  }
  return record;
}
