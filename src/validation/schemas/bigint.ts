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
  return createSchema("bigint", (value) =>
    applyOptions(value, validateBigInt, options, "bigint")
  ) as BigIntSchema<ComputeInput<bigint, Opts>, ComputeOutput<bigint, Opts>>;
}

// Export the validate function for reuse
export { validateBigInt };

