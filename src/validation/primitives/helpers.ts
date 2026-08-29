import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createJsonSchemaConverter } from "../json-schema/factory";
import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  ValidationFailure,
  ValidationIssue,
  ValidationResult,
  VibSchema,
} from "../types";
import { isFunction } from "../value-guards";

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

/** Copy Standard Schema issues into VibORM's property-key path representation. */
export function standardSchemaFailure(
  issues: readonly StandardSchemaV1.Issue[]
): ValidationFailure {
  return {
    issues: issues.map((issue) => {
      if (issue.path === undefined) return { message: issue.message };
      return {
        message: issue.message,
        path: issue.path.map((segment) =>
          typeof segment === "object" ? segment.key : segment
        ),
      };
    }),
  };
}

// =============================================================================
// Set Theory Optimized Validators
// =============================================================================

// Pre-allocated error objects (avoid allocation in hot path)
const ARRAY_TYPE_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected array" })]),
});

// Pre-allocated null/undefined results for fast paths
export const OK_NULL = Object.freeze({ value: null });
export const OK_UNDEFINED = Object.freeze({ value: undefined });

/**
 * Validate array items with the provided validator.
 * Shared by both array() wrapper and options.array.
 */
export function validateArray<T>(
  value: unknown,
  validate: (v: unknown) => ValidationResult<T>
): ValidationResult<T[]> {
  try {
    if (!Array.isArray(value)) {
      return ARRAY_TYPE_ERROR;
    }
  } catch {
    return fail("Could not inspect array");
  }

  let len: number;
  try {
    len = value.length;
  } catch {
    return fail("Could not read array length");
  }
  if (!Number.isInteger(len) || len < 0) {
    return ARRAY_TYPE_ERROR;
  }
  if (len === 0) return ok([]);

  const results = new Array<T>(len);
  for (let i = 0; i < len; i++) {
    let member: unknown;
    try {
      member = value[i];
    } catch {
      return fail("Could not read array member", [i]);
    }
    const r = validate(member);
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

type ValidatorFn<T> = (value: unknown) => ValidationResult<T>;

// =============================================================================
// Factories with Default (for optional + default cases)
// =============================================================================

/**
 * Resolve a default when undefined, contain a throwing factory, and pass the
 * resolved value through the already-composed field validator.
 */
function createOptionalWithDefault<T>(
  validate: ValidatorFn<T>,
  getDefault: () => unknown
): ValidatorFn<T> {
  return (val) => {
    if (val !== undefined) return validate(val);
    let resolved: unknown;
    try {
      resolved = getDefault();
    } catch (error) {
      return fail(`Default failed: ${describeDefaultFailure(error)}`);
    }
    return validate(resolved);
  };
}

/** Render hostile thrown values without letting their coercion escape. */
function describeDefaultFailure(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return "unrenderable thrown value";
  }
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
    disallowZero,
  } = options;

  // Check what we have
  const hasDefault = defaultVal !== undefined;
  const hasTransform = transform !== undefined;
  const hasSchema = schema !== undefined;

  // Build the core validator (base + schema + transform chain)
  let validate: ValidatorFn<any> = baseValidate;

  if (disallowZero) {
    const prev = validate;
    validate = (value): ValidationResult<any> => {
      const result = prev(value);
      if (result.issues) return result;
      const validated = (result as { value: unknown }).value;
      if (validated === 0 || validated === 0n) {
        return fail(
          "Explicit zero is not portable for an auto-increment field"
        );
      }
      return result;
    };
  }

  // Chain custom schema validation (if any)

  if (hasSchema) {
    const schemaValidate = schema!["~standard"].validate;
    const prev = validate;
    validate = (v): ValidationResult<any> => {
      const r = prev(v);
      if (r.issues) return r;
      const sr = schemaValidate((r as { value: any }).value);
      if ("then" in sr) return fail("Async schemas are not supported");
      if (sr.issues) return standardSchemaFailure(sr.issues);
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
      try {
        return ok(fn((r as { value: any }).value));
      } catch (error) {
        return fail(
          `Transform failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };
  }

  // Compose the complete field validator before the default trigger. A
  // resolved literal or factory value is an ordinary untrusted field value:
  // it crosses scalar/custom/transform, member-array, and nullability rules in
  // exactly the same order as an explicit input.

  if (array) {
    const itemValidator = validate;
    validate = (val) => validateArray(val, itemValidator);
  }

  if (nullable) {
    const nonNullValidate = validate;
    validate = (val) => (val === null ? OK_NULL : nonNullValidate(val));
  }

  if (hasDefault) {
    // Compute default getter once
    const getDefault = isFunction(defaultVal)
      ? (defaultVal as () => any)
      : () => defaultVal;

    return createOptionalWithDefault(validate, getDefault) as ValidatorFn<TOut>;
  }

  // Nullability is already part of the composed validator. Only optionality
  // remains when no default consumes undefined.
  if (optional) {
    const requiredValidate = validate;
    validate = (val) =>
      val === undefined ? OK_UNDEFINED : requiredValidate(val);
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
  TExtras extends Record<string, unknown> = Record<never, never>,
>(
  type: string,
  baseValidate: ValidatorFn<T>,
  options: Opts,
  extras?: TExtras
): VibSchema<ComputeInput<T, Opts>, ComputeOutput<T, Opts>> &
  TExtras & { type: string; options: Opts; acceptsUndefined: boolean } {
  const validate = buildValidator(baseValidate, options, type);

  // Pre-compute whether this schema accepts undefined
  // True if: optional, or has a default value
  const acceptsUndefined =
    options?.optional === true || options?.default !== undefined;

  const schema = {
    type,
    options,
    acceptsUndefined,
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

  // Add the inferred property for type branding
  Object.defineProperty(schema, " vibInferred", {
    value: undefined,
    enumerable: false,
  });

  return schema as VibSchema<ComputeInput<T, Opts>, ComputeOutput<T, Opts>> &
    TExtras & { options: Opts; type: string; acceptsUndefined: boolean };
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
  validate: (item: unknown) => any
): ValidationResult<TOut[]> {
  if (!Array.isArray(value)) {
    return ARRAY_TYPE_ERROR as ValidationResult<TOut[]>;
  }

  const len = value.length;
  if (len === 0) return ok([]);

  const results = new Array<TOut>(len);
  for (let i = 0; i < len; i++) {
    const itemResult = validate(value[i]);
    if (itemResult.issues) {
      const issue = itemResult.issues[0]!;
      return fail(
        issue.message as string,
        issue.path
          ? ([i] as PropertyKey[]).concat(issue.path as PropertyKey[])
          : [i]
      );
    }
    results[i] = itemResult.value as TOut;
  }
  return ok(results);
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
export function validateSchema<const S extends StandardSchemaV1>(
  schema: S,
  value: unknown
): ValidationResult<StandardSchemaV1.InferOutput<S>> {
  const result = schema["~standard"].validate(value);
  if ("then" in result) {
    return fail("Async schemas are not supported");
  }
  if (result.issues) {
    return standardSchemaFailure(result.issues);
  }
  return ok((result as { value: StandardSchemaV1.InferOutput<S> }).value);
}
