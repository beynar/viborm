// Simplified Field State Types
// Practical type system for field configuration

import type { AutoGenerateType } from "./scalars.js";

// Basic field state configuration with literal boolean types
export interface FieldState<
  T = any,
  IsNullable extends boolean = boolean,
  IsArray extends boolean = boolean,
  IsId extends boolean = boolean,
  IsUnique extends boolean = boolean,
  HasDefault extends boolean = boolean
> {
  BaseType: T;
  IsNullable: IsNullable;
  IsArray: IsArray;
  IsId: IsId;
  IsUnique: IsUnique;
  HasDefault: HasDefault;
  AutoGenerate: AutoGenerateType | false;
}

// Default field state with literal false values
export type DefaultFieldState<T> = FieldState<
  T,
  false,
  false,
  false,
  false,
  false
>;

// Type modifiers
export type MakeNullable<T extends FieldState<any, any, any, any, any, any>> =
  FieldState<
    T["BaseType"],
    true,
    T["IsArray"],
    T["IsId"],
    T["IsUnique"],
    T["HasDefault"]
  >;

export type MakeArray<T extends FieldState<any, any, any, any, any, any>> =
  FieldState<
    T["BaseType"],
    T["IsNullable"],
    true,
    T["IsId"],
    T["IsUnique"],
    T["HasDefault"]
  >;

export type MakeId<T extends FieldState<any, any, any, any, any, any>> =
  FieldState<
    T["BaseType"],
    T["IsNullable"],
    T["IsArray"],
    true,
    T["IsUnique"],
    T["HasDefault"]
  >;

export type MakeUnique<T extends FieldState<any, any, any, any, any, any>> =
  FieldState<
    T["BaseType"],
    T["IsNullable"],
    T["IsArray"],
    T["IsId"],
    true,
    T["HasDefault"]
  >;

export type MakeDefault<T extends FieldState<any, any, any, any, any, any>> =
  FieldState<
    T["BaseType"],
    T["IsNullable"],
    T["IsArray"],
    T["IsId"],
    T["IsUnique"],
    true
  >;

export type MakeAuto<
  T extends FieldState<any, any, any, any, any, any>,
  A extends AutoGenerateType
> = FieldState<
  T["BaseType"],
  T["IsNullable"],
  T["IsArray"],
  T["IsId"],
  T["IsUnique"],
  T["HasDefault"]
> & {
  AutoGenerate: A;
};

// Smart type inference that respects logical constraints
export type SmartInferType<T extends FieldState<any, any, any, any, any, any>> =
  // Step 1: Determine if field is logically non-nullable
  // ID fields are NEVER nullable (logical constraint)
  // Auto-generated fields are NEVER nullable (they always get a value)
  // Fields with defaults are non-nullable for storage (they get a default if not provided)
  T["IsId"] extends true
    ? SmartInferNonNullable<T>
    : T["AutoGenerate"] extends AutoGenerateType
    ? SmartInferNonNullable<T>
    : T["HasDefault"] extends true
    ? SmartInferNonNullable<T>
    : // Step 2: Otherwise, respect the explicit nullable setting
    T["IsArray"] extends true
    ? T["IsNullable"] extends true
      ? T["BaseType"][] | null
      : T["BaseType"][]
    : T["IsNullable"] extends true
    ? T["BaseType"] | null
    : T["BaseType"];

// Helper type for non-nullable inference
type SmartInferNonNullable<T extends FieldState<any, any, any, any, any, any>> =
  T["IsArray"] extends true
    ? T["BaseType"][] // Lists of non-nullable items (never null lists for ID/auto/default)
    : T["BaseType"]; // Non-nullable single values

// Input vs Output type distinction
// For input (create/update operations), fields with defaults can be optional
export type InferInputType<T extends FieldState<any, any, any, any, any, any>> =
  // Auto-generated fields are completely optional for input
  T["AutoGenerate"] extends AutoGenerateType
    ? SmartInferOptional<T>
    : // Fields with defaults are optional for input
    T["HasDefault"] extends true
    ? SmartInferOptional<T>
    : // ID fields without auto-generation are required for input
      // Other fields follow their nullable configuration
      SmartInferType<T>;

// Helper type for optional inference (used in input types)
type SmartInferOptional<T extends FieldState<any, any, any, any, any, any>> =
  T["IsArray"] extends true
    ? T["BaseType"][] | undefined
    : T["BaseType"] | undefined;

// Storage/Database type - always reflects the actual stored value
export type InferStorageType<
  T extends FieldState<any, any, any, any, any, any>
> = SmartInferType<T>;

// Legacy alias for backward compatibility, but now using smart inference
export type InferType<T extends FieldState<any, any, any, any, any, any>> =
  SmartInferType<T>;

// Type-level validation helpers
export type ValidateFieldState<
  T extends FieldState<any, any, any, any, any, any>
> = {
  // Type-level warning: ID fields should not be explicitly nullable
  readonly __WARNING_ID_FIELDS_CANNOT_BE_NULLABLE: T["IsId"] extends true
    ? T["IsNullable"] extends true
      ? "❌ ID fields cannot be nullable - this setting will be ignored"
      : "✅ Valid ID field configuration"
    : "✅ Non-ID field";

  // Type-level warning: Auto-generated fields don't need to be nullable
  readonly __WARNING_AUTO_FIELDS_ARE_NON_NULLABLE: T["AutoGenerate"] extends AutoGenerateType
    ? T["IsNullable"] extends true
      ? "⚠️ Auto-generated fields are never null - nullable setting ignored"
      : "✅ Valid auto-generated field configuration"
    : "✅ Non-auto field";

  // Type-level warning: Fields with defaults don't need to be nullable
  readonly __WARNING_DEFAULT_FIELDS_ARE_NON_NULLABLE: T["HasDefault"] extends true
    ? T["IsNullable"] extends true
      ? "⚠️ Fields with defaults are non-nullable - nullable setting ignored"
      : "✅ Valid default field configuration"
    : "✅ Field without default";
};

// Enhanced base field interface with smart type inference
export interface BaseFieldType<
  T extends FieldState<any, any, any, any, any, any>
> {
  readonly "~fieldState": T;
  readonly infer: InferType<T>; // Smart inference for general use
  // Modifier methods
  nullable(): BaseFieldType<MakeNullable<T>>;
  // array(): BaseFieldType<MakeArray<T>>;
  // id(): BaseFieldType<MakeId<T>>;
  // unique(): BaseFieldType<MakeUnique<T>>;
  default(value: InferType<T>): BaseFieldType<MakeDefault<T>>;
}

// Utility types for extracting field information
export type ExtractFieldType<F> = F extends BaseFieldType<infer T> ? T : never;
export type ExtractInferredType<F> = F extends BaseFieldType<infer T>
  ? InferType<T>
  : never;
export type ExtractInputType<F> = F extends BaseFieldType<infer T>
  ? InferInputType<T>
  : never;
export type ExtractStorageType<F> = F extends BaseFieldType<infer T>
  ? InferStorageType<T>
  : never;
