import { inferred } from "../inferred";
import type { VibSchema, ScalarOptions, ComputeInput, ComputeOutput } from "../types";
import { applyOptions, fail, ok, createSchema } from "../helpers";

// =============================================================================
// BigInt Schema
// =============================================================================

export interface BigIntSchema<TInput = bigint, TOutput = bigint>
  extends VibSchema<TInput, TOutput> {
  readonly type: "bigint";
}

// Pre-computed error for fast path
const BIGINT_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected bigint" })]),
});

/**
 * Validate that a value is a bigint.
 */
function validateBigInt(value: unknown) {
  if (typeof value !== "bigint") {
    return fail(`Expected bigint, received ${typeof value}`);
  }
  return ok(value);
}

/**
 * Create a bigint schema.
 * 
 * @example
 * const id = v.bigint();
 * const optionalId = v.bigint({ optional: true });
 */
export function bigint<
  const Opts extends ScalarOptions<bigint, any> | undefined = undefined
>(
  options?: Opts
): BigIntSchema<ComputeInput<bigint, Opts>, ComputeOutput<bigint, Opts>> {
  // Fast path: no options = inline validation
  if (options === undefined) {
    return {
      type: "bigint",
      "~standard": {
        version: 1 as const,
        vendor: "viborm" as const,
        validate(value: unknown) {
          return typeof value === "bigint" ? { value } : BIGINT_ERROR;
        },
      },
    } as BigIntSchema<ComputeInput<bigint, Opts>, ComputeOutput<bigint, Opts>>;
  }

  // Slow path: has options
  return createSchema("bigint", (value) =>
    applyOptions(value, validateBigInt, options, "bigint")
  ) as BigIntSchema<ComputeInput<bigint, Opts>, ComputeOutput<bigint, Opts>>;
}

// Export the validate function for reuse
export { validateBigInt };


