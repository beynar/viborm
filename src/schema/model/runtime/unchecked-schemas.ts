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

  // Scalar fields
  for (const [name, field] of model["~"].fieldMap) {
    shape[name] = field["~"].schemas.create;
  }

  // FK fields from to-one relations (optional)
  for (const [name, relation] of model["~"].relations) {
    const relationType = relation["~"].relationType;
    if (relationType === "manyToOne" || relationType === "oneToOne") {
      shape[`${name}Id?`] = "string";
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

  // Scalar fields (optional)
  for (const [name, field] of model["~"].fieldMap) {
    shape[name + "?"] = field["~"].schemas.update;
  }

  // FK fields from to-one relations (optional, nullable for disconnect)
  for (const [name, relation] of model["~"].relations) {
    const relationType = relation["~"].relationType;
    if (relationType === "manyToOne" || relationType === "oneToOne") {
      shape[`${name}Id?`] = type("string").or(type("null"));
    }
  }

  return type(shape as Record<string, Type>) as unknown as Type<
    ModelUncheckedUpdateInput<TFields>
  >;
};


