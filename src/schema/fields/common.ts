// Common Field Utilities
// Shared types and helpers for all field classes

import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { VibSchema, InferInput, InferOutput } from "@validation";
import { AnyEnumSchema } from "@validation/schemas/enum";

// =============================================================================
// SCHEMA NAMES (hydrated by client at initialization)
// =============================================================================

/**
 * Name slots for fields, models, and relations.
 * These are hydrated by the client at initialization time when the full
 * schema context is available.
 *
 * - ts: TypeScript/schema key name (e.g., "email", "User")
 * - sql: Resolved database name (e.g., "email_column", "users")
 */
export interface SchemaNames {
  /** TypeScript key name in the schema */
  ts?: string;
  /** Resolved SQL name (column/table) */
  sql?: string;
}

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
  | "date"
  | "time"
  | "bigint"
  | "json"
  | "blob"
  | "vector"
  | "point"
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
  default: DefaultValue<any> | undefined;
  autoGenerate: AutoGenerateType | undefined;
  schema: StandardSchemaV1<any, any> | undefined;
  optional: boolean;
  /** Custom column name in the database (set via .map()) */
  columnName: string | undefined;
  base: VibSchema;
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

export const updateState = <
  State extends FieldState,
  Update extends Partial<FieldState>
>(
  state: State,
  update: Update
) => {
  return { ...state, ...update } as UpdateState<State, Update>;
};

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
export type DefaultValue<T> = T | (() => T);

export type DefaultValueInput<S extends FieldState> = DefaultValue<
  MaybeNullable<MaybeArray<InferInput<S["base"]>, S["array"]>, S["nullable"]>
>;

// =============================================================================
// DEFAULT STATE FACTORY
// =============================================================================

/**
 * Creates a default initial state for a field type
 */
export const createDefaultState = <
  T extends ScalarFieldType,
  B extends VibSchema
>(
  type: T,
  base: B
) => ({
  type,
  nullable: false,
  array: false,
  hasDefault: false,
  isId: false,
  isUnique: false,
  default: undefined,
  autoGenerate: undefined,
  schema: undefined,
  columnName: undefined,
  optional: false,
  base,
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

// =============================================================================
// SCHEMA SHORTHANDS
// =============================================================================

/**
 * Coerces a value to a filter object with `equals` key.
 * Used for shorthand filter syntax: `"value"` -> `{ equals: "value" }`
 */
export const shorthandFilter = <S extends VibSchema>(schema: S) =>
  v.coerce(schema, (val: S[" vibInferred"]["0"]) => ({ equals: val }));

/**
 * Coerces a value to an update object with `set` key.
 * Used for shorthand update syntax: `"value"` -> `{ set: "value" }`
 */
export const shorthandUpdate = <S extends VibSchema>(schema: S) =>
  v.coerce(schema, (val: S[" vibInferred"]["0"]) => ({ set: val }));

/**
 * Coerces a single value to an array.
 * Used for shorthand array syntax: `"value"` -> `["value"]`
 */
export const shorthandArray = <S extends VibSchema>(schema: S) =>
  v.coerce(schema, (val: S[" vibInferred"]["0"]) => [val]);
