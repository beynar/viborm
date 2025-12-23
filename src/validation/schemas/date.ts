import { inferred } from "../inferred";
import type { VibSchema, ScalarOptions, ComputeInput, ComputeOutput } from "../types";
import { applyOptions, fail, ok, createSchema } from "../helpers";

// =============================================================================
// Date Schema (JavaScript Date objects)
// =============================================================================

export interface DateSchema<TInput = Date, TOutput = Date>
  extends VibSchema<TInput, TOutput> {
  readonly type: "date";
}

/**
 * Validate that a value is a JavaScript Date object.
 */
function validateDate(value: unknown) {
  if (!(value instanceof Date)) {
    return fail(`Expected Date, received ${typeof value}`);
  }
  if (Number.isNaN(value.getTime())) {
    return fail(`Expected valid Date, received Invalid Date`);
  }
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
  return createSchema("date", (value) =>
    applyOptions(value, validateDate, options, "Date")
  ) as DateSchema<ComputeInput<Date, Opts>, ComputeOutput<Date, Opts>>;
}

// Export the validate function for reuse
export { validateDate };

