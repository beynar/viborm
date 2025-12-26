import type {
  VibSchema,
  ScalarOptions,
  ComputeInput,
  ComputeOutput,
} from "../types";
import { buildSchema, ok } from "../helpers";

// =============================================================================
// Literal Schema
// =============================================================================

export type LiteralValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | bigint;

export interface LiteralSchema<T extends LiteralValue, TInput = T, TOutput = T>
  extends VibSchema<TInput, TOutput> {
  readonly type: "literal";
  readonly value: T;
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
  expected: T,
  options?: Opts
): LiteralSchema<T, ComputeInput<T, Opts>, ComputeOutput<T, Opts>> {
  // Pre-compute error for fast path
  const expectedStr = expected === null ? "null" : String(expected);
  const errorResult = Object.freeze({
    issues: Object.freeze([
      Object.freeze({
        message: `Expected literal: ${expectedStr}`,
      }),
    ]),
  });

  // Create base validator
  const baseValidate = (value: unknown) =>
    value === expected ? ok(value as T) : errorResult;

  return buildSchema("literal", baseValidate, options, {
    value: expected,
  }) as LiteralSchema<T, ComputeInput<T, Opts>, ComputeOutput<T, Opts>>;
}
