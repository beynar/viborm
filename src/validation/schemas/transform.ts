import type { StandardSchemaV1 } from "@standard-schema/spec";
import { inferred } from "../inferred";
import type { VibSchema, ValidationResult } from "../types";
import { createSchema, fail, ok } from "../helpers";

// =============================================================================
// Transform Schema Wrapper
// =============================================================================

/**
 * Schema that wraps another schema and transforms its output.
 */
export interface TransformSchema<TInput, TOutput>
  extends VibSchema<TInput, TOutput> {
  readonly type: "transform";
}

/**
 * Wrap a schema with a transform function.
 * Validates with the wrapped schema, then applies the transform to the output.
 *
 * @param schema - The base schema to validate with
 * @param fn - Transform function: (validatedValue) => newValue
 *
 * @example
 * // String to uppercase
 * const upper = v.coerce(v.string(), s => s.toUpperCase());
 *
 * @example
 * // Parse string to number
 * const parseNum = v.coerce(v.string(), s => parseInt(s, 10));
 * type Out = InferOutput<typeof parseNum>; // number
 *
 * @example
 * // Date to ISO string
 * const isoDate = v.coerce(v.date(), d => d.toISOString());
 * type Out = InferOutput<typeof isoDate>; // string
 *
 * @example
 * // Extract property from object
 * const getName = v.coerce(
 *   v.object({ name: v.string(), age: v.number() }),
 *   obj => obj.name
 * );
 * type Out = InferOutput<typeof getName>; // string
 */
export function coerce<I, O, TOut>(
  schema: StandardSchemaV1<I, O>,
  fn: (value: O) => TOut
): TransformSchema<I, TOut> {
  return createSchema("transform", (value): ValidationResult<TOut> => {
    const result = schema["~standard"].validate(value);
    if ("then" in result) {
      return fail("Async schemas are not supported");
    }
    if (result.issues) {
      const issue = result.issues[0];
      return fail(issue?.message ?? "Validation failed");
    }
    try {
      const output = (result as { value: O }).value;
      return ok(fn(output));
    } catch (e) {
      return fail(`Transform failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }) as TransformSchema<I, TOut>;
}

/**
 * Alias for coerce - transform wrapper.
 */
export const map = coerce;

