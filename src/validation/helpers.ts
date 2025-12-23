import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  ScalarOptions,
  ValidationResult,
  ValidationIssue,
  VibSchema,
} from "./types";

// =============================================================================
// Validation Helpers
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

/**
 * Get default value from options.
 */
export function getDefault<T>(
  options: ScalarOptions<T, any> | undefined
): T | undefined {
  if (!options?.default) return undefined;
  return typeof options.default === "function"
    ? (options.default as () => T)()
    : options.default;
}

/**
 * Apply options processing (nullable, optional, default, transform, schema).
 * This is the core logic that handles all the option flags.
 *
 * @param value - The value to validate
 * @param baseValidate - The base type validator function
 * @param options - The schema options
 * @param typeName - Type name for error messages
 */
export function applyOptions<T, TOut, TSchemaOut = T>(
  value: unknown,
  baseValidate: (v: unknown) => ValidationResult<T>,
  options: ScalarOptions<T, TOut, TSchemaOut> | undefined,
  typeName: string
): ValidationResult<TOut> {
  // Handle undefined
  if (value === undefined) {
    if (options?.default !== undefined) {
      value = getDefault(options);
    } else if (options?.optional) {
      return ok(undefined as unknown as TOut);
    } else {
      return fail(`Expected ${typeName}, received undefined`);
    }
  }

  // Handle null
  if (value === null) {
    if (options?.nullable) {
      return ok(null as unknown as TOut);
    }
    return fail(`Expected ${typeName}, received null`);
  }

  // Handle array option
  if (options?.array) {
    if (!Array.isArray(value)) {
      return fail(`Expected array of ${typeName}, received ${typeof value}`);
    }
    const results: TSchemaOut[] = [];
    for (let i = 0; i < value.length; i++) {
      const itemResult = baseValidate(value[i]);
      if (itemResult.issues) {
        const issue = itemResult.issues[0]!;
        const newPath: PropertyKey[] = [i, ...(issue.path || [])];
        return fail(issue.message, newPath);
      }
      // Apply schema validation per item if present
      let itemOutput = (itemResult as { value: T })
        .value as unknown as TSchemaOut;
      if (options.schema) {
        const schemaResult = options.schema["~standard"].validate(itemOutput);
        if ("then" in schemaResult) {
          return fail(`Async schemas are not supported`);
        }
        if (schemaResult.issues) {
          const schemaIssue = schemaResult.issues[0]!;
          const path: PropertyKey[] = [
            i,
            ...((schemaIssue.path as PropertyKey[]) || []),
          ];
          return fail(schemaIssue.message as string, path);
        }
        itemOutput = schemaResult.value as TSchemaOut;
      }
      results.push(itemOutput);
    }
    // Apply transform to each item if present
    if (options.transform) {
      const transformed = results.map((item) => options.transform!(item));
      return ok(transformed as unknown as TOut);
    }
    return ok(results as unknown as TOut);
  }

  // Base validation
  const result = baseValidate(value);
  if (result.issues) {
    return result as ValidationResult<TOut>;
  }

  let baseValue = (result as { value: T }).value;
  let schemaOutput: TSchemaOut = baseValue as unknown as TSchemaOut;

  // Apply additional schema validation (T → TSchemaOut)
  if (options?.schema) {
    const schemaResult = options.schema["~standard"].validate(baseValue);
    if ("then" in schemaResult) {
      return fail(`Async schemas are not supported`);
    }
    if (schemaResult.issues) {
      return { issues: schemaResult.issues as readonly ValidationIssue[] };
    }
    schemaOutput = schemaResult.value as TSchemaOut;
  }

  // Apply transform (TSchemaOut → TOut)
  if (options?.transform) {
    return ok(options.transform(schemaOutput) as TOut);
  }

  return ok(schemaOutput as unknown as TOut);
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
  return ok(result.value as T);
}
