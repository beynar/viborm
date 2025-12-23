import { inferred } from "../inferred";
import type { VibSchema, ScalarOptions, ComputeInput, ComputeOutput } from "../types";
import { applyOptions, fail, ok, createSchema } from "../helpers";

// =============================================================================
// Number Schema
// =============================================================================

export interface NumberSchema<TInput = number, TOutput = number>
  extends VibSchema<TInput, TOutput> {
  readonly type: "number";
}

/**
 * Validate that a value is a number (and not NaN).
 */
function validateNumber(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fail(`Expected number, received ${typeof value}`);
  }
  return ok(value);
}

/**
 * Create a number schema.
 * 
 * @example
 * const age = v.number();
 * const optionalAge = v.number({ optional: true });
 * const scores = v.number({ array: true });
 */
export function number<
  const Opts extends ScalarOptions<number, any> | undefined = undefined
>(
  options?: Opts
): NumberSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>> {
  return createSchema("number", (value) =>
    applyOptions(value, validateNumber, options, "number")
  ) as NumberSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>>;
}

// =============================================================================
// Integer Schema (number with integer constraint)
// =============================================================================

export interface IntegerSchema<TInput = number, TOutput = number>
  extends VibSchema<TInput, TOutput> {
  readonly type: "integer";
}

/**
 * Validate that a value is an integer.
 */
function validateInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fail(`Expected integer, received ${typeof value}`);
  }
  return ok(value);
}

/**
 * Create an integer schema.
 * 
 * @example
 * const count = v.integer();
 */
export function integer<
  const Opts extends ScalarOptions<number, any> | undefined = undefined
>(
  options?: Opts
): IntegerSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>> {
  return createSchema("integer", (value) =>
    applyOptions(value, validateInteger, options, "integer")
  ) as IntegerSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>>;
}

// Export validate functions for reuse
export { validateNumber, validateInteger };

