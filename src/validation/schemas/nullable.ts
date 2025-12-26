import type {
  VibSchema,
  InferInput,
  InferOutput,
  ValidationResult,
} from "../types";
import { ok, createSchema } from "../helpers";

// =============================================================================
// Nullable Schema
// =============================================================================

export interface NullableSchema<
  TWrapped extends VibSchema<any, any>,
  TInput = InferInput<TWrapped> | null,
  TOutput = InferOutput<TWrapped> | null
> extends VibSchema<TInput, TOutput> {
  readonly type: "nullable";
  readonly wrapped: TWrapped;
}

/**
 * Create a nullable schema that allows null values.
 *
 * @example
 * const nullableName = v.nullable(v.string());
 */
export function nullable<TWrapped extends VibSchema<any, any>>(
  wrapped: TWrapped
): NullableSchema<TWrapped> {
  // Cache validate function directly
  const validate = wrapped["~standard"].validate;

  const schema = createSchema(
    "nullable",
    (value): ValidationResult<InferOutput<TWrapped> | null> => {
      // Handle null - fast path
      if (value === null) {
        return ok(null);
      }

      // Delegate to wrapped schema (cast to our result type)
      return validate(value) as ValidationResult<InferOutput<TWrapped>>;
    }
  ) as NullableSchema<TWrapped>;

  // Add reference
  (schema as any).wrapped = wrapped;

  return schema;
}
