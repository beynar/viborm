import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  ScalarOptions,
  ValidationResult,
  ValidationIssue,
  VibSchema,
  ComputeInput,
  ComputeOutput,
} from "./types";
import { createJsonSchemaConverter } from "./json-schema/factory";

// =============================================================================
// Core Validation Primitives
// =============================================================================

/**
 * Create a failure result with a single issue.
 */
export function fail(
  message: string,
  path?: PropertyKey[]
): ValidationResult<never> {
  const issue: ValidationIssue =
    path && path.length > 0 ? { message, path } : { message };
  return { issues: [issue] };
}

/**
 * Create a success result.
 */
export function ok<T>(value: T): ValidationResult<T> {
  return { value };
}

// =============================================================================
// Set Theory Optimized Validators
// =============================================================================

// Pre-allocated error objects (avoid allocation in hot path)
const ARRAY_TYPE_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected array" })]),
});

// Pre-allocated null/undefined results for fast paths
const OK_NULL = Object.freeze({ value: null });
const OK_UNDEFINED = Object.freeze({ value: undefined });

/**
 * Validate array items with the provided validator.
 * Shared by both array() wrapper and options.array.
 */
function validateArray<T>(
  value: unknown,
  validate: (v: unknown) => ValidationResult<T>
): ValidationResult<T[]> {
  if (!Array.isArray(value)) {
    return ARRAY_TYPE_ERROR as ValidationResult<T[]>;
  }

  const len = value.length;
  if (len === 0) return ok([]);

  const results = new Array<T>(len);
  for (let i = 0; i < len; i++) {
    const r = validate(value[i]);
    if (r.issues) {
      const issue = r.issues[0]!;
      return fail(
        issue.message as string,
        issue.path
          ? ([i] as PropertyKey[]).concat(issue.path as PropertyKey[])
          : [i]
      );
    }
    results[i] = (r as { value: T }).value;
  }
  return ok(results);
}

// =============================================================================
// 8 Pre-defined Validator Factories (Set Theory Approach)
// =============================================================================
// Using bit flags: nullable=4, optional=2, array=1
// This eliminates runtime option checking during validation

type ValidatorFn<T> = (value: unknown) => ValidationResult<T>;
type ValidatorFactory = <T>(v: ValidatorFn<T>) => ValidatorFn<any>;

const FACTORIES: ValidatorFactory[] = [
  // 000: no options - pass through
  (v) => v,

  // 001: array only
  (v) => (val) => validateArray(val, v),

  // 010: optional only
  (v) => (val) => val === undefined ? OK_UNDEFINED : v(val),

  // 011: optional + array
  (v) => (val) => val === undefined ? OK_UNDEFINED : validateArray(val, v),

  // 100: nullable only
  (v) => (val) => val === null ? OK_NULL : v(val),

  // 101: nullable + array
  (v) => (val) => val === null ? OK_NULL : validateArray(val, v),

  // 110: nullable + optional (use == null for both!)
  (v) => (val) => val == null ? ok(val) : v(val),

  // 111: nullable + optional + array
  (v) => (val) => val == null ? ok(val) : validateArray(val, v),
];

/**
 * Select factory index using bit flags (O(1) lookup).
 */
function selectFactoryIndex(options?: {
  nullable?: boolean;
  optional?: boolean;
  array?: boolean;
}): number {
  if (!options) return 0;
  return (
    (options.nullable ? 4 : 0) |
    (options.optional ? 2 : 0) |
    (options.array ? 1 : 0)
  );
}

// =============================================================================
// Factories with Default (for optional + default cases)
// =============================================================================

/**
 * Create validator that returns default when undefined.
 * Default is computed and returned directly inside the optional check.
 */
function createOptionalWithDefault<T>(
  validate: ValidatorFn<T>,
  getDefault: () => T
): ValidatorFn<T> {
  return (val) => (val === undefined ? ok(getDefault()) : validate(val));
}

function createNullableOptionalWithDefault<T>(
  validate: ValidatorFn<T>,
  getDefault: () => T
): ValidatorFn<T | null> {
  return (val) => {
    if (val === undefined) return ok(getDefault());
    if (val === null) return OK_NULL as ValidationResult<T | null>;
    return validate(val) as ValidationResult<T | null>;
  };
}

