import { buildSchema, ok } from "../helpers";
import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  VibSchema,
} from "../types";

// =============================================================================
// Boolean Schema
// =============================================================================

export interface BaseBooleanSchema<
  Opts extends ScalarOptions<boolean, any> | undefined = undefined,
> extends VibSchema<
    ComputeInput<boolean, Opts>,
    ComputeOutput<boolean, Opts>
  > {}

export interface BooleanSchema<TInput = boolean, TOutput = boolean>
  extends VibSchema<TInput, TOutput> {
  readonly type: "boolean";
}

// Pre-computed error for fast path
const BOOLEAN_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected boolean" })]),
});

/**
 * Validate that a value is a boolean.
 */
function validateBoolean(value: unknown) {
  return typeof value === "boolean" ? ok(value) : BOOLEAN_ERROR;
}

/**
 * Create a boolean schema.
 *
 * @example
 * const active = v.boolean();
 * const optionalFlag = v.boolean({ optional: true });
 */
export function boolean<
  const Opts extends ScalarOptions<boolean, any> | undefined = undefined,
>(
  options?: Opts
): BooleanSchema<ComputeInput<boolean, Opts>, ComputeOutput<boolean, Opts>> {
  return buildSchema("boolean", validateBoolean, options) as BooleanSchema<
    ComputeInput<boolean, Opts>,
    ComputeOutput<boolean, Opts>
  >;
}

// Export the validate function for reuse
export { validateBoolean };
