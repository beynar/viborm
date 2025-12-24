// Common Field Utilities
// Shared types and helpers for all field classes

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  BaseSchema,
  Default,
  NullableSchema,
  ArraySchema,
  ObjectSchema,
  InferInput,
  InferOutput,
  OptionalSchema,
  lazy,
  union,
  LazySchema,
  array,
  optional,
  record,
  pipe,
  transform,
  object,
  string,
  null_,
  boolean,
  number,
} from "valibot";

// JSON value type matching Prisma's JsonValue
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonSchema = BaseSchema<JsonValue, JsonValue, any>;
export const json: JsonSchema = lazy(() =>
  union([
    null_(),
    boolean(),
    number(),
    string(),
    array(json),
    record(string(), json),
  ])
);

export type AnySchema = BaseSchema<any, any, any>;
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
  base: BaseSchema<any, any, any>;
  optional: boolean;
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

export type MaybeArraySchema<
  T extends AnySchema,
  S extends FieldState
> = S["array"] extends true ? ArraySchema<T, undefined> : T;

export type MaybeNullableSchema<
  T extends AnySchema,
  S extends FieldState
> = S["nullable"] extends true ? NullableSchema<T, undefined> : T;

/**
 * Type for default value - can be direct value or factory function
 */
export type DefaultValue<T> = T | (() => T);

export type DefaultValueInput<S extends FieldState> = S["type"] extends "json"
  ? DefaultValue<
      S["schema"] extends StandardSchemaV1
        ? StandardSchemaV1.InferOutput<S["schema"]>
        : InferOutput<typeof json>
    >
  : DefaultValue<
      MaybeNullable<
        MaybeArray<InferInput<S["base"]>, S["array"]>,
        S["nullable"]
      >
    >;

export type SchemaWithDefault<F extends FieldState> =
  F["hasDefault"] extends true
    ? F["default"] extends DefaultValue<infer T>
      ? OptionalSchema<
          MaybeNullableSchema<MaybeArraySchema<F["base"], F>, F>,
          T
        >
      : MaybeNullableSchema<MaybeArraySchema<F["base"], F>, F>
    : MaybeNullableSchema<MaybeArraySchema<F["base"], F>, F>;

// =============================================================================
// DEFAULT STATE FACTORY
// =============================================================================

/**
 * Creates a default initial state for a field type
 */
export const createDefaultState = <
  T extends ScalarFieldType,
  B extends AnySchema
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

export const createWithDefault = <F extends FieldState, B extends AnySchema>(
  f: F,
  base: B
) => {
  if (f.hasDefault) {
    return optional(base, f.default);
  }
  return base;
};

export const shorthandFilter = <Z extends AnySchema>(schema: Z) =>
  pipe(
    schema,
    transform((v) => {
      return { equals: v };
    })
  );

export const shorthandUpdate = <Z extends AnySchema>(
  schema: Z
): BaseSchema<InferInput<Z>, { set: InferOutput<Z> }, any> =>
  pipe(
    schema,
    transform((v) => ({ set: v }))
  );

export const extend = <
  T extends ObjectSchema<any, any>,
  U extends Record<string, AnySchema>
>(
  base: T,
  extension: U
) => {
  return object({
    ...base.entries,
    ...extension,
  }) as ObjectSchema<T["entries"] & U, undefined>;
};
