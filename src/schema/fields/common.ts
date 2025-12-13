// Common Field Utilities
// Shared types and helpers for all field classes

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  transform,
  output,
  ZodMiniType,
  pipe,
  _default,
  ZodMiniJSONSchemaInternals,
  output as Output,
  input as Input,
  optional,
  core,
  ZodMiniArray,
  ZodMiniNullable,
  ZodMiniOptional,
} from "zod/v4-mini";

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
  defaultValue: DefaultValue<any> | undefined;
  autoGenerate: AutoGenerateType | undefined;
  schema: StandardSchemaV1 | undefined;
  base: ZodMiniType;
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

type MaybeZodArray<
  T extends ZodMiniType,
  S extends FieldState
> = S["array"] extends true ? ZodMiniArray<T> : T;
type MaybeZodNullable<
  T extends ZodMiniType,
  S extends FieldState
> = S["nullable"] extends true ? ZodMiniNullable<T> : T;

/**
 * Type for default value - can be direct value or factory function
 */
export type DefaultValue<T> = T | (() => T);

export type DefaultValueInput<S extends FieldState> = S["type"] extends "json"
  ? DefaultValue<
      S["schema"] extends StandardSchemaV1
        ? StandardSchemaV1.InferOutput<S["schema"]>
        : ZodMiniJSONSchemaInternals["output"]
    >
  : DefaultValue<
      MaybeNullable<MaybeArray<S["base"]["_zod"]["output"], S["array"]>>
    >;

export const createWithDefault = <F extends FieldState, B extends ZodMiniType>(
  f: F,
  base: B
) => {
  if (f.hasDefault) {
    return _default(optional(base), f.defaultValue);
  }
  return base;
};

export type SchemaWithDefault<F extends FieldState> =
  F["hasDefault"] extends true
    ? F["defaultValue"] extends DefaultValue<infer T>
      ? ZodMiniOptional<
          ZodMiniType<
            T,
            Input<MaybeZodNullable<MaybeZodArray<F["base"], F>, F>>,
            core.$ZodTypeInternals<
              T,
              Input<MaybeZodNullable<MaybeZodArray<F["base"], F>, F>>
            >
          >
        >
      : MaybeZodNullable<MaybeZodArray<F["base"], F>, F>
    : MaybeZodNullable<MaybeZodArray<F["base"], F>, F>;

// =============================================================================
// DEFAULT STATE FACTORY
// =============================================================================

/**
 * Creates a default initial state for a field type
 */
export const createDefaultState = <
  T extends ScalarFieldType,
  B extends ZodMiniType
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
  defaultValue: undefined,
  autoGenerate: undefined,
  schema: undefined,
  columnName: undefined,
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

export const shorthandFilter = <Z extends ZodMiniType>(
  schema: Z
): ZodMiniType<{ equals: output<Z> }, Z["_zod"]["input"]> =>
  pipe(
    schema,
    transform((v) => ({ equals: v }))
  );

export const shorthandUpdate = <Z extends ZodMiniType>(
  schema: Z
): ZodMiniType<{ set: output<Z> }, Z["_zod"]["input"]> =>
  pipe(
    schema,
    transform((v) => ({ set: v }))
  );

export type isOptional<F extends FieldState> = F["hasDefault"] extends true
  ? true
  : F["nullable"] extends true
  ? true
  : false;