function createOptionalArrayWithDefault<T>(
  validate: ValidatorFn<T>,
  getDefault: () => T[]
): ValidatorFn<T[]> {
  return (val) =>
    val === undefined ? ok(getDefault()) : validateArray(val, validate);
}

function createNullableOptionalArrayWithDefault<T>(
  validate: ValidatorFn<T>,
  getDefault: () => T[]
): ValidatorFn<T[] | null> {
  return (val) => {
    if (val === undefined) return ok(getDefault());
    if (val === null) return OK_NULL as ValidationResult<T[] | null>;
    return validateArray(val, validate) as ValidationResult<T[] | null>;
  };
}

// =============================================================================
// Optimized Validator Builder (Set Theory + Composition)
// =============================================================================

/**
 * Build an optimized validator at schema creation time.
 * Uses set theory approach for nullable/optional/array/default combinations.
 *
 * @param baseValidate - The base type validator
 * @param options - Schema options
 * @param typeName - Type name for error messages (unused but kept for API consistency)
 */
export function buildValidator<T, TOut, TSchemaOut = T>(
  baseValidate: ValidatorFn<T>,
  options: ScalarOptions<T, TOut, TSchemaOut> | undefined,
  _typeName: string
): ValidatorFn<TOut> {
  // Fast path: no options at all
  if (!options) {
    return baseValidate as unknown as ValidatorFn<TOut>;
  }

  const {
    nullable,
    optional,
    array,
    default: defaultVal,
    transform,
    schema,
  } = options;

  // Check what we have
  const hasDefault = defaultVal !== undefined;
  const hasTransform = transform !== undefined;
  const hasSchema = schema !== undefined;

  // Build the core validator (base + schema + transform chain)
  let validate: ValidatorFn<any> = baseValidate;

  // Chain custom schema validation (if any)
  if (hasSchema) {
    const schemaValidate = schema!["~standard"].validate;
    const prev = validate;
    validate = (v): ValidationResult<any> => {
      const r = prev(v);
      if (r.issues) return r;
      const sr = schemaValidate((r as { value: any }).value);
      if ("then" in sr) return fail("Async schemas are not supported");
      if (sr.issues) return { issues: sr.issues as readonly ValidationIssue[] };
      return ok((sr as { value: any }).value);
    };
  }

  // Chain transform (if any)
  if (hasTransform) {
    const fn = transform!;
    const prev = validate;
    validate = (v) => {
      const r = prev(v);
      if (r.issues) return r;
      return ok(fn((r as { value: any }).value));
    };
  }

  // Now apply nullable/optional/array/default handling
  // Default is computed and returned INSIDE the optional check

  if (hasDefault) {
    // Compute default getter once
    const getDefault =
      typeof defaultVal === "function"
        ? (defaultVal as () => any)
        : () => defaultVal;

    // Apply the appropriate factory with default
    if (array) {
      if (nullable) {
        return createNullableOptionalArrayWithDefault(
          validate,
          getDefault
        ) as ValidatorFn<TOut>;
      }
      return createOptionalArrayWithDefault(
        validate,
        getDefault
      ) as ValidatorFn<TOut>;
    }
    if (nullable) {
      return createNullableOptionalWithDefault(
        validate,
        getDefault
      ) as ValidatorFn<TOut>;
    }
    return createOptionalWithDefault(validate, getDefault) as ValidatorFn<TOut>;
  }

  // No default - use pure 8-way factory
  if (array) {
    const itemValidator = validate;
    validate = (val) => validateArray(val, itemValidator);
    const wrapperIndex = (nullable ? 4 : 0) | (optional ? 2 : 0);
    if (wrapperIndex > 0) {
      validate = FACTORIES[wrapperIndex]!(validate);
    }
  } else {
    const factoryIndex = selectFactoryIndex(options);
    if (factoryIndex > 0) {
      validate = FACTORIES[factoryIndex]!(validate);
    }
  }

  return validate as ValidatorFn<TOut>;
}

// =============================================================================
// Schema Builder (Returns complete schema object)
// =============================================================================

