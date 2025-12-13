// Unchecked Schema Builders
// Builds runtime ArkType schemas for unchecked (FK-based) operations

import { type, Type } from "arktype";
import type { Model } from "../model";
import type {
  FieldRecord,
  ModelUncheckedCreateInput,
  ModelUncheckedUpdateInput,
} from "../types";

// =============================================================================
// UNCHECKED SCHEMA BUILDERS
// =============================================================================

/**
 * Builds an unchecked create schema (FK-based, no nested relations)
 */
export const buildUncheckedCreateSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelUncheckedCreateInput<TFields>> => {
  const shape: Record<string, Type | string> = {};
  const scalarFieldNames = new Set<string>();

  // Scalar fields
  for (const [name, field] of model["~"].fieldMap) {
    const state = field["~"].state;
    const isOptional =
      state.hasDefault || state.autoGenerate !== undefined || state.nullable;
    const key = isOptional ? name + "?" : name;
    shape[key] = field["~"].schemas.create;
    scalarFieldNames.add(name);
  }

  // FK fields from to-one relations (optional) - only if not already defined as scalar
  for (const [name, relation] of model["~"].relations) {
    const relationType = relation["~"].relationType;
    if (relationType === "manyToOne" || relationType === "oneToOne") {
      const fkFieldName = `${name}Id`;
      // Skip if FK field is already defined as a scalar field
      if (!scalarFieldNames.has(fkFieldName)) {
        shape[`${fkFieldName}?`] = "string";
      }
    }
  }

  return type(shape as Record<string, Type>) as unknown as Type<
    ModelUncheckedCreateInput<TFields>
  >;
};

/**
 * Builds an unchecked update schema (FK-based, no nested relations)
 */
export const buildUncheckedUpdateSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelUncheckedUpdateInput<TFields>> => {
  const shape: Record<string, Type | string> = {};
  const scalarFieldNames = new Set<string>();

  // Scalar fields (optional)
  for (const [name, field] of model["~"].fieldMap) {
    shape[name + "?"] = field["~"].schemas.update;
    scalarFieldNames.add(name);
  }

  // FK fields from to-one relations (optional, nullable for disconnect) - only if not already defined as scalar
  for (const [name, relation] of model["~"].relations) {
    const relationType = relation["~"].relationType;
    if (relationType === "manyToOne" || relationType === "oneToOne") {
      const fkFieldName = `${name}Id`;
      // Skip if FK field is already defined as a scalar field
      if (!scalarFieldNames.has(fkFieldName)) {
        shape[`${fkFieldName}?`] = type("string").or(type("null"));
      }
    }
  }

  return type(shape as Record<string, Type>) as unknown as Type<
    ModelUncheckedUpdateInput<TFields>
  >;
};
