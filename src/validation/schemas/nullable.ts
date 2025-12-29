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

/**
 * Conditionally wrap a schema in nullable based on a boolean flag.
 * Useful for building schemas dynamically where nullability is determined at compile time.
 *
 * @example
 * const schema = v.maybeNullable(v.string(), true);  // NullableSchema<StringSchema>
 * const schema2 = v.maybeNullable(v.string(), false); // StringSchema
 */
export function maybeNullable<
  TWrapped extends VibSchema<any, any>,
  TIsNullable extends boolean
>(
  wrapped: TWrapped,
  isNullable: TIsNullable
): TIsNullable extends true ? NullableSchema<TWrapped> : TWrapped {
  if (isNullable) {
    return nullable(wrapped) as TIsNullable extends true
      ? NullableSchema<TWrapped>
      : TWrapped;
  }
  return wrapped as TIsNullable extends true
    ? NullableSchema<TWrapped>
    : TWrapped;
}
