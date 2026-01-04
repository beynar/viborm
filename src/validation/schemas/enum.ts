import { buildSchema, ok } from "../helpers";
import type {
  ComputeInput,
  ComputeOutput,
  InferInput,
  ScalarOptions,
  VibSchema,
} from "../types";

// =============================================================================
// Enum Schema
// =============================================================================
export type EnumValues<S extends VibSchema> =
  S extends EnumSchema<infer TValues, any, any> ? TValues : never;
export type AnyEnumSchema = EnumSchema<string[], any, any>;
export type BaseEnumSchema<
  TValues extends string[],
  Opts extends ScalarOptions<TValues[number], any> | undefined = undefined,
> = EnumSchema<
  TValues,
  ComputeInput<TValues[number], Opts>,
  ComputeOutput<TValues[number], Opts>
>;

export interface EnumSchema<
  TValues extends string[],
  TInput = TValues[number],
  TOutput = TValues[number],
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
  const TValues extends string[],
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
    if (typeof value === "string" && valueSet.has(value)) {
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

const test = enum_(["a", "b", "c"]);
type In = InferInput<typeof test>;
