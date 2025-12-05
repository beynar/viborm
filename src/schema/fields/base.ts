// Base Field Exports
// Common types and interfaces for all field classes

import type { FieldState, ScalarFieldType } from "./common";
import type { Type } from "arktype";

// =============================================================================
// FIELD INTERFACE
// =============================================================================

/**
 * Common interface that all field classes conform to.
 * Used for type checking in Model class and schema builders.
 */
export interface FieldLike<State extends FieldState = FieldState> {
  /** Access internal state and schemas */
  readonly "~": {
    state: State;
    schemas: {
      base: Type;
      filter: Type;
      create: Type;
      update: Type;
    };
  };
}

/**
 * Union type representing any field instance.
 * This is used for Model field definitions.
 */
export type Field = FieldLike<FieldState<ScalarFieldType>>;

/**
 * Type guard to check if a value is a Field.
 * Checks for the presence of the "~" accessor with schemas property.
 * This distinguishes Fields from Relations which also have "~".
 */
export const isField = (value: unknown): value is Field => {
  if (
    typeof value === "object" &&
    value !== null &&
    "~" in value &&
    typeof (value as Record<string, unknown>)["~"] === "object"
  ) {
    const internal = (value as Record<string, Record<string, unknown>>)["~"];
    // Fields have a 'schemas' property, Relations have 'isToMany' etc.
    return (
      internal !== undefined &&
      "schemas" in internal &&
      typeof internal["schemas"] === "object"
    );
  }
  return false;
};

// =============================================================================
// RE-EXPORTS FROM COMMON
// =============================================================================

export {
  type FieldState,
  type ScalarFieldType,
  type AutoGenerateType,
  type UpdateState,
  type MaybeNullable,
  type MaybeArray,
  type DefaultValue,
  type InferBaseType,
  type InferCreateType,
  createDefaultState,
} from "./common";
