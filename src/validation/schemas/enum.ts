import type {
  VibSchema,
  ScalarOptions,
  ComputeInput,
  ComputeOutput,
} from "../types";
import { buildSchema, ok, fail } from "../helpers";

// =============================================================================
// Enum Schema
// =============================================================================

export interface EnumSchema<
  TValues extends readonly (string | number)[],
  TInput = TValues[number],
  TOutput = TValues[number]
> extends VibSchema<TInput, TOutput> {
  readonly type: "enum";
  readonly values: TValues;
}

/**
 * Create an enum schema that validates a value is one of the allowed values.
 *
 * @param values - Array of allowed values (strings or numbers)
 * @param options - Schema options
 *
 * @example
 * const status = v.enum_(["active", "inactive", "pending"]);
 * const level = v.enum_([1, 2, 3]);
 * const mixed = v.enum_(["a", 1, "b", 2]);
 */
// @__NO_SIDE_EFFECTS__
export function enum_<
  const TValues extends readonly (string | number)[],
  const Opts extends ScalarOptions<TValues[number], any> | undefined = undefined
>(
  values: TValues,
  options?: Opts
): EnumSchema<
  TValues,
  ComputeInput<TValues[number], Opts>,
  ComputeOutput<TValues[number], Opts>
> {
  // Create a Set for O(1) lookup
  const valueSet = new Set<string | number>(values);

  // Pre-compute error message
  const expectedStr = values.map((v) => JSON.stringify(v)).join(" | ");
  const errorResult = Object.freeze({
    issues: Object.freeze([
      Object.freeze({
        message: `Expected one of: ${expectedStr}`,
      }),
    ]),
  });

  // Create base validator
  const baseValidate = (value: unknown) => {
    if (
      (typeof value === "string" || typeof value === "number") &&
      valueSet.has(value)
    ) {
      return ok(value as TValues[number]);
    }
    return errorResult;
  };

  const schema = buildSchema("enum", baseValidate, options, {
    values,
  }) as EnumSchema<
    TValues,
    ComputeInput<TValues[number], Opts>,
    ComputeOutput<TValues[number], Opts>
  >;

  return schema;
}
