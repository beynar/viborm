// Base Field Exports
// Common types and interfaces for all field classes

import type { BigIntField } from "./bigint/field";
import type { BlobField } from "./blob/field";
import type { BooleanField } from "./boolean/field";
import type { FieldState } from "./common";
import type { DateField } from "./datetime/date-field";
import type { DateTimeField } from "./datetime/field";
import type { TimeField } from "./datetime/time-field";
import type { EnumField } from "./enum/field";
import type { JsonField } from "./json/field";
import type { DecimalField, FloatField, IntField } from "./number/field";
import type { PointField } from "./point/field";
import type { StringField } from "./string/field";
import type { VectorField } from "./vector/field";

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
  | StringField<FieldState<"string">>
  | IntField<FieldState<"int">>
  | FloatField<FieldState<"float">>
  | DecimalField<FieldState<"decimal">>
  | BooleanField<FieldState<"boolean">>
  | DateTimeField<FieldState<"datetime">>
  | DateField<FieldState<"date">>
  | TimeField<FieldState<"time">>
  | BigIntField<FieldState<"bigint">>
  | JsonField<FieldState<"json">>
  | VectorField<FieldState<"vector">>
  | BlobField<FieldState<"blob">>
  | PointField<FieldState<"point">>
  | EnumField<any, FieldState<"enum">>;

/**
 * Any field with any state (for loose typing).
 * Alias for Field - both represent the union of all field classes.
 */
export type AnyField = Field;

// =============================================================================
// RE-EXPORTS FROM COMMON
// =============================================================================

export {
  type AutoGenerateType,
  createDefaultState,
  type DefaultValue,
  type FieldState,
  type InferBaseType,
  type InferCreateType,
  type MaybeArray,
  type MaybeNullable,
  type ScalarFieldType,
  type UpdateState,
} from "./common";
