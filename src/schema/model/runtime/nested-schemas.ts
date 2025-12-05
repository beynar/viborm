// Nested Schema Builders
// Builds runtime ArkType schemas for nested select/include operations

import { type, Type } from "arktype";
import type { Model } from "../model";
import type { FieldRecord, ModelSelectNested, ModelIncludeNested } from "../types";

// =============================================================================
// NESTED SELECT SCHEMA
// =============================================================================

/**
 * Builds a nested select schema
 */
export const buildSelectNestedSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelSelectNested<TFields>> => {
  const shape: Record<string, Type | string> = {};

  // Scalar fields
  for (const [name] of model.fields) {
    shape[name + "?"] = "boolean";
  }

  // Relations - allow boolean or nested select object
  for (const [name] of model.relations) {
    shape[name + "?"] = type("boolean").or(
      type({
        "select?": "object",
      })
    );
  }

  return type(shape as Record<string, Type>) as unknown as Type<
    ModelSelectNested<TFields>
  >;
};

// =============================================================================
// NESTED INCLUDE SCHEMA
// =============================================================================

/**
 * Builds a nested include schema
 */
export const buildIncludeNestedSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelIncludeNested<TFields>> => {
  const shape: Record<string, Type | string> = {};

  // Relations - allow boolean or nested include args
  for (const [name, relation] of model.relations) {
    const relationType = relation.config.relationType;
    const isToMany =
      relationType === "oneToMany" || relationType === "manyToMany";

    if (isToMany) {
      // To-many: allow where, orderBy, take, skip, etc.
      shape[name + "?"] = type("boolean").or(
        type({
          "select?": "object",
          "include?": "object",
          "where?": "object",
          "orderBy?": "object",
          "take?": "number",
          "skip?": "number",
          "distinct?": "string[]",
        })
      );
    } else {
      // To-one: simpler nested args
      shape[name + "?"] = type("boolean").or(
        type({
          "select?": "object",
          "include?": "object",
        })
      );
    }
  }

  return type(shape as Record<string, Type>) as unknown as Type<
    ModelIncludeNested<TFields>
  >;
};

