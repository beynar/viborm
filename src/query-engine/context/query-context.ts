/**
 * Query Context
 *
 * Holds shared state for query building: adapter, model, aliases, registry.
 */

import type { Model } from "@schema/model";
import type { DatabaseAdapter } from "@adapters";
import type { QueryContext, ModelRegistry, RelationInfo } from "../types";
import { AliasGenerator, createAliasGenerator } from "./alias-generator";

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
  const relation = ctx.model["~"].relations.get(relationName);
  if (!relation) return undefined;

  const internals = relation["~"];
  const targetModel = internals.getter();

  return {
    name: relationName,
    relation,
    targetModel,
    isToMany: internals.isToMany,
    isToOne: internals.isToOne,
    isOptional: internals.isOptional,
    fields: internals.fields,
    references: internals.references,
  };
}

/**
 * Get table name for a model using hydrated names.
 */
export function getTableName(model: Model<any>): string {
  return model["~"].names.sql ?? model.name;
}

/**
 * Get all scalar field names from a model
 */
export function getScalarFieldNames(model: Model<any>): string[] {
  return Array.from(model["~"].fieldMap.keys());
}

/**
 * Get all relation names from a model
 */
export function getRelationNames(model: Model<any>): string[] {
  return Array.from(model["~"].relations.keys());
}

/**
 * Check if a field name is a scalar field
 */
export function isScalarField(model: Model<any>, fieldName: string): boolean {
  return model["~"].fieldMap.has(fieldName);
}

/**
 * Check if a field name is a relation
 */
export function isRelation(model: Model<any>, fieldName: string): boolean {
  return model["~"].relations.has(fieldName);
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
  const field = model["~"].fieldMap.get(fieldName);
  if (!field) return fieldName; // Fallback for unknown fields
  return field["~"].names.sql ?? fieldName;
}
