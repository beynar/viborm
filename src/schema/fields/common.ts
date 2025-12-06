// Common Field Utilities
// Shared types and helpers for all field classes

import type { StandardSchemaV1 } from "@standard-schema/spec";

// =============================================================================
// SCALAR TYPES
// =============================================================================

export type ScalarFieldType =
  | "string"
  | "int"
  | "float"
  | "decimal"
  | "boolean"
  | "datetime"
  | "bigint"
  | "json"
  | "blob"
  | "vector"
  | "enum";

export type AutoGenerateType =
  | "uuid"
  | "ulid"
  | "nanoid"
  | "cuid"
  | "increment"
  | "now"
  | "updatedAt";

// =============================================================================
// FIELD STATE
// =============================================================================

/**
 * Complete state for a field instance.
 * This is the single generic that flows through the field class.
 */
export interface FieldState<T extends ScalarFieldType = ScalarFieldType> {
  type: T;
  nullable: boolean;
  array: boolean;
  hasDefault: boolean;
  isId: boolean;
  isUnique: boolean;
  defaultValue: any;
  autoGenerate: AutoGenerateType | undefined;
  customValidator: StandardSchemaV1 | undefined;
  /** Custom column name in the database (set via .map()) */
  columnName: string | undefined;
}

// =============================================================================
// STATE UPDATE HELPER
// =============================================================================

/**
 * Computes the new state type after applying an update.
 * Used by chainable methods to derive the return type.
 *
 * @example
 * nullable(): StringField<UpdateState<State, { nullable: true }>>
 */
export type UpdateState<
  State extends FieldState,
  Update extends Partial<FieldState>
> = Omit<State, keyof Update> & Update;

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Conditionally wraps a type with null
 */
export type MaybeNullable<
  T,
  Nullable extends boolean = false
> = Nullable extends true ? T | null : T;

/**
 * Conditionally wraps a type as array
 */
export type MaybeArray<
  T,
  IsArray extends boolean = false
> = IsArray extends true ? T[] : T;

/**
 * Type for default value - can be direct value or factory function
 */
export type DefaultValue<
  T,
  IsArray extends boolean = false,
  Nullable extends boolean = false
> =
  | MaybeNullable<MaybeArray<T, IsArray>, Nullable>
  | (() => MaybeNullable<MaybeArray<T, IsArray>, Nullable>);

// =============================================================================
// DEFAULT STATE FACTORY
// =============================================================================

/**
 * Creates a default initial state for a field type
 */
export const createDefaultState = <T extends ScalarFieldType>(
  type: T
): FieldState<T> => ({
  type,
  nullable: false,
  array: false,
  hasDefault: false,
  isId: false,
  isUnique: false,
  defaultValue: undefined,
  autoGenerate: undefined,
  customValidator: undefined,
  columnName: undefined,
});

// =============================================================================
// INFER HELPERS (for type-level inference from state)
// =============================================================================

/**
 * Infers the base TypeScript type from a field state
 */
export type InferBaseType<
  BaseType,
  State extends FieldState
> = State["array"] extends true
  ? State["nullable"] extends true
    ? (BaseType | null)[]
    : BaseType[]
  : State["nullable"] extends true
  ? BaseType | null
  : BaseType;

/**
 * Infers the create input type from a field state
 */
export type InferCreateType<
  BaseType,
  State extends FieldState
> = State["hasDefault"] extends true
  ? State["nullable"] extends true
    ? BaseType | null | undefined
    : BaseType | undefined
  : State["nullable"] extends true
  ? BaseType | null
  : BaseType;
