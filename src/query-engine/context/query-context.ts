/**
 * Query Context
 *
 * Holds shared state for query building: adapter, model, aliases, registry.
 */

import type { DatabaseAdapter } from "@adapters";
import type { Model } from "@schema/model";
import type { ModelRegistry, QueryContext, RelationInfo } from "../types";
import { createAliasGenerator } from "./alias-generator";

/**
 * Create a query context for building queries
 */
export function createQueryContext(
  adapter: DatabaseAdapter,
  model: Model<any>,
  registry: ModelRegistry
): QueryContext {
  const aliasGenerator = createAliasGenerator();
  // Reserve t0 for root
  const rootAlias = aliasGenerator.next();

  return {
    adapter,
    model,
    registry,
    nextAlias: () => aliasGenerator.next(),
    rootAlias,
  };
}

/**
 * Create a child context for nested queries (relations)
 * Inherits adapter and registry, but uses a different model and alias space
 */
export function createChildContext(
  parent: QueryContext,
  model: Model<any>,
  alias: string
): QueryContext {
  return {
    adapter: parent.adapter,
    model,
    registry: parent.registry,
    nextAlias: parent.nextAlias,
    rootAlias: alias,
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

/**
 * Get table name for a model using hydrated names or tableName from state.
 */
export function getTableName(model: Model<any>): string {
  // First check hydrated names, then tableName from state, then fall back to model name
  return model["~"].names.sql ?? model["~"].state.tableName ?? "unknown";
}

/**
 * Get all scalar field names from a model
 */
export function getScalarFieldNames(model: Model<any>): string[] {
  return Object.keys(model["~"].state.scalars);
}

/**
 * Get all relation names from a model
 */
export function getRelationNames(model: Model<any>): string[] {
  return Object.keys(model["~"].state.relations);
}

/**
 * Check if a field name is a scalar field
 */
export function isScalarField(model: Model<any>, fieldName: string): boolean {
  return fieldName in model["~"].state.scalars;
}

/**
 * Check if a field name is a relation
 */
export function isRelation(model: Model<any>, fieldName: string): boolean {
  return fieldName in model["~"].state.relations;
}

/**
 * Get the actual database column name for a field
 * Resolves .map("column_name") overrides using hydrated names.
 *
 * @param model - The model containing the field
 * @param fieldName - The field name in the schema
 * @returns The actual column name (from .map() or the field name itself)
 */
export function getColumnName(model: Model<any>, fieldName: string): string {
  const field = model["~"].state.scalars[fieldName];
  if (!field) return fieldName; // Fallback for unknown fields
  return field["~"].names.sql ?? fieldName;
}
