import type {
  VibSchema,
  ScalarOptions,
  ComputeInput,
  ComputeOutput,
} from "../types";
import { buildSchema, ok } from "../helpers";

// =============================================================================
// Date Schema (JavaScript Date objects)
// =============================================================================

export interface BaseDateSchema<
  Opts extends ScalarOptions<Date, any> | undefined = undefined
> extends VibSchema<ComputeInput<Date, Opts>, ComputeOutput<Date, Opts>> {}

export interface DateSchema<TInput = Date, TOutput = Date>
  extends VibSchema<TInput, TOutput> {
  readonly type: "date";
}

// Pre-computed errors for fast path
const NOT_DATE_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected Date" })]),
});
const INVALID_DATE_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected valid Date" })]),
});

/**
 * Validate that a value is a JavaScript Date object.
 */
function validateDate(value: unknown) {
  if (!(value instanceof Date)) return NOT_DATE_ERROR;
  if (Number.isNaN(value.getTime())) return INVALID_DATE_ERROR;
  return ok(value);
}

/**
 * Create a date schema for JavaScript Date objects.
 *
 * @example
 * const createdAt = v.date();
 * const optionalDate = v.date({ optional: true });
 */
export function date<
  const Opts extends ScalarOptions<Date, any> | undefined = undefined
>(
  options?: Opts
): DateSchema<ComputeInput<Date, Opts>, ComputeOutput<Date, Opts>> {
  return buildSchema("date", validateDate, options) as DateSchema<
    ComputeInput<Date, Opts>,
    ComputeOutput<Date, Opts>
  >;
}

// Export the validate function for reuse
export { validateDate };
