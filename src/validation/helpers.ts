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
  if (options?.default === undefined) return undefined;
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

  // Handle array option - single pass optimization
  if (options?.array) {
    if (!Array.isArray(value)) {
      return fail(`Expected array of ${typeName}, received ${typeof value}`);
    }
    
    const len = value.length;
    const hasSchema = options.schema !== undefined;
    const hasTransform = options.transform !== undefined;
    const schemaValidate = hasSchema ? options.schema!["~standard"].validate : null;
    const transformFn = hasTransform ? options.transform! : null;
    
    // Pre-allocate result array (avoids push overhead)
    const results = new Array<TOut>(len);
    
    for (let i = 0; i < len; i++) {
      const item = value[i];
      
      // Base validation
      const itemResult = baseValidate(item);
      if (itemResult.issues) {
        const issue = itemResult.issues[0]!;
        // Use concat instead of spread for better performance
        return fail(
          issue.message,
          issue.path ? ([i] as PropertyKey[]).concat(issue.path) : [i]
        );
      }
      
      let output = (itemResult as { value: T }).value;
      
      // Schema validation (if present)
      if (schemaValidate) {
        const schemaResult = schemaValidate(output);
        if ("then" in schemaResult) {
          return fail("Async schemas are not supported", [i]);
        }
        if (schemaResult.issues) {
          const issue = schemaResult.issues[0]!;
          // Use concat instead of spread for better performance
          return fail(
            issue.message as string,
            issue.path
              ? ([i] as PropertyKey[]).concat(issue.path as PropertyKey[])
              : [i]
          );
        }
        output = (schemaResult as unknown as { value: T }).value;
      }
      
      // Transform + assign in single step (avoids second array allocation)
      results[i] = (transformFn ? transformFn(output as unknown as TSchemaOut) : output) as TOut;
    }
    
    return ok(results as unknown as TOut);
  }

  // Base validation
  const result = baseValidate(value);
  if (result.issues) {
    return result as ValidationResult<TOut>;
  }

  let output = (result as { value: T }).value;

  // Apply additional schema validation (T → TSchemaOut)
  // Hoist check outside to avoid repeated property access
  const schemaValidate = options?.schema?.["~standard"].validate;
  if (schemaValidate) {
    const schemaResult = schemaValidate(output);
    if ("then" in schemaResult) {
      return fail("Async schemas are not supported");
    }
    if (schemaResult.issues) {
      return { issues: schemaResult.issues as readonly ValidationIssue[] };
    }
    output = (schemaResult as unknown as { value: T }).value;
  }

  // Apply transform (TSchemaOut → TOut) - single return path
  return ok(
    (options?.transform 
      ? options.transform(output as unknown as TSchemaOut) 
      : output) as TOut
  );
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
  return ok((result as { value: T }).value);
}
