import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  VibSchema,
} from "../types";
import { isDate } from "../value-guards";
import { buildSchema, ok } from "./helpers";

// =============================================================================
// Date Schema (JavaScript Date objects)
// =============================================================================

export interface BaseDateSchema<
  Opts extends ScalarOptions<Date, any> | undefined = undefined,
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
  if (!isDate(value)) return NOT_DATE_ERROR;
  const time = value.getTime();
  if (Number.isNaN(time)) return INVALID_DATE_ERROR;
  if (value instanceof Date) return ok(value);
  // A Date from another realm names this exact instant but fails every local
  // `instanceof` downstream; a local Date at the same instant does not.
  return ok(new Date(time));
}

/**
 * Create a date schema for JavaScript Date objects.
 *
 * @example
 * const createdAt = v.date();
 * const optionalDate = v.date({ optional: true });
 */
export function date<
  const Opts extends ScalarOptions<Date, any> | undefined = undefined,
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