/**
 * Build a complete schema object with optimized validator.
 * This is the main entry point for creating scalar schemas.
 *
 * @param type - Schema type name
 * @param baseValidate - The base type validator
 * @param options - Schema options
 * @param extras - Additional properties to add to the schema (e.g., `value` for literal)
 */
export function buildSchema<
  T,
  const Opts extends ScalarOptions<T, any> | undefined,
  TExtras extends Record<string, unknown> = {}
>(
  type: string,
  baseValidate: ValidatorFn<T>,
  options: Opts,
  extras?: TExtras
): VibSchema<ComputeInput<T, Opts>, ComputeOutput<T, Opts>> &
  TExtras & { type: string } {
  const validate = buildValidator(baseValidate, options, type);

  const schema = {
    type,
    options,
    ...extras,
    "~standard": {
      version: 1 as const,
      vendor: "viborm" as const,
      validate,
      // Lazy jsonSchema - converter is created when first accessed
      get jsonSchema() {
        const converter = createJsonSchemaConverter(
          schema as unknown as VibSchema<unknown, unknown>
        );
        // Replace getter with static value for subsequent access
        Object.defineProperty(this, "jsonSchema", {
          value: converter,
          writable: false,
          enumerable: true,
        });
        return converter;
      },
    },
  };

  return schema as VibSchema<ComputeInput<T, Opts>, ComputeOutput<T, Opts>> &
    TExtras & { options: Opts; type: string };
}

// =============================================================================
// Reusable Validation Logic (Exported for wrapper schemas)
// =============================================================================

/**
 * Validate an array of items using the provided validate function.
 * Exported for use by array() wrapper schema.
 */
export function validateArrayItems<T, TOut = T>(
  value: unknown,
  validate: (item: unknown) => any,
  transform?: (item: T) => TOut
): ValidationResult<TOut[]> {
  if (!Array.isArray(value)) {
    return ARRAY_TYPE_ERROR as ValidationResult<TOut[]>;
  }

  const len = value.length;
  if (len === 0) return ok([]);

  const results = new Array<TOut>(len);
  for (let i = 0; i < len; i++) {
    const itemResult = validate(value[i]);
    if ("then" in itemResult)
      return fail("Async schemas are not supported", [i]);
    if (itemResult.issues) {
      const issue = itemResult.issues[0]!;
      return fail(
        issue.message as string,
        issue.path
          ? ([i] as PropertyKey[]).concat(issue.path as PropertyKey[])
          : [i]
      );
    }
    results[i] = transform
      ? transform(itemResult.value as T)
      : (itemResult.value as TOut);
  }
  return ok(results);
}

/**
 * Get default value from options.
 */
export function getDefault<T>(
  options: ScalarOptions<T, any> | undefined
): T | undefined {
  if (options?.default === undefined) return undefined;
  return typeof options.default === "function"
    ? (options.default as () => T)()
    : options.default;
}

/**
 * Create a StandardSchema-compatible schema object.
 */
export function createSchema<TInput, TOutput>(
  type: string,
  validate: (value: unknown) => ValidationResult<TOutput>
): VibSchema<TInput, TOutput> {
  const schema = {
    type,
    "~standard": {
      version: 1 as const,
      vendor: "viborm" as const,
      validate,
      // Lazy jsonSchema - converter is created when first accessed
      get jsonSchema() {
        const converter = createJsonSchemaConverter(
          schema as unknown as VibSchema<unknown, unknown>
        );
        // Replace getter with static value for subsequent access
        Object.defineProperty(this, "jsonSchema", {
          value: converter,
          writable: false,
          enumerable: true,
        });
        return converter;
      },
    },
  };

  // Add the inferred property for type branding
  Object.defineProperty(schema, " vibInferred", {
    value: undefined,
    enumerable: false,
  });

  return schema as VibSchema<TInput, TOutput>;
}

/**
 * Validate a value against a StandardSchema.
 */
export function validateSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown
): ValidationResult<T> {
  const result = schema["~standard"].validate(value);
  if ("then" in result) {
    return fail("Async schemas are not supported");
  }
  if (result.issues) {
    return { issues: result.issues as readonly ValidationIssue[] };
  }
  return ok((result as { value: T }).value);
}
