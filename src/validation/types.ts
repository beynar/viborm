import type { StandardSchemaV1 } from "@standard-schema/spec";
import { inferred } from "./inferred";
import type { JsonSchemaConverter } from "./json-schema/types";

// =============================================================================
// Core Type Utilities
// =============================================================================

/**
 * Prettify forces TypeScript to fully evaluate the type.
 * Recursively prettifies nested objects for cleaner type display.
 * Use sparingly - mapped types are expensive!
 */
export type Prettify<T> = T extends (...args: any[]) => any
  ? T // Preserve functions as-is
  : T extends object
  ? { [K in keyof T]: Prettify<T[K]> } & {}
  : T;

// =============================================================================
// Schema Interfaces (using interface for caching)
// =============================================================================

/**
 * Cast interface with OPTIONAL [inferred] - for pattern matching.
 * Uses a tuple [Input, Output] to carry both types.
 */
export interface Cast<TInput = unknown, TOutput = TInput> {
  [inferred]?: [TInput, TOutput];
}

/**
 * Thunk returning a Cast - for lazy type resolution in circular references.
 */
export interface ThunkCast<TInput = unknown, TOutput = TInput> {
  (): Cast<TInput, TOutput>;
}

/**
 * Base schema interface implementing StandardSchemaV1 and StandardJSONSchemaV1.
 * All VibORM schemas extend this interface.
 */
export interface VibSchema<TInput = unknown, TOutput = TInput>
  extends StandardSchemaV1<TInput, TOutput> {
  /**
   * Branded type carrier for pattern matching.
   * The tuple [Input, Output] allows extracting both types.
   */
  [inferred]: [TInput, TOutput];

  /**
   * Schema type identifier for runtime checks.
   */
  readonly type: string;

  /**
   * Standard properties extended with JSON Schema converter.
   */
  readonly "~standard": StandardSchemaV1<TInput, TOutput>["~standard"] & {
    /**
     * JSON Schema converter methods.
     * Implements StandardJSONSchemaV1 specification.
     */
    readonly jsonSchema: JsonSchemaConverter;
  };
}

// =============================================================================
// Options Interfaces (interface for caching)
// =============================================================================

/**
 * Options for scalar schemas (string, number, boolean, etc.)
 * TSchemaOut allows the `schema` property to influence output type.
 */
export interface ScalarOptions<T, TOut = T, TSchemaOut = TOut> {
  optional?: boolean;
  nullable?: boolean;
  array?: boolean;
  default?: any | (() => any) | undefined;
  /** Transform function applied AFTER schema validation */
  transform?: ((value: TSchemaOut) => TOut) | undefined;
  /** Additional StandardSchema for extra validation. Its output flows to transform. */
  schema?: StandardSchemaV1<T, TSchemaOut> | undefined;
}

/**
 * Options for object schemas.
 */
export interface ObjectOptions<T, TOut = T, TSchemaOut = TOut>
  extends ScalarOptions<T, TOut, TSchemaOut> {
  partial?: boolean;
  strict?: boolean;
}

// =============================================================================
// Type Inference - Optimized with constrained infer (TS 4.7+)
// =============================================================================

/**
 * Extract output type from branded [inferred] property.
 * Uses constrained infer for fewer type branches.
 */
export type InferOutput<Def> = Def extends { [inferred]?: [any, infer O] }
  ? O
  : Def extends () => { [inferred]?: [any, infer O] }
  ? O
  : unknown;

/**
 * Extract input type from branded [inferred] property.
 */
export type InferInput<Def> = Def extends { [inferred]?: [infer I, any] }
  ? I
  : Def extends () => { [inferred]?: [infer I, any] }
  ? I
  : unknown;

/**
 * Infer output shape from object field definitions.
 * Prettify applied once at the end, not per-field.
 */
export type InferOutputShape<Defs> = {
  [K in keyof Defs]: InferOutput<Defs[K]>;
};

/**
 * Infer input shape from object field definitions.
 */
export type InferInputShape<Defs> = {
  [K in keyof Defs]: InferInput<Defs[K]>;
};

// =============================================================================
// Computed Types - Optimized with lookup pattern
// =============================================================================

/**
 * Boolean key helper for option lookup.
 */
type BoolKey<T, K extends keyof T> = T[K] extends true ? "t" : "f";

/**
 * Compute input type using lookup pattern (fewer conditionals).
 */
export type ComputeInput<
  T,
  Opts extends ScalarOptions<any, any, any> | undefined
> = Opts extends ScalarOptions<any, any, any>
  ? ComputeInputLookup<T, Opts>[`${BoolKey<Opts, "array">}${BoolKey<
      Opts,
      "nullable"
    >}${BoolKey<Opts, "optional">}`]
  : T;

interface ComputeInputLookup<T, Opts extends ScalarOptions<any, any, any>> {
  ttt: T[] | null | undefined;
  ttf: Opts["default"] extends T | (() => T)
    ? T[] | null | undefined
    : T[] | null;
  tft: T[] | undefined;
  tff: Opts["default"] extends T | (() => T) ? T[] | undefined : T[];
  ftt: T | null | undefined;
  ftf: Opts["default"] extends T | (() => T) ? T | null | undefined : T | null;
  fft: T | undefined;
  fff: Opts["default"] extends T | (() => T) ? T | undefined : T;
}

/**
 * Extract the effective output type considering schema and transform.
 * Priority: transform > schema > base type
 */
type EffectiveOutput<
  T,
  Opts extends ScalarOptions<any, any, any>
> = Opts["transform"] extends (v: any) => infer R
  ? R
  : Opts["schema"] extends StandardSchemaV1<any, infer S>
  ? S
  : T;

/**
 * Compute output type using lookup pattern.
 */
export type ComputeOutput<
  T,
  Opts extends ScalarOptions<any, any, any> | undefined
> = Opts extends ScalarOptions<any, any, any>
  ? ComputeOutputLookup<EffectiveOutput<T, Opts>, Opts>[`${BoolKey<
      Opts,
      "array"
    >}${BoolKey<Opts, "nullable">}`]
  : T;

interface ComputeOutputLookup<T, _Opts> {
  tt: T[] | null;
  tf: T[];
  ft: T | null;
  ff: T;
}

// =============================================================================
// Validation Result Types (interfaces for caching)
// =============================================================================

export interface ValidationIssue {
  readonly message: string;
  readonly path?: readonly PropertyKey[];
}

export interface ValidationSuccess<T> {
  readonly value: T;
  readonly issues?: undefined;
}

export interface ValidationFailure {
  readonly issues: readonly ValidationIssue[];
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export function isSuccess<T>(
  result: ValidationResult<T>
): result is ValidationSuccess<T> {
  return !result.issues;
}

export function isFailure<T>(
  result: ValidationResult<T>
): result is ValidationFailure {
  return !!result.issues;
}

// =============================================================================
// Schema Type Guards
// =============================================================================

export function isVibSchema(value: unknown): value is VibSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    "~standard" in value &&
    typeof (value as any)["~standard"] === "object"
  );
}
