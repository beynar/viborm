import { createSchema, fail, ok, validateSchema } from "../helpers";
import type {
  InferInput,
  InferOutput,
  ValidationResult,
  VibSchema,
} from "../types";

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
export function coerce<S extends VibSchema<any, any>, TOut>(
  schema: S,
  fn: (value: S[" vibInferred"]["1"]) => TOut
): TransformSchema<InferInput<S>, TOut> & { wrapped: S } {
  const transformSchema = createSchema<InferInput<S>, TOut>(
    "transform",
    (value): ValidationResult<TOut> => {
      const result = validateSchema(schema, value);
      if (result.issues) {
        return fail(result.issues[0]?.message ?? "Validation failed");
      }
      try {
        return ok(fn((result as { value: InferOutput<S> }).value));
      } catch (e) {
        return fail(
          `Transform failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  ) as TransformSchema<InferInput<S>, TOut> & { wrapped: S };

  (transformSchema as any).wrapped = schema;

  return transformSchema;
}

/**
 * Alias for coerce - transform wrapper.
 */
export const map = coerce;
