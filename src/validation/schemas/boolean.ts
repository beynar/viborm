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
  return createSchema("boolean", (value) =>
    applyOptions(value, validateBoolean, options, "boolean")
  ) as BooleanSchema<ComputeInput<boolean, Opts>, ComputeOutput<boolean, Opts>>;
}

// Export the validate function for reuse
export { validateBoolean };

