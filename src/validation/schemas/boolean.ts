import { inferred } from "../inferred";
import type { VibSchema, ScalarOptions, ComputeInput, ComputeOutput } from "../types";
import { applyOptions, fail, ok, createSchema } from "../helpers";

// =============================================================================
// Boolean Schema
// =============================================================================

export interface BooleanSchema<TInput = boolean, TOutput = boolean>
  extends VibSchema<TInput, TOutput> {
  readonly type: "boolean";
}

// Pre-computed error for fast path
const BOOLEAN_ERROR = Object.freeze({ 
  issues: Object.freeze([Object.freeze({ message: "Expected boolean" })]) 
});

/**
 * Validate that a value is a boolean.
 */
function validateBoolean(value: unknown) {
  if (typeof value !== "boolean") {
    return fail(`Expected boolean, received ${typeof value}`);
  }
  return ok(value);
}

/**
 * Create a boolean schema.
 * 
 * @example
 * const active = v.boolean();
 * const optionalFlag = v.boolean({ optional: true });
 */
export function boolean<
  const Opts extends ScalarOptions<boolean, any> | undefined = undefined
>(
  options?: Opts
): BooleanSchema<ComputeInput<boolean, Opts>, ComputeOutput<boolean, Opts>> {
  // Fast path: no options = inline validation
  if (options === undefined) {
    return {
      type: "boolean",
      "~standard": {
        version: 1 as const,
        vendor: "viborm" as const,
        validate(value: unknown) {
          return typeof value === "boolean"
            ? { value }
            : BOOLEAN_ERROR;
        },
      },
    } as BooleanSchema<ComputeInput<boolean, Opts>, ComputeOutput<boolean, Opts>>;
  }
  
  // Slow path: has options
  return createSchema("boolean", (value) =>
    applyOptions(value, validateBoolean, options, "boolean")
  ) as BooleanSchema<ComputeInput<boolean, Opts>, ComputeOutput<boolean, Opts>>;
}

// Export the validate function for reuse
export { validateBoolean };


