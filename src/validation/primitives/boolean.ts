import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  VibSchema,
} from "../types";
import { isBoolean } from "../value-guards";
import { buildSchema, ok } from "./helpers";

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
  return isBoolean(value) ? ok(value) : BOOLEAN_ERROR;
}

/**
 * Create a boolean schema.
 *
 * @example
 * const active = v.boolean();
 * const optionalFlag = v.boolean({ optional: true });
 */
export function boolean(): BooleanSchema<boolean, boolean>;
export function boolean<const Opts extends ScalarOptions<boolean, any>>(
  options: Opts
): BooleanSchema<ComputeInput<boolean, Opts>, ComputeOutput<boolean, Opts>>;
export function boolean<
  const Opts extends ScalarOptions<boolean, any> | undefined,
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
