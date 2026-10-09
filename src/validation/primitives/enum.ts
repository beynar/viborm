import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  VibSchema,
} from "../types";
import { isString } from "../value-guards";
import { buildSchema, ok } from "./helpers";

// =============================================================================
// Enum Schema
// =============================================================================
export type EnumValues<S extends VibSchema> =
  S extends EnumSchema<infer TValues, any, any> ? TValues : never;
export type AnyEnumSchema = EnumSchema<readonly string[], any, any>;
export type BaseEnumSchema<
  TValues extends readonly string[],
  Opts extends ScalarOptions<TValues[number], any> | undefined = undefined,
> = EnumSchema<
  TValues,
  ComputeInput<TValues[number], Opts>,
  ComputeOutput<TValues[number], Opts>
>;

export interface EnumSchema<
  TValues extends readonly string[],
  TInput = TValues[number],
  TOutput = TValues[number],
> extends VibSchema<TInput, TOutput> {
  readonly type: "enum";
  readonly values: TValues;
}

/**
 * Create an enum schema that validates a value is one of the allowed strings.
 *
 * The values may be a readonly tuple (`["a", "b"] as const`). The mutable arm
 * of the constraint keeps an inline literal inferred as a mutable tuple, so
 * the types of existing schemas do not change.
 *
 * @example
 * const status = v.enum_(["active", "inactive", "pending"]);
 */
// @__NO_SIDE_EFFECTS__
export function enum_<
  const TValues extends string[] | readonly string[],
  const Opts extends
    | ScalarOptions<TValues[number], any>
    | undefined = undefined,
>(
  values: TValues,
  options?: Opts
): EnumSchema<
  TValues,
  ComputeInput<TValues[number], Opts>,
  ComputeOutput<TValues[number], Opts>
> {
  // Create a Set for O(1) lookup
  const valueSet = new Set<TValues[number]>(values);

  // Create base validator
  const baseValidate = (value: unknown) => {
    if (isString(value) && valueSet.has(value)) {
      return ok(value as TValues[number]);
    }
    return {
      issues: [
        {
          message: `Expected one of: ${values.join(" | ")}`,
        },
      ],
    };
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
