import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createSchema, fail, ok } from "../helpers";
import type { ValidationResult, VibSchema } from "../types";

// =============================================================================
// NonNullable Schema
// =============================================================================

/**
 * Schema that wraps another schema and excludes null from both input and output.
 * Rejects null values at validation time.
 */
export interface NonNullableSchema<TInput, TOutput>
  extends VibSchema<TInput, TOutput> {
  readonly type: "nonNullable";
}

/**
 * Wrap a schema to exclude null from both input and output types.
 * Fails validation if the value is null.
 *
 * @example
 * const maybeNull = v.string({ nullable: true });
 * const definitelyString = v.nonNullable(maybeNull);
 * // Input: string, Output: string (null excluded from both)
 *
 * @example
 * // Works with any StandardSchemaV1
 * const externalSchema: StandardSchemaV1<unknown, string | null> = ...;
 * const strict = v.nonNullable(externalSchema);
 */
export function nonNullable<I, O>(
  schema: StandardSchemaV1<I, O | null> | StandardSchemaV1<I, O>
): NonNullableSchema<NonNullable<I>, NonNullable<O>> {
  return createSchema(
    "nonNullable",
    (value): ValidationResult<NonNullable<O>> => {
      // Reject null at input
      if (value === null) {
        return fail("Expected non-null value, received null");
      }
      const result = schema["~standard"].validate(value);
      if ("then" in result) {
        return fail("Async schemas are not supported");
      }
      if (result.issues) {
        const issue = result.issues[0];
        return fail(issue?.message ?? "Validation failed");
      }
      const output = (result as { value: O | null }).value;
      // Also reject null output (in case wrapped schema produces null)
      if (output === null) {
        return fail("Expected non-null value, received null");
      }
      return ok(output as NonNullable<O>);
    }
  ) as NonNullableSchema<NonNullable<I>, NonNullable<O>>;
}
