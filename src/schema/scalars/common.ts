// Common Scalar Utilities
// Shared types and helpers for all scalar classes

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { InferInput, VibSchema } from "@validation";
import type { Scalar } from "./base";

// =============================================================================
// SCHEMA NAMES (hydrated by client at initialization)
// =============================================================================

/**
 * Name slots for models, scalars, and relations.
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

/**
 * Hydrated schema names - guaranteed to have both ts and sql defined.
 * Returned by model["~"].getFieldName() for scalar keys and model["~"].getRelationName() for relation keys.
 */
export interface HydratedSchemaNames {
  /** TypeScript key name in the schema */
  ts: string;
  /** Resolved SQL name (column/table) */
  sql: string;
}

// =============================================================================
// SCALAR TYPES
// =============================================================================

export type ScalarType =
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
// SCALAR STATE
// =============================================================================

/**
 * Complete state for a scalar instance.
 * This is the single generic that flows through the scalar class.
 */

export interface ScalarState<T extends ScalarType = ScalarType> {
  type: T;
  nullable: boolean;
  array: boolean;
  hasDefault: boolean;
  isId: boolean;
  isUnique: boolean;
  default: DefaultValue<any> | undefined;
  autoGenerate: AutoGenerateType | undefined;
  /** Runtime create validation for portable auto-increment semantics. */
  disallowZero?: boolean;
  schema: StandardSchemaV1<any, any> | undefined;
  optional: boolean;
  /** Custom column name in the database (set via .map()) */
  columnName: string | undefined;
  base: VibSchema;
  withTimezone?: boolean | undefined;
  /** Fixed vector length for pgvector-backed vector scalars. */
  dimension?: number | undefined;
  /** Custom enum type name in the database (set via .name() on enum scalars) */
  enumName?: string | undefined;
}

// =============================================================================
// STATE UPDATE HELPER
// =============================================================================

/**
 * Computes the new state type after applying an update.
 * Used by chainable methods to derive the return type.
 *
 * @example
 * nullable(): StringScalar<UpdateState<State, { nullable: true }>>
 */
export type UpdateState<
  State extends ScalarState,
  Update extends Partial<ScalarState>,
> = Omit<State, keyof Update> & Update;

export const updateState = <
  F extends Scalar,
  const Update extends Partial<ScalarState>,
>(
  scalar: F,
  update: Update
) => {
  return { ...scalar["~"].state, ...update } as UpdateState<
    F["~"]["state"],
    Update
  >;
};

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Conditionally wraps a type with null
 */
export type MaybeNullable<
  T,
  Nullable extends boolean = false,
> = Nullable extends true ? T | null : T;

/**
 * Conditionally wraps a type as array
 */
export type MaybeArray<
  T,
  IsArray extends boolean = false,
> = IsArray extends true ? T[] : T;

/**
 * Type for default value - can be direct value or factory function
 */
export type DefaultValue<T> = T | (() => T);

export type DefaultValueInput<S extends ScalarState> = DefaultValue<
  MaybeNullable<MaybeArray<InferInput<S["base"]>, S["array"]>, S["nullable"]>
>;

// =============================================================================
// DEFAULT STATE FACTORY
// =============================================================================

/**
 * Creates a default initial state for a scalar type
 */
export const createDefaultState = <
  T extends ScalarType,
  B extends VibSchema,
  Values extends string[] = string[],
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
  disallowZero: false,
  schema: undefined,
  columnName: undefined,
  optional: false,
  withTimezone: false,
  base,
});

// =============================================================================
// INFER HELPERS (for type-level inference from state)
// =============================================================================

/**
 * Infers the base TypeScript type from a scalar state
 */
export type InferBaseType<
  BaseType,
  State extends ScalarState,
> = State["array"] extends true
  ? State["nullable"] extends true
    ? (BaseType | null)[]
    : BaseType[]
  : State["nullable"] extends true
    ? BaseType | null
    : BaseType;

/**
 * Infers the create input type from a scalar state
 */
export type InferCreateType<
  BaseType,
  State extends ScalarState,
> = State["hasDefault"] extends true
  ? State["nullable"] extends true
    ? BaseType | null | undefined
    : BaseType | undefined
  : State["nullable"] extends true
    ? BaseType | null
    : BaseType;

// =============================================================================
// SCHEMA SHORTHANDS (re-exported from validation primitives)
// =============================================================================

export {
  shorthandArray,
  shorthandFilter,
  shorthandUpdate,
} from "@validation/primitives/shorthand";
