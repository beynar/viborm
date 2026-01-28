import { buildSchema, ok } from "../helpers";
import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  VibSchema,
} from "../types";

// =============================================================================
// BigInt Schema
// =============================================================================

export interface BaseBigIntSchema<
  Opts extends ScalarOptions<bigint, any> | undefined = undefined,
> extends VibSchema<ComputeInput<bigint, Opts>, ComputeOutput<bigint, Opts>> {}

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
  return typeof value === "bigint" ? ok(value) : BIGINT_ERROR;
}

/**
 * Create a bigint schema.
 *
 * @example
 * const id = v.bigint();
 * const optionalId = v.bigint({ optional: true });
 */
export function bigint<
  const Opts extends ScalarOptions<bigint, any> | undefined = undefined,
>(
  options?: Opts
): BigIntSchema<ComputeInput<bigint, Opts>, ComputeOutput<bigint, Opts>> {
  return buildSchema("bigint", validateBigInt, options) as BigIntSchema<
    ComputeInput<bigint, Opts>,
    ComputeOutput<bigint, Opts>
  >;
}

// Export the validate function for reuse
export { validateBigInt };
