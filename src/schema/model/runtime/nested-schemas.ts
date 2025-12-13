// Nested Schema Builders
// Builds runtime ArkType schemas for nested select/include operations

import { type, Type } from "arktype";
import type { Model } from "../model";
import type {
  FieldRecord,
  ModelSelectNested,
  ModelIncludeNested,
} from "../types";

/**
 * Placeholder type used when target model's schemas are being built.
 * This allows circular references to work - the actual schema is resolved at validation time.
 */
const placeholderType = type("object");

// =============================================================================
// NESTED SELECT SCHEMA
// =============================================================================

/**
 * Builds a nested select schema with lazy evaluation for recursive relations
 * Returns placeholder during circular reference resolution.
 */
export const buildSelectNestedSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelSelectNested<TFields>> => {
  const shape: Record<string, Type | string | (() => Type)> = {};

  // Scalar fields - simple boolean
  for (const [name] of model["~"].fieldMap) {
    shape[name + "?"] = "boolean";
  }

  // Relations - boolean OR nested select object with lazy evaluation
  for (const [name, relation] of model["~"].relations) {
    const relationType = relation["~"].relationType;
    const getTargetModel = relation["~"].getter as () => Model<any>;
    const isToMany =
      relationType === "oneToMany" || relationType === "manyToMany";

    // Return placeholder during building to handle circular refs
    const getSelectNested = () =>
      getTargetModel()["~"].schemas?.selectNested ?? placeholderType;
    const getIncludeNested = () =>
      getTargetModel()["~"].schemas?.includeNested ?? placeholderType;

    if (isToMany) {
      // To-many: allow where, orderBy, take, skip, nested select/include, etc.
      shape[name + "?"] = type("boolean").or(
        type({
          "select?": () => getSelectNested(),
          "include?": () => getIncludeNested(),
          "where?": "object",
          "orderBy?": "object | object[]",
          "cursor?": "object",
          "take?": "number",
          "skip?": "number",
          "distinct?": "string[]",
        })
      );
    } else {
      // To-one: nested select/include
      shape[name + "?"] = type("boolean").or(
        type({
          "select?": () => getSelectNested(),
          "include?": () => getIncludeNested(),
        })
      );
    }
  }

  return type(shape as Record<string, Type>) as unknown as Type<
    ModelSelectNested<TFields>
  >;
};

// =============================================================================
// NESTED INCLUDE SCHEMA
// =============================================================================

/**
 * Builds a nested include schema with lazy evaluation for recursive relations
 * Returns placeholder during circular reference resolution.
 */
export const buildIncludeNestedSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelIncludeNested<TFields>> => {
  const shape: Record<string, Type | string | (() => Type)> = {};

  // Relations - boolean OR nested include args with lazy evaluation
  for (const [name, relation] of model["~"].relations) {
    const relationType = relation["~"].relationType;
    const getTargetModel = relation["~"].getter;
    const isToMany =
      relationType === "oneToMany" || relationType === "manyToMany";

    // Return placeholder during building to handle circular refs
    const getSelectNested = () =>
      getTargetModel()["~"].schemas?.selectNested ?? placeholderType;
    const getIncludeNested = () =>
      getTargetModel()["~"].schemas?.includeNested ?? placeholderType;

    if (isToMany) {
      // To-many: allow where, orderBy, take, skip, nested select/include, etc.
      shape[name + "?"] = type("boolean").or(
        type({
          "select?": () => getSelectNested(),
          "include?": () => getIncludeNested(),
          "where?": "object",
          "orderBy?": "object | object[]",
          "cursor?": "object",
          "take?": "number",
          "skip?": "number",
          "distinct?": "string[]",
        })
      );
    } else {
      // To-one: simpler nested args
      shape[name + "?"] = type("boolean").or(
        type({
          "select?": () => getSelectNested(),
          "include?": () => getIncludeNested(),
        })
      );
    }
  }

  return type(shape as Record<string, Type>) as unknown as Type<
    ModelIncludeNested<TFields>
  >;
};
