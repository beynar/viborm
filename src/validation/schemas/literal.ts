import { inferred } from "../inferred";
import type { VibSchema, ScalarOptions, ComputeInput, ComputeOutput } from "../types";
import { applyOptions, fail, ok, createSchema } from "../helpers";

// =============================================================================
// Literal Schema
// =============================================================================

export type LiteralValue = string | number | boolean | null | undefined | bigint;

export interface LiteralSchema<T extends LiteralValue, TInput = T, TOutput = T>
  extends VibSchema<TInput, TOutput> {
  readonly type: "literal";
  readonly value: T;
}

/**
 * Create a literal value validator.
 */
function createLiteralValidator<T extends LiteralValue>(expected: T) {
  return (value: unknown) => {
    if (value !== expected) {
      const expectedStr = expected === null ? "null" : String(expected);
      const receivedStr = value === null ? "null" : String(value);
      return fail(`Expected ${expectedStr}, received ${receivedStr}`);
    }
    return ok(value as T);
  };
}

/**
 * Create a literal schema that matches an exact value.
 * 
 * @example
 * const admin = v.literal("admin");
 * const zero = v.literal(0);
 * const isTrue = v.literal(true);
 */
export function literal<
  const T extends LiteralValue,
  const Opts extends ScalarOptions<T, any> | undefined = undefined
>(
  value: T,
  options?: Opts
): LiteralSchema<T, ComputeInput<T, Opts>, ComputeOutput<T, Opts>> {
  const validate = createLiteralValidator(value);
  const schema = createSchema("literal", (v) =>
    applyOptions(v, validate, options, String(value))
  ) as LiteralSchema<T, ComputeInput<T, Opts>, ComputeOutput<T, Opts>>;
  
  // Add the literal value to the schema
  (schema as any).value = value;
  
  return schema;
}

