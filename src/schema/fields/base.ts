// Base Field Exports
// Common types and interfaces for all field classes

import type { FieldState, ScalarFieldType } from "./common";
import type { StringField } from "./string/field";
import type { IntField, FloatField, DecimalField } from "./number/field";
import type { BooleanField } from "./boolean/field";
import type { DateTimeField } from "./datetime/field";
import type { DateField } from "./datetime/date-field";
import type { TimeField } from "./datetime/time-field";
import type { BigIntField } from "./bigint/field";
import type { JsonField } from "./json/field";
import type { VectorField } from "./vector/field";
import type { BlobField } from "./blob/field";
import type { PointField } from "./point/field";
import type { EnumField } from "./enum/field";

// =============================================================================
// FIELD TYPE - UNION OF ALL FIELD CLASSES
// =============================================================================

/**
 * Union type of all concrete field classes with any state.
 * This is the canonical "Field" type used throughout the codebase.
 *
 * Benefits over an interface:
 * - No need to maintain a separate interface in sync with classes
 * - TypeScript infers exact shape from actual implementations
 * - Adding new properties (like nativeType) automatically works
 */

export type Field =
  | StringField<any>
  | IntField<any>
  | FloatField<any>
  | DecimalField<any>
  | BooleanField<any>
  | DateTimeField<any>
  | DateField<any>
  | TimeField<any>
  | BigIntField<any>
  | JsonField<any>
  | VectorField<any>
  | BlobField<any>
  | PointField<any>
  | EnumField<any>;

/**
 * Any field with any state (for loose typing).
 * Alias for Field - both represent the union of all field classes.
 */
export type AnyField = Field;

// =============================================================================
// TYPE GUARD
// =============================================================================

/**
 * Type guard to check if a value is a Field.
 * Checks for the presence of the "~" accessor with schemas property.
 * This distinguishes Fields from Relations which also have "~".
 */
export const isField = (value: unknown): value is AnyField => {
  if (
    typeof value === "object" &&
    value !== null &&
    "~" in value &&
    typeof (value as Record<string, unknown>)["~"] === "object"
  ) {
    const internal = (value as Record<string, Record<string, unknown>>)["~"];
    // Fields have a 'schemas' property, Relations have 'relationType' etc.
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
