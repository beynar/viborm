import type {
  VibSchema,
  ScalarOptions,
  ComputeInput,
  ComputeOutput,
} from "../types";
import { buildSchema, ok } from "../helpers";

// =============================================================================
// String Schema
// =============================================================================
export interface BaseStringSchema<
  Opts extends ScalarOptions<string, any> | undefined = undefined
> extends VibSchema<ComputeInput<string, Opts>, ComputeOutput<string, Opts>> {}

export interface StringSchema<TInput = string, TOutput = string>
  extends VibSchema<TInput, TOutput> {
  readonly type: "string";
}

// Pre-computed error for fast path (avoid allocation on error)
const STRING_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected string" })]),
});

/**
 * Validate that a value is a string.
 */
function validateString(value: unknown) {
  return typeof value === "string" ? ok(value) : STRING_ERROR;
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
  return buildSchema("string", validateString, options) as StringSchema<
    ComputeInput<string, Opts>,
    ComputeOutput<string, Opts>
  >;
}

// Export the validate function for reuse
export { validateString };
