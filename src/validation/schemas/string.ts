import { inferred } from "../inferred";
import type { VibSchema, ScalarOptions, ComputeInput, ComputeOutput } from "../types";
import { applyOptions, fail, ok, createSchema } from "../helpers";

// =============================================================================
// String Schema
// =============================================================================

export interface StringSchema<TInput = string, TOutput = string>
  extends VibSchema<TInput, TOutput> {
  readonly type: "string";
}

// Pre-computed error for fast path (avoid allocation on error)
const STRING_ERROR = Object.freeze({ 
  issues: Object.freeze([Object.freeze({ message: "Expected string" })]) 
});

/**
 * Validate that a value is a string.
 */
function validateString(value: unknown) {
  if (typeof value !== "string") {
    return fail(`Expected string, received ${typeof value}`);
  }
  return ok(value);
}

/**
 * Create a string schema.
 * 
 * @example
 * const name = v.string();
 * const optionalName = v.string({ optional: true });
 * const tags = v.string({ array: true });
 */
export function string<
  const Opts extends ScalarOptions<string, any> | undefined = undefined
>(
  options?: Opts
): StringSchema<ComputeInput<string, Opts>, ComputeOutput<string, Opts>> {
  // Fast path: no options = inline validation (avoids function call overhead)
  if (options === undefined) {
    return {
      type: "string",
      "~standard": {
        version: 1 as const,
        vendor: "viborm" as const,
        validate(value: unknown) {
          return typeof value === "string" 
            ? { value } 
            : STRING_ERROR;
        },
      },
    } as StringSchema<ComputeInput<string, Opts>, ComputeOutput<string, Opts>>;
  }
  
  // Slow path: has options, use full applyOptions
  return createSchema("string", (value) =>
    applyOptions(value, validateString, options, "string")
  ) as StringSchema<ComputeInput<string, Opts>, ComputeOutput<string, Opts>>;
}

// Export the validate function for reuse
export { validateString };


