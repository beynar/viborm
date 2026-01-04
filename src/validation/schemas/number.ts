import { buildSchema, ok } from "../helpers";
import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  VibSchema,
} from "../types";

// =============================================================================
// Number Schema
// =============================================================================

export interface BaseNumberSchema<
  Opts extends ScalarOptions<number, any> | undefined = undefined,
> extends VibSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>> {}

export interface NumberSchema<TInput = number, TOutput = number>
  extends VibSchema<TInput, TOutput> {
  readonly type: "number";
}

// Pre-computed error for fast path
const NUMBER_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected finite number" })]),
});

/**
 * Validate that a value is a finite number (rejects NaN and Infinity).
 */
function validateNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? ok(value)
    : NUMBER_ERROR;
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
  const Opts extends ScalarOptions<number, any> | undefined = undefined,
>(
  options?: Opts
): NumberSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>> {
  return buildSchema("number", validateNumber, options) as NumberSchema<
    ComputeInput<number, Opts>,
    ComputeOutput<number, Opts>
  >;
}

// =============================================================================
// Integer Schema (number with integer constraint)
// =============================================================================

export interface BaseIntegerSchema<
  Opts extends ScalarOptions<number, any> | undefined = undefined,
> extends VibSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>> {}

export interface IntegerSchema<TInput = number, TOutput = number>
  extends VibSchema<TInput, TOutput> {
  readonly type: "integer";
}

// Pre-computed error for fast path
const INTEGER_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected integer" })]),
});

/**
 * Validate that a value is an integer.
 */
function validateInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value)
    ? ok(value)
    : INTEGER_ERROR;
}

/**
 * Create an integer schema.
 *
 * @example
 * const count = v.integer();
 */
export function integer<
  const Opts extends ScalarOptions<number, any> | undefined = undefined,
>(
  options?: Opts
): IntegerSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>> {
  return buildSchema("integer", validateInteger, options) as IntegerSchema<
    ComputeInput<number, Opts>,
    ComputeOutput<number, Opts>
  >;
}

// Export validate functions for reuse
export { validateNumber, validateInteger };
