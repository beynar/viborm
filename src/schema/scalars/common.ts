// Common Scalar Utilities
// Shared types and helpers for all scalar classes

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { InferInput, VibSchema } from "@validation";
import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
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
  | "number"
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

/**
 * A generator declaration.
 *
 * `kind` is the only statement of which generator runs. `prefix` and `length`
 * are declaration facts the string generators otherwise bake into their default
 * closure, where nothing can read them back; state is their durable home so a
 * serializer can restate the declaration that produced the closure.
 * `increment`/`now`/`updatedAt` take neither.
 */
export interface AutoGenerate {
  kind: AutoGenerateType;
  prefix?: string | undefined;
  length?: number | undefined;
}

/**
 * The closures the generator modifiers installed.
 *
 * A generator writes TWO facts: `autoGenerate`, which is the declaration, and
 * `default`, which is the closure that produces the value. A later
 * `.default(fn)` replaces only the second, so `autoGenerate !== undefined` is
 * not evidence that the closure standing in `default` is the generator's — and
 * a consumer that restates a declaration from state (the JSON serializer) would
 * otherwise silently substitute a random generator for a caller's own function.
 *
 * Identity is the only thing that distinguishes them, so identity is what is
 * recorded. One owner, beside the declaration it belongs to; nothing outside
 * the eight modifier writers may add to it.
 */
const GENERATOR_DEFAULTS = new WeakSet<object>();

/** Mark a closure as the default a generator modifier installed. */
export function generatorDefault<F extends () => unknown>(closure: F): F {
  GENERATOR_DEFAULTS.add(closure);
  return closure;
}

/** Whether this default value IS a generator's own installed closure. */
export function isGeneratorDefault(value: unknown): boolean {
  return typeof value === "function" && GENERATOR_DEFAULTS.has(value);
}

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
  autoGenerate: AutoGenerate | undefined;
  /** Runtime create validation for portable auto-increment semantics. */
  disallowZero?: boolean;
  schema: StandardSchemaV1<any, any> | undefined;
  optional: boolean;
  /** Custom column name in the database (set via .map()) */
  columnName: string | undefined;
  base: VibSchema;
  withTimezone?: boolean | undefined;
  /**
   * The declared fixed-decimal domain, frozen at `s.decimal({...})`.
   *
   * It is the ONE source of truth for input validation, physical DDL, literal
   * encoding, result decoding, comparison and aggregate lowering, arithmetic
   * rounding and overflow, list-member encoding, and migration compatibility.
   * No adapter, driver, result parser, or migration component stores a second
   * precision or scale decision, and every modifier carries THIS object by
   * reference rather than rebuilding one.
   */
  decimal?: DecimalDescriptor | undefined;
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

/**
 * The input accepted by the scalar's current base schema, or a factory for it.
 *
 * The base schema already owns the scalar's nullable and array wrappers. Adding
 * them again here turns a list default into a list of lists at the type level
 * (`string[][]` for `s.string().array()`), while runtime validation correctly
 * expects `string[]`. Read the one trusted shape instead of reconstructing it.
 */
export type DefaultValueInput<S extends ScalarState> = DefaultValue<
  InferInput<S["base"]>
>;

// =============================================================================
// DEFAULT STATE FACTORY
// =============================================================================

/**
 * Creates a default initial state for a scalar type
 */
export const createDefaultState = <T extends ScalarType, B extends VibSchema>(
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
